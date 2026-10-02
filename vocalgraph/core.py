"""Decode, find silence, pick the threshold, write the trimmed file.

The threshold is chosen per recording, because a fixed one only suits one mic
chain: -40 dB clips quiet phrase endings on a gated mic whose background sits
near -96 dB, yet is too low for a recording with an audible room.

  1. Measure the loudness of every 50 ms of the recording. It splits into two
     clusters, background and voice; Otsu's method separates them, giving the
     background level and the voice level.
  2. A sound is audible if it is clearly above the background (+6 dB) AND
     loud enough to hear next to the voice (within 30 dB of it). Both levels
     come from the recording; the two margins are fixed perceptual limits.
  3. Try every threshold from -25 dB down in 1 dB steps and take the highest
     (most aggressive) one that cuts no audible sound. Cheap: the audio is
     decoded once, and silence detection is a numpy pass over 10 ms RMS.

No speech model is involved. One was tried as the reference (Silero VAD) and
missed ~12% of the quiet speech that pyannote found, so it chose a threshold
that clips words. Checked against pyannote on a 48-minute gated-mic recording
and a copy with pink noise mixed in, this cuts no audible speech from either.
"""
from __future__ import annotations

import json
import re
import os
import subprocess
import tempfile
from dataclasses import dataclass, field

import numpy as np

RATE = 16000        # analysis sample rate; the output is cut from the original
WIN = 0.05          # seconds per loudness window
BATCH = 100         # segments per ffmpeg filter graph (keeps the command line short)


def ffmpeg() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    # CREATE_NO_WINDOW stops a console flashing up on Windows.
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.run(cmd, capture_output=True, creationflags=flags)


def decode(path: str, duration: float | None = None, stream: int = 0) -> np.ndarray:
    """An audio stream (the first, unless `stream` says) as 16 kHz mono
    float32 (only the first `duration` seconds, if given).

    -rematrix_maxval 1 makes the downmix average the channels. Without it, a
    float output gets each channel at 0.707 and summed: a recording with the
    same signal in both channels comes out 3 dB louder than either (and past
    full scale), which shifted every loudness reading 25% against the voice app,
    whose 16-bit decode normalises the mix by default.
    """
    limit = ["-t", f"{duration:.3f}"] if duration else []
    res = _run([ffmpeg(), "-v", "error", "-i", path, "-map", f"0:a:{stream}", *limit,
                "-ac", "1", "-rematrix_maxval", "1", "-ar", str(RATE), "-f", "f32le", "-"])
    if res.returncode != 0 or not res.stdout:
        raise ValueError("Could not read audio from this file. "
                         + res.stderr.decode(errors="replace").strip()[-300:])
    return np.frombuffer(res.stdout, dtype=np.float32)


def window_db(x: np.ndarray) -> np.ndarray:
    """Loudness (dBFS, RMS) of each WIN-second window."""
    n = int(WIN * RATE)
    usable = (x.size // n) * n
    frames = x[:usable].reshape(-1, n).astype(np.float64)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    return 20 * np.log10(np.maximum(rms, 1e-10))


def otsu(values: np.ndarray, bins: int = 256) -> float:
    """Otsu's threshold: the cut that best separates two clusters of values."""
    hist, edges = np.histogram(values, bins=bins)
    mids = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(hist)
    w1 = w0[-1] - w0
    s0 = np.cumsum(hist * mids)
    m0 = s0 / np.maximum(w0, 1)
    m1 = (s0[-1] - s0) / np.maximum(w1, 1)
    return float(mids[int(np.argmax(w0 * w1 * (m0 - m1) ** 2))])


ABOVE_BACKGROUND = 6.0   # dB: clearly distinguishable from the background
BELOW_VOICE = 30.0       # dB: loud enough to hear next to the voice


def audible_level(floor: float, voice: float) -> float:
    """Loudness above which a sound counts as audible, and must not be cut.

    Both conditions must hold. Above the background alone is not enough: a
    gated mic's background is near digital silence, and breaths 25 dB above it
    are still inaudible. Near the voice alone is not enough either: in a noisy
    room a quiet word 12 dB above the noise is plainly audible yet far below
    the midpoint between noise and voice.
    """
    return max(floor + ABOVE_BACKGROUND, voice - BELOW_VOICE)


HOP = 0.01  # seconds per silence-detection window


def hop_db(x: np.ndarray) -> np.ndarray:
    """RMS loudness of each HOP-second window, for silence detection."""
    n = int(HOP * RATE)
    usable = (x.size // n) * n
    frames = x[:usable].reshape(-1, n).astype(np.float64)
    return 20 * np.log10(np.maximum(np.sqrt(np.mean(frames * frames, axis=1)), 1e-10))


def silences(levels: np.ndarray, threshold_db: float, min_silence: float) -> list[tuple[float, float]]:
    """Runs of HOP windows quieter than the threshold lasting at least min_silence.

    Measured on short-window RMS rather than per sample, as ffmpeg's
    silencedetect does. Per-sample peaks of steady noise sit ~12 dB above its
    average, so a peak test cannot find the silence in a noisy room until the
    threshold is high enough to cut quiet words too. RMS also matches how
    audibility is judged, so both use the same scale.
    """
    quiet = levels < threshold_db
    edges = np.diff(np.concatenate(([0], quiet.view(np.int8), [0])))
    starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
    keep = (ends - starts) >= int(round(min_silence / HOP))
    return [(s * HOP, e * HOP) for s, e in zip(starts[keep], ends[keep])]


def keep_segments(sil, duration: float, pad: float) -> list[tuple[float, float]]:
    """Invert silences into sound, pad each piece, merge any that now touch."""
    keep, cursor = [], 0.0
    for a, b in sil:
        if a > cursor:
            keep.append((cursor, a))
        cursor = b
    if cursor < duration:
        keep.append((cursor, duration))
    merged: list[tuple[float, float]] = []
    for a, b in keep:
        a, b = max(0.0, a - pad), min(duration, b + pad)
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


def gaps(segs, duration: float) -> list[tuple[float, float]]:
    """The removed stretches between kept segments."""
    out, cursor = [], 0.0
    for a, b in segs:
        if a > cursor:
            out.append((cursor, a))
        cursor = b
    if cursor < duration:
        out.append((cursor, duration))
    return out


@dataclass
class Trial:
    threshold: int
    kept: float
    lost: float                                     # seconds of audible sound cut
    # (gap start, gap end, audible seconds in it, peak dB) per affected gap
    lost_spans: list[tuple[float, float, float, float]] = field(default_factory=list)
    segments: list[tuple[float, float]] = field(default_factory=list)


@dataclass
class Analysis:
    duration: float
    noise_floor: float
    speech_level: float
    audible_above: float
    trials: list[Trial]
    chosen: int
    note: str = ""
    x: np.ndarray | None = field(default=None, repr=False)   # decoded 16 kHz mono

    def trial(self, threshold: int) -> Trial:
        return next(t for t in self.trials if t.threshold == threshold)

    def to_dict(self) -> dict:
        """Everything except the decoded audio, for saving to the library."""
        return {"duration": self.duration, "noise_floor": self.noise_floor,
                "speech_level": self.speech_level, "audible_above": self.audible_above,
                "chosen": self.chosen, "note": self.note,
                "trials": [{"threshold": t.threshold, "kept": t.kept, "lost": t.lost,
                            "lost_spans": t.lost_spans, "segments": t.segments}
                           for t in self.trials]}

    @classmethod
    def from_dict(cls, d: dict) -> "Analysis":
        trials = [Trial(t["threshold"], t["kept"], t["lost"],
                        [tuple(s) for s in t["lost_spans"]], [tuple(s) for s in t["segments"]])
                  for t in d["trials"]]
        return cls(d["duration"], d["noise_floor"], d["speech_level"], d["audible_above"],
                   trials, d["chosen"], d.get("note", ""))


def analyze(path: str, min_silence: float = 0.8, pad: float = 0.15,
            tolerance: float = 0.0, start: int = -25, progress=None) -> Analysis:
    say = progress or (lambda stage, frac=None: None)

    say("Reading the recording")
    x = decode(path)
    duration = x.size / RATE
    if duration < 1:
        raise ValueError("That recording is under a second long.")

    say("Measuring loudness")
    win = window_db(x)
    heard = win[win > -120.0]
    # Pure digital silence (a muted microphone, say): no level to cut at.
    if heard.size < 2:
        raise ValueError("This recording is completely silent, so there's nothing to trim or chart. If it should have sound, the microphone was probably muted, turned down to 0, or in use by another program (such as Discord) while it was recording.")
    split = otsu(heard)
    floor = float(np.median(win[win <= split]))
    level = float(np.median(win[win > split])) if (win > split).any() else split
    audible = audible_level(floor, level)

    # Audibility is judged on 50 ms windows sliding in 10 ms steps. Fixed 50 ms
    # blocks can only be checked where they sit wholly inside a removed gap, so
    # up to 50 ms at each edge went unexamined - and the edge is exactly where
    # the tail of a word trails into the cut.
    levels = hop_db(x)
    per = int(round(WIN / HOP))
    energy = np.convolve(10 ** (levels / 10), np.ones(per) / per, mode="valid")
    slide = 10 * np.log10(np.maximum(energy, 1e-20))   # slide[i] covers hops i..i+per-1
    loud = slide > audible

    def audible_cut(a: float, b: float):
        """(start, end, audible seconds, peak dB) for a removed gap, or None.

        Only the audible part counts toward the loss: a long removed pause with
        one short sound in it has lost that sound, not the whole pause.
        """
        lo, hi = int(np.ceil(a / HOP)), int(b / HOP) - per + 1   # windows inside [a, b)
        if hi <= lo:
            return None
        hits = loud[lo:hi]
        if not hits.any():
            return None
        # Audible seconds: the hops covered by at least one loud window.
        covered = np.convolve(hits.astype(np.int8), np.ones(per, dtype=np.int8))
        return (a, b, int(np.count_nonzero(covered)) * HOP, float(slide[lo:hi].max()))

    say("Choosing the threshold")
    trials: list[Trial] = []
    # Stop just above the background: at or below it, nothing reads as silence.
    lowest = int(np.floor(floor + 3))
    for t in range(start, min(start, lowest) - 1, -1):
        segs = keep_segments(silences(levels, t, min_silence), duration, pad)
        cut = [c for c in (audible_cut(a, b) for a, b in gaps(segs, duration)) if c]
        trials.append(Trial(t, sum(b - a for a, b in segs),
                            sum(c[2] for c in cut), cut, segs))

    note = ""
    ok = [tr for tr in trials if tr.lost <= tolerance]
    if ok:
        chosen = ok[0].threshold   # trials run from most to least aggressive
    else:
        best = min(trials, key=lambda tr: tr.lost)
        chosen = best.threshold
        note = (f"No threshold kept every audible sound; {chosen} dB cuts the least "
                f"({best.lost:.1f}s).")
    return Analysis(duration, floor, level, audible, trials, chosen, note, x)


CODECS = {   # output format -> ffmpeg encoder arguments
    "mp3": ["-c:a", "libmp3lame"],
    "m4a": ["-c:a", "aac", "-movflags", "+faststart"],
}


def render(path: str, segs, out_path: str, bitrate: str = "192k", progress=None,
           fmt: str = "mp3", stream: int = 0) -> float:
    """Cut `segs` (source seconds) from the original's audio stream `stream`
    (the first: the mix, for a recording with a track per input) and join them
    into an mp3 (or m4a). Returns the output duration."""
    say = progress or (lambda stage, frac=None: None)
    exe = ffmpeg()
    with tempfile.TemporaryDirectory() as work:
        parts = []
        batches = [segs[i:i + BATCH] for i in range(0, len(segs), BATCH)]
        for bi, batch in enumerate(batches):
            say("Writing the trimmed file", bi / max(1, len(batches)))
            chain = [f"[0:a:{stream}]atrim=start={a:.6f}:end={b:.6f},asetpts=N/SR/TB[s{j}]"
                     for j, (a, b) in enumerate(batch)]
            labels = "".join(f"[s{j}]" for j in range(len(batch)))
            chain.append(f"{labels}concat=n={len(batch)}:v=0:a=1[out]")
            part = os.path.join(work, f"part{bi}.flac")
            res = _run([exe, "-v", "error", "-y", "-i", path,
                        "-filter_complex", ";".join(chain), "-map", "[out]", part])
            if res.returncode != 0:
                raise RuntimeError(res.stderr.decode(errors="replace")[-500:])
            parts.append(part)

        # Join with the concat *filter*: the concat demuxer reuses the first
        # FLAC part's header for all of them and silently drops audio.
        inputs = [arg for p in parts for arg in ("-i", p)]
        labels = "".join(f"[{i}:a]" for i in range(len(parts)))
        res = _run([exe, "-v", "error", "-y", *inputs, "-filter_complex",
                    f"{labels}concat=n={len(parts)}:v=0:a=1[out]", "-map", "[out]",
                    *CODECS[fmt], "-b:a", bitrate, out_path])
        if res.returncode != 0:
            raise RuntimeError(res.stderr.decode(errors="replace")[-500:])
    say("Done", 1.0)
    return decode(out_path).size / RATE


def audio_streams(path: str) -> list[str]:
    """Each audio stream's title ("" where it has none), in order."""
    text = _run([ffmpeg(), "-hide_banner", "-i", path]).stderr.decode(errors="replace")
    out = []
    for block in re.split(r"(?m)^\s*Stream #", text)[1:]:
        head, _, rest = block.partition("\n")
        if ": Audio:" not in head:
            continue
        m = re.search(r"(?m)^\s+(?:title|handler_name)\s*:\s*(.+)$", rest)
        name = m.group(1).strip() if m else ""
        out.append("" if name in ("SoundHandler", "Core Media Audio") else name)
    return out


def write_segments(segs, path: str) -> None:
    """Kept segments in source time, the same format trim-silence.ps1 writes."""
    with open(path, "w", encoding="utf-8") as fh:
        json.dump([{"start": a, "end": b} for a, b in segs], fh, indent=2)
