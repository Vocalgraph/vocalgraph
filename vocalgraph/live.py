"""Live analysis: who is speaking, and how their voice sounds, while the audio
is still arriving.

Audio comes from ffmpeg: a microphone, or a file played at its own speed. It is
analysed with the same models and rules as a finished recording, in four
threads:

  reader    ffmpeg's 16 kHz mono stream into a growing buffer. ffmpeg also
            writes the input, at its own sample rate, to an M4A (AAC) or FLAC
            file: the full recording, which becomes an ordinary library
            recording, trimmed like any other, when the session stops. With
            several inputs (say a microphone and the computer's own sound),
            they are mixed for the analysis, and the recording keeps the mix
            as its first track and each input as a track of its own.
  speakers  for each new second: segmentation of the newest 10 s window and a
            voiceprint per local speaker, exactly the per-window work of
            speakers.prepare().
  voice     openSMILE frames for each new 0.1 s, with half a second of audio
            before it and 0.1 s after, so block edges measure like the middle
            (checked: every frame identical to measuring the whole file at
            once). Measures are ready about a quarter of a second after the
            words, whoever said them.
  grouper   re-runs speakers.assign(), the exact offline grouping, on
            everything so far, every few seconds. The grouping itself runs in
            a worker process: at an hour it takes seconds, and in-process it
            would compete with the live threads for Python's one interpreter.

Voice measures don't wait for speakers: they are kept for every frame, and who
said each one is looked up in the current turns whenever they are read. So a
relabelling retags them rather than measuring again; and when the session is
filed in the library, its voiceprints and voice frames go with it, so the
library only groups and cuts instead of redoing the analysis.

Between regroupings each new voiceprint goes to the nearest known speaker, by
the distance at which the offline grouping merges two groups, or starts a new
speaker. So new speech is labelled about a second after it is said, and older
labels can change when the full grouping runs again. Speaker ids are kept
stable across regroupings by matching speaking time, so names stay with voices.

A voice is only shown as a new speaker once the full grouping has kept it
apart from everyone already known in two regroupings running, with at least
CONFIRM_TALK seconds of speech (the first speaker, and anyone on an input of
their own, needs just one). Until then its speech is "not sure yet", drawn in
grey. Speakers are numbered 1, 2, 3 in the order they were confirmed, and the
numbers close up if one is merged into another.

With several inputs, each is also measured on its own (sources.py): someone on
an input of their own gets their turns from its track, including while someone
else talks over them, and their voice measured on it; their newest speech is
labelled straight from their track, without waiting for the grouping.
"""
from __future__ import annotations

import concurrent.futures as cf
import multiprocessing as mp
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid

import numpy as np

from . import appaudio, core, sources, speakers as S, voice

RATE = S.RATE
READ = RATE // 20 * 4               # bytes per read: 50 ms of float32
VOICE_BLOCK = 0.1                   # seconds of new audio per openSMILE pass (~13 ms of work)
VOICE_BEFORE = 0.5                  # seconds of audio before the block, for context
VOICE_AFTER = 0.1                   # and after it: the least that still measures exactly
VOICE_HOP = 0.01                    # openSMILE frame step
REGROUP_EVERY = 4.0                 # seconds between full regroupings, at least
CONFIRM_TALK = 2.0                  # seconds of speech before a new voice counts as a speaker
LEVEL = int(sources.HOP * S.RATE)   # samples per input level reading
POLL = 0.05

# The full recording's format -> ffmpeg output arguments. M4A is written as 1 s
# fragments, so it stays readable even if the app is closed mid-recording.
FORMATS = {
    "m4a": ["-c:a", "aac", "-b:a", "192k", "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
            "-frag_duration", "1000000"],
    "flac": ["-c:a", "flac"],
}


def _flags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def list_devices() -> list[dict]:
    """Audio inputs, as [{"id", "name", "kind"}]: microphones and other input
    devices ("mic"), and programs whose own sound can be recorded ("app", with
    "playing" if it is making sound now; on a Mac, a "disabled" entry explains
    the permission it needs)."""
    ff = core.ffmpeg()
    if sys.platform == "win32":
        text = core._run([ff, "-hide_banner", "-list_devices", "true", "-f", "dshow",
                          "-i", "dummy"]).stderr.decode(errors="replace")
        mics = [{"id": n, "name": n, "kind": "mic"} for n in re.findall(r'"([^"]+)" \(audio\)', text)]
        try:
            apps = [{**a, "kind": "app"} for a in appaudio.apps()]
        except OSError:
            apps = []
        return mics + apps
    if sys.platform == "darwin":
        text = core._run([ff, "-hide_banner", "-list_devices", "true", "-f", "avfoundation",
                          "-i", ""]).stderr.decode(errors="replace")
        audio = text.split("audio devices:", 1)[-1] if "audio devices:" in text else ""
        mics = [{"id": i, "name": n.strip(), "kind": "mic"} for i, n in re.findall(r"\[(\d+)\] (.+)", audio)]
        try:
            apps = [{**a, "kind": "app"} for a in appaudio.apps()]   # ScreenCaptureKit; untested
        except Exception:
            apps = []
        return mics + apps
    return [{"id": "default", "name": "Default input"}]


def _devices(source: dict) -> list[str]:
    return list(source.get("devices") or [source["device"]])


def _input_args(source: dict, captures: dict | None = None) -> list[str]:
    """ffmpeg's inputs. A program's sound ("app:<exe>") comes from its
    AppCapture in `captures`, over a local socket."""
    if source["kind"] == "file":
        return ["-re", "-i", source["path"]]          # at its own speed, as if live
    args = []
    for dev in _devices(source):
        if dev.startswith("app:"):
            args += captures[dev].ffmpeg_input()
        elif sys.platform == "win32":
            args += ["-f", "dshow", "-audio_buffer_size", "50", "-i", f"audio={dev}"]
        elif sys.platform == "darwin":
            args += ["-f", "avfoundation", "-i", f":{dev}"]
        else:
            args += ["-f", "pulse", "-i", dev or "default"]
    return args


def _join(turns, gap: float = S.JOIN_GAP):
    """Merge a speaker's turns across short gaps; sorted by start."""
    by: dict[int, list[list[float]]] = {}
    for a, b, k in sorted(turns):
        runs = by.setdefault(k, [])
        if runs and a <= runs[-1][1] + gap:
            runs[-1][1] = max(runs[-1][1], b)
        else:
            runs.append([a, b])
    return sorted((a, b, k) for k, runs in by.items() for a, b in runs)


def _overlap(a, b) -> float:
    """Total overlap between two sorted, non-overlapping span lists."""
    i = j = 0
    total = 0.0
    while i < len(a) and j < len(b):
        lo, hi = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        if hi > lo:
            total += hi - lo
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return total


def _inside(t: np.ndarray, spans) -> np.ndarray:
    """Which times fall inside a sorted, non-overlapping list of spans."""
    if not spans:
        return np.zeros(t.shape, dtype=bool)
    starts = np.array([s for s, _ in spans])
    ends = np.array([e for _, e in spans])
    idx = np.searchsorted(starts, t, side="right") - 1
    return (idx >= 0) & (t < ends[np.maximum(idx, 0)])


def frames_of(frames, home: int | None):
    """(times, measures) of the frames that speak for someone on input `home`
    (their own input's frames), or for someone on no one input (None): the
    loudest input's at each moment. frames: (t, raw, inputs), inputs None when
    there was one input, or the inputs weren't measured apiece."""
    t, raw, src = frames
    if src is None:
        return t, raw
    keep = src[0] == home if home is not None else src[1].astype(bool)
    return t[keep], {k: v[keep] for k, v in raw.items()}


def _group(binary: np.ndarray, emb: np.ndarray, num: int | None):
    """The full grouping, on everything so far: speaker turns (grouping labels)
    and each label's voiceprint centroid. Runs in the worker process."""
    count = np.rint(S._aggregate(binary.astype(np.float32).sum(axis=2, keepdims=True),
                                 skip_average=False)[:, 0]).astype(int)
    if count.max() == 0:
        return [], {}
    turns = [(t.start, t.end, t.speaker)
             for t in S.assign({"binary": binary, "count": count, "embeddings": emb}, num)]
    return turns, _centroids(binary, emb, turns)


def _centroids(binary, emb, grouped) -> dict:
    """Voiceprint centroids of the regrouped speakers, for nearest-speaker
    assignment until the next regrouping. Each window's local speaker goes to
    whoever the regrouping says was talking in its frames."""
    if not grouped:
        return {}
    firsts = [S._closest_frame(c * S.STEP / RATE + 0.5 * S.FRAME_DUR) for c in range(len(binary))]
    # One speaker label per model frame (-1 = nobody; overlap: either).
    label = np.full(firsts[-1] + S.NUM_FRAMES, -1, dtype=np.int32)
    offset = S.FRAME_START + S.FRAME_DUR / 2
    for a, b, k in grouped:
        lo = max(0, int(np.ceil((a - offset) / S.FRAME_STEP)))
        hi = min(label.size, int(np.ceil((b - offset) / S.FRAME_STEP)))
        label[lo:hi] = k
    cent: dict[int, list] = {}
    for c, first in enumerate(firsts):
        for k in range(S.LOCAL):
            act = binary[c, :, k] > 0
            if not act.any() or np.isnan(emb[c, k]).any():
                continue
            who = label[first + np.flatnonzero(act)]
            who = who[who >= 0]
            if not who.size:
                continue
            ids, hits = np.unique(who, return_counts=True)
            best = int(ids[np.argmax(hits)])
            e = emb[c, k] / (np.linalg.norm(emb[c, k]) + 1e-12)
            slot = cent.setdefault(best, [np.zeros_like(e), 0])
            slot[0] = slot[0] + e
            slot[1] += 1
    return cent


class Session:
    def __init__(self, source: dict, work_dir: str, label: str, fmt: str = "m4a"):
        self.id = uuid.uuid4().hex[:12]
        self.source, self.label = source, label
        self.dir = os.path.join(work_dir, self.id)
        os.makedirs(self.dir)
        self.fmt = fmt if fmt in FORMATS else "m4a"
        self.inputs = 1 if source["kind"] == "file" else len(_devices(source))
        # With several inputs, each is analysed on its own as well: `tracks` of
        # them. A replayed recording that has a track per input after its mix
        # (one made live from several inputs) is replayed track by track too.
        self.tracks = self.inputs if self.inputs > 1 else 0
        if source["kind"] == "file":
            titles = core.audio_streams(source["path"])
            if len(titles) >= 3:
                self.tracks = len(titles) - 1
                source["names"] = [t or f"Input {i + 1}" for i, t in enumerate(titles[1:])]
        # FLAC's own file holds one track; several go in Matroska instead.
        ext = "mka" if self.fmt == "flac" and (self.inputs > 1 or self.tracks) else self.fmt
        self.recording = os.path.join(self.dir, "input." + ext)
        self.lock = threading.RLock()
        self.status, self.error = "starting", None
        self.started = time.time()
        self.ended = False            # the input has finished (stopped or end of file)
        self.num_speakers: int | None = None
        self.names: dict[int, str] = {}
        # audio, 16 kHz mono, rounded to 16-bit as prepare() does
        self.x = np.zeros(RATE * 60, dtype=np.float32)
        self.n = 0
        # each input on its own, 16 kHz mono 16-bit, and its level per sources.HOP
        self.tx = [np.zeros(RATE * 60, dtype=np.int16) for _ in range(self.tracks)]
        self.lev = [np.zeros(0) for _ in range(self.tracks)]
        self.lev_n = 0
        self.thr: list[float] | None = None     # each input's speech threshold, from the last regrouping
        self.homes: dict[int, int] = {}          # speaker -> their input
        self.own: dict[int, int] = {}            # input -> the one speaker on it
        # per-window speaker data, in prepare()'s layout
        self.binary: list[np.ndarray] = []      # (589, 3) each
        self.emb: list[np.ndarray] = []         # (3, 256) each, NaN = no voiceprint
        # nearest-speaker assignment between regroupings
        self.cent: dict[int, list] = {}         # pid -> [sum of unit voiceprints, count]
        self.next_pid = 0
        self.online: list[tuple[float, float, int]] = []
        # the latest full regrouping, on stable ids
        self.grouped: list[tuple[float, float, int]] = []
        self.grouped_until = 0.0
        self.regroup = {"at": None, "took": None}
        # speakers confirmed as distinct: id -> order of confirmation; and how
        # many regroupings running each unconfirmed one has been found in
        self.confirmed: dict[int, int] = {}
        self.seen: dict[int, int] = {}
        self._regroup_asked = threading.Event()
        # voice frames: centre times and measures, NaN where undefined; arrays
        # with spare room at the end, the first vn entries in use
        self.vt = np.zeros(0)
        self.vraw: dict[str, np.ndarray] = {k: np.zeros(0) for k in voice.COLUMNS.values()}
        self.vsrc = np.zeros(0, dtype=np.int8)     # which input each frame was measured on
        self.vprim = np.zeros(0, dtype=bool)       # that input was the loudest at that moment
        self.vn = 0
        self.voice_until = 0.0
        self.proc = None
        self.captures: dict[str, appaudio.AppCapture] = {}   # programs' sound, by input id
        self.threads: list[threading.Thread] = []
        self._pool = None               # the grouping worker; False = run in-process
        self.discarded = False

    # --- lifecycle ---------------------------------------------------------------

    def start(self) -> None:
        if self.source["kind"] == "device":
            names = list(self.source.get("names") or [])
            for i, dev in enumerate(_devices(self.source)):
                if dev.startswith("app:"):
                    cap = appaudio.AppCapture(dev[4:], names[i] if i < len(names) else dev[4:])
                    cap.start()                  # listens; ffmpeg connects as it opens its inputs
                    self.captures[dev] = cap
        inputs = _input_args(self.source, self.captures)
        analysis = ["-ac", "1", "-rematrix_maxval", "1", "-ar", str(RATE), "-f", "f32le", "pipe:1"]
        mono = f"aresample={RATE}:rematrix_maxval=1,aformat=sample_fmts=flt:channel_layouts=mono"
        if self.inputs == 1 and self.tracks:
            # A replay with its tracks: the mix and each track, as a live session with them.
            n = self.tracks
            fix = []
            for L in self._replay_lags():
                if L > 0:
                    fix.append(f"adelay=delays={round(L * 1000)}:all=1,")
                elif L < 0:
                    fix.append(f"atrim=start={-L:.3f},asetpts=PTS-STARTPTS,")
                else:
                    fix.append("")
            mix = f"[0:a:0]{mono}[an];" + "".join(f"[0:a:{i + 1}]{fix[i]}{mono}[v{i}];" for i in range(n)) + \
                "[an]" + "".join(f"[v{i}]" for i in range(n)) + f"amerge=inputs={n + 1}[all]"
            cmd = [core.ffmpeg(), "-hide_banner", "-loglevel", "error", *inputs,
                   "-filter_complex", mix, "-map", "[all]", "-f", "f32le", "pipe:1",
                   "-map", "0:a", *FORMATS[self.fmt], *self._titles(), self.recording]
        elif self.inputs == 1:
            cmd = [core.ffmpeg(), "-hide_banner", "-loglevel", "error", *inputs,
                   "-map", "0:a:0", *analysis, "-map", "0:a:0", *FORMATS[self.fmt], self.recording]
        else:
            # Each input's clock is made to start at zero and kept in step (a
            # program's sound has no timestamps of its own; devices have theirs),
            # then summed, not averaged (normalize=0): usually one person talks
            # at a time, and averaging would make every voice quieter than it was.
            n = self.inputs
            # The analysis stream has n + 1 channels: the mix, then each input,
            # all 16 kHz mono. The conversions are on the analysis branches
            # alone; without them ffmpeg converts before the split, and the
            # saved mix comes out at 16 kHz mono too.
            mix = "".join(f"[{i}:a:0]aresample=async=1000:first_pts=0,asplit=3[s{i}][u{i}][r{i}];" for i in range(n)) + \
                "".join(f"[s{i}]" for i in range(n)) + \
                f"amix=inputs={n}:duration=longest:normalize=0,asplit=2[a][rec];" + \
                f"[a]{mono}[an];" + "".join(f"[u{i}]{mono}[v{i}];" for i in range(n)) + \
                "[an]" + "".join(f"[v{i}]" for i in range(n)) + f"amerge=inputs={n + 1}[all]"
            titles = self._titles()
            cmd = [core.ffmpeg(), "-hide_banner", "-loglevel", "error", *inputs,
                   "-filter_complex", mix, "-map", "[all]", "-f", "f32le", "pipe:1",
                   # Each input's own track from the same lined-up branch as the mix,
                   # so it runs exactly in step with it (the input as it came can
                   # start some tens of ms off).
                   "-map", "[rec]", *[a for i in range(n) for a in ("-map", f"[r{i}]")],
                   *FORMATS[self.fmt], *titles, self.recording]
        # stdin is a pipe so stop() can send ffmpeg's own "q" key: it then
        # flushes and finalises the recording, which a kill could cut short.
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     stdin=subprocess.PIPE, creationflags=_flags())
        for fn in (self._reader, self._speakers, self._voice, self._grouper):
            t = threading.Thread(target=self._guard(fn), daemon=True, name=f"live-{fn.__name__}")
            t.start()
            self.threads.append(t)

    def _replay_lags(self) -> list[float]:
        """For a replay with tracks: how much earlier each track runs than the
        mix (sources.lag), from the first minute."""
        path = self.source["path"]
        mix = sources.levels(core.decode(path, duration=60), RATE)
        return [sources.lag(mix, sources.levels(core.decode(path, duration=60, stream=i + 1), RATE))
                for i in range(self.tracks)]

    def _titles(self) -> list[str]:
        """Track names for the saved file: the mix, then each input. MP4
        keeps a track's name as its handler name, Matroska as its title."""
        names = list(self.source.get("names") or [])
        out = []
        for i, name in enumerate(["Mix"] + [names[i] if i < len(names) else f"Input {i + 1}"
                                            for i in range(self.tracks)]):
            out += [f"-metadata:s:a:{i}", f"title={name}", f"-metadata:s:a:{i}", f"handler_name={name}"]
        return out

    def stop(self) -> None:
        with self.lock:
            if self.status in ("live", "starting"):
                self.status = "stopping"
        proc = self.proc
        if proc and proc.poll() is None:
            try:
                proc.stdin.write(b"q")
                proc.stdin.flush()
            except OSError:
                pass

            def kill_later():
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.terminate()
            threading.Thread(target=kill_later, daemon=True).start()

    def discard(self) -> None:
        self.stop()
        for t in self.threads:
            t.join(timeout=5)
        shutil.rmtree(self.dir, ignore_errors=True)

    def _guard(self, fn):
        def run():
            try:
                fn()
            except Exception as exc:     # shown on the page, not lost in a console
                with self.lock:
                    self.status, self.error = "error", f"{type(exc).__name__}: {exc}"
                if self.proc and self.proc.poll() is None:
                    self.proc.terminate()
                for cap in self.captures.values():
                    cap.stop()
        return run

    def _alive(self) -> bool:
        return self.status not in ("error",)

    # --- reader ------------------------------------------------------------------

    def _reader(self) -> None:
        pending = b""
        out = self.proc.stdout
        ch = 1 + self.tracks                     # the mix, then each input
        while True:
            data = out.read1(READ * ch) if hasattr(out, "read1") else out.read(READ * ch)
            if not data:
                break
            pending += data
            usable = len(pending) - len(pending) % (4 * ch)
            if not usable:
                continue
            frames = np.frombuffer(pending[:usable], dtype=np.float32).reshape(-1, ch)
            pending = pending[usable:]
            block = voice.to_16bit(np.ascontiguousarray(frames[:, 0]))
            with self.lock:
                if self.n + block.size > self.x.size:
                    grow = max(self.x.size, block.size)
                    self.x = np.concatenate([self.x, np.zeros(grow, np.float32)])
                    self.tx = [np.concatenate([t, np.zeros(grow, np.int16)]) for t in self.tx]
                self.x[self.n:self.n + block.size] = block
                for i, t in enumerate(self.tx):
                    t[self.n:self.n + block.size] = np.clip(np.round(frames[:, i + 1] * 32768.0), -32768, 32767)
                self.n += block.size
                if self.status == "starting":
                    self.status = "live"
        self.proc.wait()
        for cap in self.captures.values():
            cap.stop()
        err = self.proc.stderr.read().decode(errors="replace").strip()
        problems = [c.error for c in self.captures.values() if c.error]
        if problems:
            err = " ".join(problems) + (" " + err if err else "")
        with self.lock:
            self.ended = True
            if self.n == 0 and self.status != "error":
                self.status = "error"
                self.error = "No audio came through. " + (err[-300:] if err else "")
        self._regroup_asked.set()

    def _audio(self, a: int, b: int) -> np.ndarray:
        with self.lock:
            return self.x[a:b].copy()

    # --- speakers ------------------------------------------------------------------

    def _speakers(self) -> None:
        seg = S._session("segmentation")
        name = seg.get_inputs()[0].name
        c = 0
        while self._alive():
            start = c * S.STEP
            with self.lock:
                have, ended = self.n, self.ended
            if have < start + S.WINDOW:
                if ended:
                    break
                time.sleep(POLL)
                continue
            crop = self._audio(start, start + S.WINDOW)
            logp = seg.run(None, {name: crop[None, None, :]})[0]
            binary = S.POWERSET[logp.argmax(axis=-1)]                  # (1, 589, 3)
            emb = S._embeddings(crop, [0], binary, lambda f: None)[0]  # (3, 256)
            self._place_window(c, binary[0], emb)
            c += 1
        with self.lock:
            if self.status == "stopping" or self.status == "live":
                self.status = "finishing"
        self._regroup_asked.set()

    def _place_window(self, c: int, binary: np.ndarray, emb: np.ndarray) -> None:
        """Store one window and label its newest second by nearest speaker."""
        with self.lock:
            self.binary.append(binary.astype(np.uint8))
            self.emb.append(emb)
            first = S._closest_frame(c * S.STEP / RATE + 0.5 * S.FRAME_DUR)
            stamps = S.FRAME_START + (first + np.arange(S.NUM_FRAMES)) * S.FRAME_STEP + S.FRAME_DUR / 2
            lo = 0.0 if c == 0 else (c * S.STEP + S.WINDOW - S.STEP) / RATE
            hi = (c * S.STEP + S.WINDOW) / RATE
            new = (stamps >= lo) & (stamps < hi)
            for k in range(S.LOCAL):
                active = binary[:, k] > 0
                if not active.any() or np.isnan(emb[k]).any():
                    continue
                pid = self._nearest(emb[k])
                on = active & new
                if not on.any():
                    continue
                # runs of active frames in the new second -> turns
                edges = np.flatnonzero(np.diff(np.r_[0, on.astype(np.int8), 0]))
                for a, b in zip(edges[::2], edges[1::2]):
                    self.online.append((float(stamps[a]), float(min(stamps[b - 1] + S.FRAME_STEP, hi)), pid))

    def _nearest(self, e: np.ndarray) -> int:
        e = e / (np.linalg.norm(e) + 1e-12)
        pid, dist = None, np.inf
        if self.cent:
            ids = list(self.cent)
            means = np.stack([self.cent[i][0] / self.cent[i][1] for i in ids])
            d = np.linalg.norm(means - e, axis=1)
            j = int(np.argmin(d))
            pid, dist = ids[j], float(d[j])
        full = self.num_speakers is not None and len(self.cent) >= self.num_speakers
        if pid is None or (dist > S.THRESHOLD and not full):
            pid = self.next_pid
            self.next_pid += 1
            self.cent[pid] = [np.zeros_like(e), 0]
        self.cent[pid][0] = self.cent[pid][0] + e
        self.cent[pid][1] += 1
        return pid

    # --- grouper -----------------------------------------------------------------

    def ask_regroup(self) -> None:
        self._regroup_asked.set()

    def _grouper(self) -> None:
        try:
            self._grouper_loop()
        finally:
            if self._pool:
                self._pool.shutdown(wait=False, cancel_futures=True)

    def _grouper_loop(self) -> None:
        last = 0.0
        took = 0.0
        while self._alive():
            wait = max(REGROUP_EVERY, took) - (time.time() - last)
            asked = self._regroup_asked.wait(timeout=max(0.0, wait))
            self._regroup_asked.clear()
            with self.lock:
                done = self.status == "finishing"
            if not asked and time.time() - last < REGROUP_EVERY:
                continue
            t0 = time.time()
            self._regroup_once()
            took, last = time.time() - t0, time.time()
            if done:
                # Wait for the voice thread too, then the session is complete.
                for t in self.threads:
                    if t.name == "live-_voice":
                        t.join()
                with self.lock:
                    if self.status == "finishing":
                        self.status = "stopped"
                return

    def _regroup_once(self) -> None:
        with self.lock:
            if not self.binary:
                return
            binary = np.stack(self.binary)
            emb = np.stack(self.emb)
            num = self.num_speakers
            chunks = len(self.binary)
            shown = self._labelled_locked()
            lev = self._levels_locked() if self.tracks else None
        until = ((chunks - 1) * S.STEP + S.WINDOW) / RATE
        t0 = time.time()
        turns, label_cent = self._run_group(binary, emb, num)
        homes: dict[int, int] = {}
        own: dict[int, int] = {}
        thr = None
        if lev is not None and turns:
            # Anyone on an input of their own: their turns off its track.
            thr = [sources.threshold(v) for v in lev]
            act = sources.activity(lev, thr)
            turns, homes = sources.refine(turns, act, until)
            _, own = sources.homes(turns, act[:int(until / sources.HOP)])
        took = time.time() - t0

        # Keep ids stable: match new groups to the speakers already on screen by
        # shared speaking time (a one-to-one assignment), new ids for the rest.
        new_ids = sorted({k for *_, k in turns})
        old_ids = sorted({k for *_, k in shown})
        mapping = {}
        if new_ids and old_ids:
            from scipy.optimize import linear_sum_assignment
            spans_new = {k: [(a, b) for a, b, kk in _join(turns) if kk == k] for k in new_ids}
            spans_old = {k: [(a, min(b, until)) for a, b, kk in shown if kk == k and a < until]
                         for k in old_ids}
            score = np.array([[_overlap(spans_new[n], spans_old[o]) for o in old_ids] for n in new_ids])
            for i, j in zip(*linear_sum_assignment(-score)):
                if score[i, j] > 0:
                    mapping[new_ids[i]] = old_ids[j]
        with self.lock:
            for k in new_ids:
                if k not in mapping:
                    mapping[k] = self.next_pid
                    self.next_pid += 1
            grouped = [(a, b, mapping[k]) for a, b, k in turns]
            self.grouped, self.grouped_until = grouped, until
            self.cent = {mapping[k]: v for k, v in label_cent.items() if k in mapping}
            self.homes = {mapping[k]: h for k, h in homes.items() if k in mapping}
            self.own = {i: mapping[k] for i, k in own.items() if k in mapping}
            self.thr = thr
            # Online labels before this point are superseded.
            self.online = [t for t in self.online if t[1] > until]
            self.regroup = {"at": time.time(), "took": round(took, 3), "until": until}
            self._confirm_locked()

    def _confirm_locked(self) -> None:
        """Count a voice as a speaker once the full grouping has kept it apart
        from the others twice running, with CONFIRM_TALK of speech and one
        turn of MIN_TURN (the bar the offline clean-up sets). The first
        speaker, and anyone on an input of their own, only need it once."""
        talk: dict[int, float] = {}
        longest: dict[int, float] = {}
        for a, b, k in _join(self.grouped):
            talk[k] = talk.get(k, 0.0) + b - a
            longest[k] = max(longest.get(k, 0.0), b - a)
        present = set(talk)
        self.seen = {k: self.seen.get(k, 0) + 1 for k in present}
        anyone = any(k in self.confirmed for k in present)
        own = set(self.own.values())
        for k in sorted(present, key=lambda k: min(a for a, _, kk in self.grouped if kk == k)):
            if k in self.confirmed or talk[k] < CONFIRM_TALK or longest[k] < S.MIN_TURN:
                continue
            if self.seen[k] >= 2 or not anyone or k in own:
                self.confirmed[k] = len(self.confirmed)
                anyone = True

    def _run_group(self, binary, emb, num):
        """_group() in the worker process; in this one if the worker is gone."""
        if self._pool is None:
            try:
                self._pool = cf.ProcessPoolExecutor(max_workers=1, mp_context=mp.get_context("spawn"))
            except Exception:
                self._pool = False
        if self._pool:
            try:
                return self._pool.submit(_group, binary, emb, num).result()
            except Exception:    # a crashed or unstartable worker: carry on without it
                self._pool.shutdown(wait=False, cancel_futures=True)
                self._pool = False
        return _group(binary, emb, num)

    # --- voice ---------------------------------------------------------------------

    def _voice(self) -> None:
        smile = voice.smile()
        block = int(VOICE_BLOCK * RATE)
        before, after = int(VOICE_BEFORE * RATE), int(VOICE_AFTER * RATE)
        at = 0
        while self._alive():
            with self.lock:
                have, ended = self.n, self.ended
            if have < at + block + after:
                if not ended:
                    time.sleep(0.01)
                    continue
                if have <= at:
                    break
            a, b = max(0, at - before), min(have, at + block + after)
            if b - at < int(0.03 * RATE):      # too little left to measure
                break
            # One input: the mix. Several: each input on its own (the mix is
            # then only for the grouping), so voices at the same moment don't
            # blend, and each frame says which input it came from.
            pieces = [self._audio(a, b)] if not self.tracks else self._track_audio(a, b)
            got = []
            for piece in pieces:
                frame = smile.process_signal(piece[None, :], RATE)
                starts = frame.index.get_level_values("start").total_seconds().to_numpy()
                ends = frame.index.get_level_values("end").total_seconds().to_numpy()
                centre = a / RATE + (starts + ends) / 2
                keep = (centre >= at / RATE) & (centre < (at + block) / RATE)
                raw = voice.raw_series(frame)
                got.append((centre[keep], {k: np.array([np.nan if v is None else v for v in values], dtype=float)[keep]
                                           for k, values in raw.items()}))
            m = min(c.size for c, _ in got)
            t = np.repeat(got[0][0][:m], len(got))                 # frame by frame, input by input
            vals = {k: np.stack([v[k][:m] for _, v in got], axis=1).ravel() for k in got[0][1]}
            loud = np.stack([np.nan_to_num(v["loudness"][:m], nan=-1.0) for _, v in got], axis=1)
            src = np.tile(np.arange(len(got), dtype=np.int8), m)
            prim = (np.argmax(loud, axis=1)[:, None] == np.arange(len(got))[None, :]).ravel()
            with self.lock:
                self._append_voice(t, vals, src, prim)
                self.voice_until = min(have, at + block) / RATE
            at += block

    def _track_audio(self, a: int, b: int) -> list[np.ndarray]:
        with self.lock:
            return [t[a:b].astype(np.float32) / 32768.0 for t in self.tx]

    def _levels_locked(self) -> list[np.ndarray]:
        """Each input's level per sources.HOP up to now, extended as audio comes."""
        full = self.n // LEVEL
        if full > self.lev_n:
            a, b = self.lev_n * LEVEL, full * LEVEL
            if full > self.lev[0].size:
                cap = max(2 * self.lev[0].size, full, 3000)
                self.lev = [np.concatenate([v[:self.lev_n], np.zeros(cap - self.lev_n)]) for v in self.lev]
            for i, t in enumerate(self.tx):
                self.lev[i][self.lev_n:full] = sources.levels(t[a:b].astype(np.float32) / 32768.0, RATE)
            self.lev_n = full
        return [v[:self.lev_n] for v in self.lev]

    def _append_voice(self, t: np.ndarray, vals: dict, src=None, prim=None) -> None:
        """Add frames at the end, growing the arrays by doubling. Readers get
        views of the used part; growing makes new arrays, so a view already
        handed out stays valid."""
        need = self.vn + t.size
        if need > self.vt.size:
            cap = max(2 * self.vt.size, need, 6000)
            grow = lambda old: np.concatenate([old[:self.vn], np.full(cap - self.vn, np.nan)])
            self.vt = grow(self.vt)
            self.vraw = {k: grow(v) for k, v in self.vraw.items()}
            self.vsrc = np.concatenate([self.vsrc[:self.vn], np.zeros(cap - self.vn, np.int8)])
            self.vprim = np.concatenate([self.vprim[:self.vn], np.zeros(cap - self.vn, bool)])
        self.vt[self.vn:need] = t
        for k, v in vals.items():
            self.vraw[k][self.vn:need] = v
        self.vsrc[self.vn:need] = 0 if src is None else src
        self.vprim[self.vn:need] = True if prim is None else prim
        self.vn = need

    def _voice_arrays(self):
        with self.lock:
            return self.vt[:self.vn], {k: v[:self.vn] for k, v in self.vraw.items()}

    def _voice_frames(self):
        """(t, raw, inputs) as frames_of() takes them."""
        with self.lock:
            t, raw = self.vt[:self.vn], {k: v[:self.vn] for k, v in self.vraw.items()}
            src = (self.vsrc[:self.vn], self.vprim[:self.vn]) if self.tracks else None
        return t, raw, src

    def frames(self, start: int, limit: int = 60000) -> dict:
        """Voice frames from index `start` on, for the page to keep and draw as
        they arrive; whose they are, it looks up in the turns. Formants are
        masked to voiced frames here; the other rules already apply."""
        t, raw = self._voice_arrays()
        start = max(0, min(int(start), t.size))
        end = min(t.size, start + limit)
        f0 = raw["f0"][start:end]
        out = {"from": start, "next": end, "total": int(t.size),
               "t": np.round(t[start:end], 3).tolist()}
        if self.tracks:
            with self.lock:
                out["src"] = self.vsrc[start:end].tolist()
                out["prim"] = self.vprim[start:end].astype(int).tolist()
        for k, v in raw.items():
            v = v[start:end]
            if k in voice.FORMANTS:
                v = np.where(np.isnan(f0), np.nan, v)
            digits = 4 if k == "loudness" else 1
            out[k] = [None if x != x else x for x in np.round(v, digits).tolist()]
        return out

    def voice_for(self, spk, points: int, gate: bool) -> dict:
        """Voice measures for one speaker ("all" = anyone speaking), laid out on
        the live timeline from 0 to now, like voice.metrics(place=...)."""
        frames = self._voice_frames()
        with self.lock:
            duration = max(self.n / RATE, 1e-3)
            turns, _ = self._display_locked()
            home = self.homes.get(spk) if spk != "all" else None
        if spk == "all":
            spans = [(a, b) for a, b, _ in _join([(a, b, 0) for a, b, _ in turns], 0.0)]
        else:
            spans = [(a, b) for a, b, k in turns if k == spk]
        t, raw = frames_of(frames, home)
        return measure(t, raw, spans, gate, lambda x: x, duration, points)

    def save_analysis(self, folder: str, offset: float) -> bool:
        """File this session's analysis with its recording, so the library can
        group and cut it without analysing it again: the voiceprints in
        speakers.prepare()'s layout (speakers.npz) and the voice frames
        (voice_frames.npz). `offset` is how much later the saved file starts
        than the live stream (the AAC encoder's lead-in); the voice frames are
        moved onto the saved file's timeline by it, and the caller places the
        voiceprints by it. False if there is nothing worth keeping."""
        with self.lock:
            if not self.binary:
                return False
            binary = np.stack(self.binary)
            emb = np.stack(self.emb)
            t, raw = self.vt[:self.vn].copy(), {k: v[:self.vn].copy() for k, v in self.vraw.items()}
            if self.tracks:           # which input each frame was measured on
                raw = {**raw, "src": self.vsrc[:self.vn].copy(), "prim": self.vprim[:self.vn].copy()}
        count = np.rint(S._aggregate(binary.astype(np.float32).sum(axis=2, keepdims=True),
                                     skip_average=False)[:, 0]).astype(np.int16)
        np.savez_compressed(os.path.join(folder, "speakers.npz"),
                            binary=binary.astype(np.uint8), count=count, embeddings=emb)
        np.savez_compressed(os.path.join(folder, "voice_frames.npz"), t=t + offset, **raw)
        return True


    # --- views -----------------------------------------------------------------------

    def _labelled_locked(self):
        """Every turn with its speaker id, confirmed or not: the latest
        regrouping, then the newest speech after it, labelled straight from
        their own input for anyone on one, and by nearest voice otherwise."""
        since = self.grouped_until
        own = set(self.own.values())
        tail = [(max(a, since), b, k) for a, b, k in self.online if b > since and k not in own]
        if self.own and self.thr:
            lev = self._levels_locked()
            lo = int(since / sources.HOP)
            for i, k in self.own.items():
                act = lev[i][lo:] > self.thr[i]
                tail += [(a, b, k) for a, b in sources._runs(act, lo * sources.HOP)]
        return _join(self.grouped + tail)

    def _display_locked(self):
        """(turns of confirmed speakers, spans of speech not yet put to anyone)."""
        turns, unsure = [], []
        for t in self._labelled_locked():
            (turns if t[2] in self.confirmed else unsure).append(t)
        unsure = [(a, b) for a, b, _ in _join([(a, b, 0) for a, b, _ in unsure], 0.0)]
        # Speech already read off someone's own input isn't in doubt.
        own = set(self.own.values())
        sure = sorted((a, b) for a, b, k in turns if k in own)
        if sure and unsure:
            left = []
            for a, b in unsure:
                for c, d in sure:
                    if d <= a or c >= b:
                        continue
                    if c > a:
                        left.append((a, c))
                    a = max(a, d)
                    if a >= b:
                        break
                if b > a:
                    left.append((a, b))
            unsure = [(a, b) for a, b in left if b - a > 0.05]
        return turns, unsure

    def state(self) -> dict:
        with self.lock:
            turns, unsure = self._display_locked()
            duration = self.n / RATE
            level = None
            if self.n:
                tail = self.x[max(0, self.n - RATE // 10):self.n]
                level = round(float(10 * np.log10(np.mean(tail ** 2) + 1e-12)), 1)
            done_to = ((len(self.binary) - 1) * S.STEP + S.WINDOW) / RATE if self.binary else 0.0
            talk: dict[int, float] = {}
            for a, b, k in turns:
                talk[k] = talk.get(k, 0.0) + b - a
            # Numbered in the order they were confirmed, closing up any gaps.
            number = {k: i + 1 for i, k in enumerate(sorted(talk, key=self.confirmed.get))}
            names = list(self.source.get("names") or [])
            return {
                "id": self.id, "status": self.status, "error": self.error, "label": self.label,
                "kind": self.source["kind"], "format": self.fmt, "duration": duration, "level": level,
                "speakers_behind": max(0.0, duration - done_to) if self.status == "live" else 0.0,
                "voice_behind": max(0.0, duration - self.voice_until) if self.status == "live" else 0.0,
                "regroup": self.regroup, "grouped_until": self.grouped_until,
                "warnings": [c.error for c in self.captures.values() if c.error],
                "num_speakers": self.num_speakers,
                "names": {str(k): v for k, v in self.names.items()},
                "speakers": [{"id": k, "talk": talk[k], "n": number[k],
                              "input": self.homes.get(k),
                              "track": names[self.homes[k]] if self.homes.get(k) is not None
                              and self.homes[k] < len(names) else None}
                             for k in sorted(talk, key=number.get)],
                "turns": [[round(a, 3), round(b, 3), k] for a, b, k in turns],
                "unsure": [[round(a, 3), round(b, 3)] for a, b in unsure],
                "inputs": names if self.tracks else [],
            }

    def anchors(self) -> dict:
        """Named speakers' speech, in the format the library uses to carry
        names across re-groupings (source-timeline spans per name)."""
        with self.lock:
            turns, _ = self._display_locked()
            return {name: [(a, b) for a, b, k in turns if k == pid]
                    for pid, name in self.names.items() if name}

def measure(t: np.ndarray, raw: dict, spans, gate: bool, place, duration: float, points: int) -> dict:
    """Voice measures for the frames inside `spans`, from frames already
    measured: the per-frame rules (voice.apply_rules, on arrays), laid out by
    place(t) on a timeline of `duration`, and summarised. Used live, and by the
    library for recordings made live."""
    mask = _inside(t, sorted(spans))
    f0 = raw["f0"].copy()
    if gate:
        f0[~(raw["hnr"] > voice.MIN_HNR_DB)] = np.nan
    vals = {"f0": f0}
    for key in voice.FORMANTS:
        v = raw[key].copy()
        v[np.isnan(f0)] = np.nan
        vals[key] = v
    for key in ("loudness", "hnr"):
        vals[key] = raw[key]
    at = np.full(t.shape, np.nan)
    if mask.any():
        at[mask] = np.asarray(place(t[mask]), dtype=float)
    series = {k: voice._bin_by_time(v, at, duration, points)   # NaN reads as a gap
              for k, v in vals.items()}
    times = [duration * (i + 0.5) / points for i in range(points)]
    mine = {k: [None if np.isnan(x) else float(x) for x in v[mask]] for k, v in vals.items()}
    stats = voice.summary(mine, int(mask.sum()) * VOICE_HOP)
    return {"duration": duration, "time": times, "series": series, "stats": stats}


def offset_of(path: str, x: np.ndarray, seconds: float = 30.0) -> float:
    """How much later the saved recording at `path` starts than the live stream
    `x`, in seconds: 0 for FLAC, the encoder's lead-in for M4A (1024 samples
    at the input's rate). Found by lining up the first `seconds` of both."""
    n = min(x.size, int(seconds * RATE))
    if n < RATE:
        return 0.0
    saved = voice.to_16bit(core.decode(path, duration=seconds + 1.0))
    a, b = x[:n].astype(np.float64), saved[:n + RATE // 2].astype(np.float64)
    if not np.any(a) or b.size < n:
        return 0.0
    size = 1 << int(np.ceil(np.log2(a.size + b.size)))
    corr = np.fft.irfft(np.fft.rfft(b, size) * np.conj(np.fft.rfft(a, size)), size)
    lags = np.arange(RATE // 2)                    # the saved file can only be later
    return float(lags[int(np.argmax(corr[lags]))]) / RATE
