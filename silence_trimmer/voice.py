"""Pitch, resonance, loudness and breathiness over time, via openSMILE eGeMAPS.

Ported from voice_app.py, rules unchanged:
  * frames where a measure is undefined come back as 0, and become gaps;
  * pitch outside 50-500 Hz is a tracking (octave) error, and becomes a gap;
  * formants are only meaningful while the voice is sounding, so they are
    masked to voiced frames;
  * optionally, pitch with HNR <= 0 dB (noise equals harmonics: trailing creak
    and fade-outs) can be hidden. Off by default, since it can be real creak.
"""
from __future__ import annotations

import numpy as np

RATE = 16000
COLUMNS = {
    "F0semitoneFrom27.5Hz_sma3nz": "f0",
    "F1frequency_sma3nz": "f1",
    "F2frequency_sma3nz": "f2",
    "F3frequency_sma3nz": "f3",
    # Capital L at frame level (lowercase in the summary set); the wrong case
    # silently yields an all-null series.
    "Loudness_sma3": "loudness",
    "HNRdBACF_sma3nz": "hnr",
}
NULL_AT_ZERO = {"f0", "f1", "f2", "f3", "hnr"}
FORMANTS = ("f1", "f2", "f3")
F0_MIN_HZ, F0_MAX_HZ = 50.0, 500.0
MIN_HNR_DB = 0.0
MAX_POINTS = 1400


def _bin(values, target: int):
    """At most `target` points, by median per bin, so one bad frame cannot drag
    a bin and a mostly unvoiced bin stays unvoiced."""
    n = len(values)
    if n <= target:
        return [None if v is None else float(v) for v in values]
    edges = np.linspace(0, n, target + 1).astype(int)
    out = []
    for i in range(target):
        chunk = [v for v in values[edges[i]:edges[i + 1]] if v is not None]
        out.append(float(np.median(chunk)) if chunk else None)
    return out


def _bin_by_time(values, at: np.ndarray, duration: float, points: int):
    """Median per time bin over [0, duration]; frames placed at NaN are dropped."""
    out = [None] * points
    v = np.array([np.nan if x is None else x for x in values], dtype=float)
    ok = ~np.isnan(v) & ~np.isnan(at)
    if not ok.any() or duration <= 0:
        return out
    idx = np.clip((at[ok] / duration * points).astype(int), 0, points - 1)
    vals = v[ok]
    order = np.argsort(idx, kind="stable")
    idx, vals = idx[order], vals[order]
    cuts = np.flatnonzero(np.diff(idx)) + 1
    for b, chunk in zip(idx[np.r_[0, cuts]], np.split(vals, cuts)):
        out[int(b)] = float(np.median(chunk))
    return out


def to_16bit(x: np.ndarray) -> np.ndarray:
    # Round to 16-bit, as voice_app.py's decode does, so the numbers match its
    # history exactly (verified: 1400/1400 points identical on every series).
    # Without it the medians agree to <0.1%, but the formant tracker is
    # sensitive enough that ~4% of F1 frames pick a neighbouring formant.
    return (np.clip(np.round(x * 32768.0), -32768, 32767) / 32768.0).astype(np.float32)


def smile():
    import opensmile
    return opensmile.Smile(feature_set=opensmile.FeatureSet.eGeMAPSv02,
                           feature_level=opensmile.FeatureLevel.LowLevelDescriptors)


def raw_series(frame) -> dict:
    """openSMILE frames -> {measure: [value or None]}, with the undefined and
    out-of-range rules applied (but not the HNR gate or formant masking)."""
    raw = {}
    for column, key in COLUMNS.items():
        if column not in frame:
            raw[key] = [None] * len(frame)
            continue
        series = []
        for value in frame[column].to_numpy(dtype=float):
            if np.isnan(value) or (key in NULL_AT_ZERO and value == 0.0):
                series.append(None)
            elif key == "f0":
                hz = 27.5 * (2.0 ** (value / 12.0))   # semitones -> Hz
                series.append(hz if F0_MIN_HZ <= hz <= F0_MAX_HZ else None)
            else:
                series.append(float(value))
        raw[key] = series
    return raw


def apply_rules(raw: dict, gate_low_confidence: bool = False) -> dict:
    """The optional HNR gate on pitch, then formants masked to voiced frames."""
    raw = dict(raw)
    if gate_low_confidence:
        raw["f0"] = [None if (raw["hnr"][i] is None or raw["hnr"][i] <= MIN_HNR_DB) else v
                     for i, v in enumerate(raw["f0"])]
    for key in FORMANTS:
        raw[key] = [v if raw["f0"][i] is not None else None for i, v in enumerate(raw[key])]
    return raw


def summary(raw: dict, duration: float) -> list:
    voiced = [v for v in raw["f0"] if v is not None]
    stats = [["Speech analysed", f"{int(duration // 60)}:{int(duration % 60):02d}"]]
    if voiced:
        stats += [["Median pitch", f"{np.median(voiced):.0f} Hz"],
                  ["Pitch range", f"{np.percentile(voiced, 10):.0f}–{np.percentile(voiced, 90):.0f} Hz"],
                  ["Voiced", f"{100 * len(voiced) / max(1, len(raw['f0'])):.0f}%"]]
    hnr = [v for v in raw["hnr"] if v is not None]
    if hnr:
        stats.append(["Median HNR", f"{np.median(hnr):.1f} dB"])
    return stats


def metrics(x: np.ndarray, gate_low_confidence: bool = False, place=None,
            timeline_duration: float | None = None, points: int | None = None) -> dict:
    """Voice measurements for `x`, one speaker's speech joined together.

    place, if given, maps times within `x` (seconds, array) to positions on
    another timeline of length timeline_duration (NaN where a frame has no
    place there), and the series are laid out on that timeline instead.
    Statistics are the same either way.
    """
    duration = x.size / RATE
    frame = smile().process_signal(to_16bit(x)[None, :], RATE)
    raw = apply_rules(raw_series(frame), gate_low_confidence)

    if place is None:
        # The voice app's layout: this speaker's speech joined end to end.
        axis = duration
        points = min(MAX_POINTS, len(frame))
        series = {k: _bin(v, points) for k, v in raw.items()}
        times = [duration * (i + 0.5) / points for i in range(points)]
    else:
        # On the trimmed recording's timeline, so the charts line up with the
        # speaker timeline and follow playback. Bins where this speaker isn't
        # talking stay empty, which draws as a gap rather than a join.
        starts = frame.index.get_level_values("start").total_seconds().to_numpy()
        ends = frame.index.get_level_values("end").total_seconds().to_numpy()
        at = np.asarray(place((starts + ends) / 2), dtype=float)
        axis = float(timeline_duration)
        points = int(points or MAX_POINTS)
        series = {k: _bin_by_time(v, at, axis, points) for k, v in raw.items()}
        times = [axis * (i + 0.5) / points for i in range(points)]

    return {"duration": axis, "time": times, "series": series, "stats": summary(raw, duration)}
