"""Moving between the original recording's timeline and a trimmed one.

A trimmed file is the kept segments (source seconds) played back to back.
"""
from __future__ import annotations

import bisect

import numpy as np

RATE = 16000


def concat(x: np.ndarray, segs) -> np.ndarray:
    """The audio a trim would produce, from the decoded original."""
    parts = [x[int(a * RATE):int(b * RATE)] for a, b in segs]
    return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


class Timeline:
    def __init__(self, segs):
        self.segs = list(segs)
        self.offsets = []          # where each segment starts in the trimmed file
        t = 0.0
        for a, b in self.segs:
            self.offsets.append(t)
            t += b - a
        self.total = t

    def to_source(self, start: float, end: float):
        """Trimmed [start, end) as source pieces, cut at every segment boundary.

        Mapping just the endpoints would stretch a piece that crosses a cut over
        all the silence removed there.
        """
        out = []
        i = max(0, bisect.bisect_right(self.offsets, start) - 1)
        while start < end and i < len(self.segs):
            seg_end = self.offsets[i] + (self.segs[i][1] - self.segs[i][0])
            piece_end = min(end, seg_end)
            if piece_end > start:
                src = self.segs[i][0] + (start - self.offsets[i])
                out.append((src, src + (piece_end - start)))
            start, i = piece_end, i + 1
        return out

    def points_to_source(self, t: np.ndarray) -> np.ndarray:
        """Trimmed-timeline times -> source times (NaN past the end)."""
        t = np.asarray(t, dtype=float)
        if not self.segs:
            return np.full(t.shape, np.nan)
        offs = np.array(self.offsets)
        starts = np.array([a for a, _ in self.segs])
        lens = np.array([b - a for a, b in self.segs])
        i = np.clip(np.searchsorted(offs, t, side="right") - 1, 0, len(offs) - 1)
        out = starts[i] + (t - offs[i])
        out[(t < 0) | (t >= offs[i] + lens[i])] = np.nan
        return out

    def points_from_source(self, s: np.ndarray) -> np.ndarray:
        """Source times -> trimmed-timeline times (NaN where the audio was cut)."""
        s = np.asarray(s, dtype=float)
        if not self.segs:
            return np.full(s.shape, np.nan)
        starts = np.array([a for a, _ in self.segs])
        ends = np.array([b for _, b in self.segs])
        offs = np.array(self.offsets)
        j = np.clip(np.searchsorted(starts, s, side="right") - 1, 0, len(starts) - 1)
        out = offs[j] + (s - starts[j])
        out[(s < starts[j]) | (s >= ends[j]) | np.isnan(s)] = np.nan
        return out

    def from_source(self, start: float, end: float):
        """Source [start, end) as pieces of the trimmed timeline; parts that fall
        in removed audio are dropped."""
        out = []
        for (a, b), off in zip(self.segs, self.offsets):
            lo, hi = max(a, start), min(b, end)
            if hi > lo:
                out.append((off + lo - a, off + hi - a))
        return out


def intersect(a, b):
    """Overlap of two sorted lists of (start, end)."""
    out, i, j = [], 0, 0
    while i < len(a) and j < len(b):
        lo, hi = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        if hi > lo:
            out.append((lo, hi))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return out


def union(spans, pad: float = 0.0, limit: float | None = None):
    out = []
    for a, b in sorted(spans):
        a, b = max(0.0, a - pad), b + pad
        if limit is not None:
            b = min(limit, b)
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out
