"""Speakers on their own inputs: a recording made from several inputs (say a
microphone and a call app) keeps each input as a track of its own, next to
the mix. When the voice grouping finds that one speaker's speech comes almost
entirely from one input, and that input carries nobody else, that input is
theirs, and:

  * their turns are read off their own track, so when two people talk at once
    both are marked, which the grouping on the mix mostly misses;
  * their audio (the per-speaker download) is cut from their own track, with
    nobody else in it;
  * their voice is measured on their own track, so another voice at the same
    moment doesn't mix into their pitch.

A speaker who shares an input with others (two people at one microphone) is
still measured and cut from that input, which at least leaves out the other
inputs; their turns stay the grouping's.

Checked on a call recorded from a microphone and Discord (4 min): the two
tracks put 11 s of the speech as both talking at once; the grouping on the mix
had marked a quarter of that.
"""
from __future__ import annotations

import numpy as np

HOP = 0.02            # seconds per level reading
HOME_SHARE = 0.8      # of a speaker's solo speech on one input, to call it theirs
OWN_SHARE = 0.8       # of an input's solo activity that must be that speaker's
MIN_EVIDENCE = 3.0    # seconds of solo speech needed to decide
JOIN = 0.3            # join a track's activity across gaps this short
MIN_RUN = 0.2         # and drop bursts shorter than this
SPEECH_PAD = 0.3      # activity counts only this near speech the grouping found


def levels(x: np.ndarray, rate: int) -> np.ndarray:
    """Loudness (dB RMS) of each HOP of 16 kHz mono audio."""
    n = int(HOP * rate)
    usable = (x.size // n) * n
    frames = x[:usable].reshape(-1, n).astype(np.float64)
    return 20 * np.log10(np.sqrt(np.mean(frames * frames, axis=1)) + 1e-10)


def lag(mix: np.ndarray, track: np.ndarray, most: float = 0.5) -> float:
    """How much earlier `track` runs than the mix it went into, in seconds
    (levels of each, per HOP): its sound at t is the mix's at t + lag.
    Recordings made live before the tracks were lined up with the mix have
    a program's track some tens of ms off; found by lining up their levels."""
    n = min(mix.size, track.size)
    a, b = np.maximum(mix[:n], -80.0), np.maximum(track[:n], -80.0)
    span = int(most / HOP)
    best, score = 0, -np.inf
    for L in range(-span, span + 1):
        x, y = a[max(0, L):n + min(0, L)], b[max(0, -L):n - max(0, L)]
        if x.size < 50 or x.std() == 0 or y.std() == 0:
            continue
        c = float(np.corrcoef(x, y)[0, 1])
        if c > score:
            best, score = L, c
    return best * HOP


def shift(levels_: np.ndarray, by: float) -> np.ndarray:
    """Levels moved `by` seconds later (earlier if negative), filled with quiet."""
    k = int(round(by / HOP))
    out = np.full(levels_.shape, -200.0)
    if k >= 0:
        out[k:] = levels_[:levels_.size - k] if k else levels_
    else:
        out[:k] = levels_[-k:]
    return out


def threshold(db: np.ndarray) -> float:
    """Where speech on a track starts: well above its quiet, and within 35 dB
    of its loudest (a noise-suppressed call sits at -100 dB between words, a
    room microphone at -50)."""
    if not db.size:
        return 0.0
    return float(max(np.percentile(db, 10) + 15, np.percentile(db, 99) - 35, -75))


def activity(tracks: list[np.ndarray], thresholds: list[float] | None = None) -> np.ndarray:
    """(frames, inputs) bool: who is making sound, per HOP."""
    n = min(len(t) for t in tracks)
    thr = thresholds or [threshold(t) for t in tracks]
    return np.stack([t[:n] > th for t, th in zip(tracks, thr)], axis=1)


def _grid(spans, n: int) -> np.ndarray:
    m = np.zeros(n, dtype=bool)
    for a, b in spans:
        lo, hi = max(0, int(a / HOP)), min(n, int(np.ceil(b / HOP)))
        if hi > lo:
            m[lo:hi] = True
    return m


def _runs(mask: np.ndarray, t0: float = 0.0):
    """Runs of True as (start, end) seconds, joined across JOIN, without
    bursts under MIN_RUN."""
    edges = np.flatnonzero(np.diff(np.r_[0, mask.astype(np.int8), 0]))
    runs = []
    for a, b in zip(edges[::2], edges[1::2]):
        s, e = t0 + a * HOP, t0 + b * HOP
        if runs and s - runs[-1][1] <= JOIN:
            runs[-1][1] = e
        else:
            runs.append([s, e])
    return [(s, e) for s, e in runs if e - s >= MIN_RUN]


def homes(turns, act: np.ndarray) -> tuple[dict[int, int], dict[int, int]]:
    """({speaker: input}, {input: speaker}): each speaker's input, where one
    clearly carries their speech, and the inputs that carry only one speaker
    (theirs alone)."""
    n, inputs = act.shape
    ids = sorted({k for *_, k in turns})
    grids = {k: _grid([(a, b) for a, b, kk in turns if kk == k], n) for k in ids}
    anyone = np.zeros(n, dtype=int)
    for g in grids.values():
        anyone += g
    alone = act.sum(axis=1) == 1                        # exactly one input sounding
    which = np.argmax(act, axis=1)
    home: dict[int, int] = {}
    for k in ids:
        solo = grids[k] & (anyone == 1) & alone
        if solo.sum() * HOP < MIN_EVIDENCE:
            continue
        share = np.bincount(which[solo], minlength=inputs) / solo.sum()
        if share.max() >= HOME_SHARE:
            home[k] = int(share.argmax())
    own: dict[int, int] = {}
    for i in range(inputs):
        mine = [k for k, h in home.items() if h == i]
        if len(mine) != 1:
            continue
        solo_here = alone & (which == i) & (anyone >= 1)
        if solo_here.sum() and (solo_here & grids[mine[0]]).sum() / solo_here.sum() >= OWN_SHARE:
            own[i] = mine[0]
    return home, own


def refine(turns, act: np.ndarray, until: float | None = None):
    """The grouping's turns with speakers on inputs of their own re-read from
    those tracks. Returns (turns, homes): turns as (start, end, speaker), and
    {speaker: input} for each speaker whose speech is on one input.

    Only up to `until` seconds, if given (live: as far as the grouping has
    got). A speaker on no input of their own keeps their turns, less what the
    speakers with their own input cover (that is crosstalk the grouping
    couldn't place); if nothing of a turn at least MIN_TURN long is left, they
    go."""
    from .speakers import MIN_TURN
    if act.ndim != 2 or act.shape[1] < 2 or not turns:
        return list(turns), {}
    n = act.shape[0] if until is None else min(act.shape[0], int(until / HOP))
    act = act[:n]
    home, own = homes(turns, act)
    if not own:
        return list(turns), home
    speech = _grid([(a - SPEECH_PAD, b + SPEECH_PAD) for a, b, _ in turns], n)
    out = []
    owned = np.zeros(n, dtype=bool)
    for i, k in own.items():
        runs = _runs(act[:, i] & speech)
        out += [(a, b, k) for a, b in runs]
        owned |= _grid(runs, n)
    mine = set(own.values())
    for k in sorted({k for *_, k in turns} - mine):
        rest = _grid([(a, b) for a, b, kk in turns if kk == k], n) & ~owned
        pieces = _runs(rest)
        if pieces and max(b - a for a, b in pieces) >= MIN_TURN:
            out += [(a, b, k) for a, b in pieces]
        elif k in home:
            home.pop(k)
    left = {k for *_, k in out}
    return sorted(out), {k: h for k, h in home.items() if k in left}
