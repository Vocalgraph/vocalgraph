"""Who spoke when: pyannote 3.1's speaker-diarization pipeline, without PyTorch.

A port of pyannote.audio 3.4's SpeakerDiarization pipeline (MIT, (c) CNRS; see
THIRD_PARTY_NOTICES.md), run on ONNX exports of the same two models:

  segmentation  pyannote segmentation-3.0: in each 10 s window (1 s step), which
                of up to 3 local speakers talks in each ~17 ms frame.
  embedding     WeSpeaker ResNet34-LM: a voiceprint for each local speaker of
                each window, pooled over only the frames where they talk alone.

Checked against the PyTorch pipeline on this machine: both models' outputs
match (segmentation max diff 2e-5; voiceprints cosine 1.000000), and the
pipeline logic follows pyannote's code step for step, with the configuration
of the laptop pipeline (tensorlake/speaker-diarization-3.1 hyper-parameters,
min_cluster_size overridden to 1).

After the pipeline, its many small groups are joined into people:
  * min_turn 0.8 s: a group whose longest single turn is shorter is folded
    into the kept group it sounds most like (real speakers hold the floor at
    least once; artifacts are only fragments).
  * families: the kept groups are merged, most alike first, while the
    talk-weighted average likeness of every pair of their members is at least
    FAMILY_MERGE. An average, not a chain: a group joins a family only if it
    sounds like the family as a whole, not just like one member of it. (The
    earlier clean-up merged any two groups at least 0.35 alike, chaining, and
    with a TV and another call in the background it merged two people into
    one. Checked by ear on six recordings: two people in a room with
    background voices, two people with crosstalk, a mic + Discord call,
    two-voices.wav, and two of one person.)
  * background (only when prepare's output carries `level`, which the
    browser version's does): a family whose speech is BACKGROUND_DB or more
    quieter than the main talker's is background (a TV, a call in another
    room), given back as time spans, not as a speaker.
  * with a number of speakers given: the family who talks least goes into
    whoever they sound most like, until that many are left.
  * join turns across gaps <= 0.3 s, and number speakers by talk time.
"""
from __future__ import annotations

import functools
import math
import os
from dataclasses import dataclass

import numpy as np

from . import models
from .fbank import fbank

RATE = 16000
WINDOW, STEP = 10 * RATE, 1 * RATE          # segmentation chunks
FRAME_START, FRAME_DUR, FRAME_STEP = 0.0, 0.0619375, 0.016875   # model receptive field
NUM_FRAMES, LOCAL = 589, 3                   # frames per chunk, local speakers per chunk

# pyannote 3.1 hyper-parameters (tensorlake/speaker-diarization-3.1)
THRESHOLD = 0.7045654963945799               # centroid-linkage cosine threshold
MIN_CLUSTER_SIZE = 1                         # stock 12 deletes brief speakers (diarize.py)
MIN_EMBED_SAMPLES = 400                      # WeSpeaker's minimum input

# joining groups into people (see the top)
MIN_TURN = 0.8
FAMILY_MERGE = 0.45
JOIN_GAP = 0.3
# background: this much quieter than the main talker (90th-percentile level
# of each turn, median over the family's turns), on a LEVELS_PER_S grid
BACKGROUND_DB = 10.0
LEVELS_PER_S = 10
BACKGROUND_MIN_TURN = 0.3                    # turns shorter than this don't count towards a level

BATCH = 32

# powerset class -> (speaker 1, 2, 3) active: none, {1}, {2}, {3}, {1,2}, {1,3}, {2,3}
POWERSET = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1],
                     [1, 1, 0], [1, 0, 1], [0, 1, 1]], dtype=np.float32)


@dataclass
class Turn:
    start: float      # seconds in the analysed (trimmed) audio
    end: float
    speaker: int


@functools.cache
def _session(name: str):
    # Cached: live analysis runs both models every second, and loading one
    # costs about as much as running it. ONNX Runtime sessions are thread-safe.
    import onnxruntime as ort
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = max(1, (os.cpu_count() or 2) - 1)
    return ort.InferenceSession(models.path(name), sess_options=opts,
                                providers=["CPUExecutionProvider"])


def _closest_frame(t: float) -> int:
    return int(np.rint((t - FRAME_START - 0.5 * FRAME_DUR) / FRAME_STEP))


def _chunks(x: np.ndarray):
    """Start sample of each 10 s window, as pyannote slides them (last one padded)."""
    n = x.size
    full = (n - WINDOW) // STEP + 1 if n >= WINDOW else 0
    starts = [c * STEP for c in range(full)]
    if n < WINDOW or (n - WINDOW) % STEP > 0:
        starts.append(full * STEP)
    return starts


def _crop(x: np.ndarray, start: int) -> np.ndarray:
    out = np.zeros(WINDOW, dtype=np.float32)
    piece = x[start:start + WINDOW]
    out[:piece.size] = piece
    return out


def _aggregate(scores: np.ndarray, skip_average: bool) -> np.ndarray:
    """Overlap-add per-chunk frame scores onto one timeline (Inference.aggregate,
    no Hamming window, no warm-up, missing -> 0). scores: (chunks, 589, k)."""
    # Vectorised, bit-identical to the per-chunk loop it replaced: ufunc.at
    # applies the additions one by one in index order, which here is chunk
    # order, so every frame sums its chunks in the same order, in float32, as
    # before. (The float32 sum of float32 values is what the loop's
    # float64-then-cast produced.) Callers pass float32 or integer scores.
    num_chunks, _, k = scores.shape
    total = _closest_frame(WINDOW / RATE + (num_chunks - 1) * STEP / RATE + 0.5 * FRAME_DUR) + 1
    out = np.zeros((total, k), dtype=np.float32)
    count = np.zeros_like(out)
    seen = np.zeros_like(out)
    starts = np.array([_closest_frame(c * STEP / RATE + 0.5 * FRAME_DUR) for c in range(num_chunks)])
    rows = (starts[:, None] + np.arange(NUM_FRAMES)).ravel()             # chunk-major
    mask = (~np.isnan(scores)).astype(np.float32).reshape(-1, k)
    vals = (np.nan_to_num(scores, nan=0.0).astype(np.float32).reshape(-1, k) * mask)
    np.add.at(out, rows, vals)
    np.add.at(count, rows, mask)
    np.maximum.at(seen, rows, mask)
    avg = out if skip_average else out / np.maximum(count, 1e-12)
    avg[seen == 0.0] = 0.0
    return avg


def _segment(x, starts, say):
    seg = _session("segmentation")
    name = seg.get_inputs()[0].name
    out = []
    for i in range(0, len(starts), BATCH):
        batch = np.stack([_crop(x, s) for s in starts[i:i + BATCH]])[:, None, :]
        logp = seg.run(None, {name: batch})[0]                 # (b, 589, 7)
        out.append(POWERSET[logp.argmax(axis=-1)])            # hard multilabel
        say(0.3 * min(1.0, (i + BATCH) / len(starts)))
    return np.concatenate(out)                                  # (chunks, 589, 3)


def _embeddings(x, starts, binary, say):
    """(chunks, 3, 256) voiceprints; NaN for local speakers who never talk."""
    emb = _session("embedding")
    min_frames = math.ceil(NUM_FRAMES * MIN_EMBED_SAMPLES / WINDOW)
    clean = binary * (binary.sum(axis=2, keepdims=True) < 2)    # exclude overlapped speech
    jobs = []
    for c, s in enumerate(starts):
        for k in range(LOCAL):
            if binary[c, :, k].sum() == 0:
                continue
            mask = clean[c, :, k] if clean[c, :, k].sum() > min_frames else binary[c, :, k]
            jobs.append((c, k, s, mask))
    result = np.full((len(starts), LOCAL, 256), np.nan, dtype=np.float32)
    feats_cache = {}
    for i in range(0, len(jobs), BATCH):
        part = jobs[i:i + BATCH]
        feats = []
        for c, _, s, _ in part:
            if c not in feats_cache:
                feats_cache = {c: fbank(_crop(x, s))}           # keep just the current chunk
            feats.append(feats_cache[c])
        feats = np.stack(feats)
        pooled = math.ceil(math.ceil(math.ceil(feats.shape[1] / 2) / 2) / 2)
        # nearest-neighbour resampling of the 589-frame mask, as F.interpolate does
        idx = np.minimum(np.floor(np.arange(pooled) * (NUM_FRAMES / pooled)).astype(int), NUM_FRAMES - 1)
        weights = np.stack([m[idx] for *_, m in part]).astype(np.float32)
        vecs = emb.run(None, {"fbank": feats, "weights": weights})[0]
        for (c, k, _, _), v in zip(part, vecs):
            result[c, k] = v
        say(0.3 + 0.6 * min(1.0, (i + BATCH) / max(1, len(jobs))))
    return result


def _cluster(embeddings, binary, num_speakers):
    """pyannote's AgglomerativeClustering + assign_embeddings (unconstrained)."""
    from scipy.cluster.hierarchy import fcluster, linkage
    from scipy.spatial.distance import cdist

    active = binary.sum(axis=1) > 0
    valid = ~np.any(np.isnan(embeddings), axis=2)
    ci, si = np.where(active & valid)
    train = embeddings[ci, si]
    n = len(train)
    chunks = embeddings.shape[0]
    if n == 0:
        return np.zeros((chunks, LOCAL), dtype=np.int8), np.zeros((1, 256), dtype=np.float32)

    min_c = max(1, min(n, num_speakers or 1))
    max_c = max(1, min(n, num_speakers or n))
    target = min_c if min_c == max_c else None
    if max_c < 2:
        return np.zeros((chunks, LOCAL), dtype=np.int8), train.mean(axis=0, keepdims=True)

    min_size = min(MIN_CLUSTER_SIZE, max(1, round(0.1 * n)))
    if n == 1:
        clusters = np.zeros(1, dtype=int)
    else:
        with np.errstate(divide="ignore", invalid="ignore"):
            normed = train / np.linalg.norm(train, axis=-1, keepdims=True)
        dendro = linkage(normed, method="centroid", metric="euclidean")
        clusters = fcluster(dendro, THRESHOLD, criterion="distance") - 1
        uniq, counts = np.unique(clusters, return_counts=True)
        large = uniq[counts >= min_size]
        if len(large) < min_c:
            target = min_c
        elif len(large) > max_c:
            target = max_c
        if target is not None and len(large) != target:
            d2 = np.copy(dendro)
            d2[:, 2] = np.arange(n - 1)
            best_it, best_n = n - 1, 1
            for it in np.argsort(np.abs(dendro[:, 2] - THRESHOLD)):
                if d2[it, 3] < min_size:
                    continue
                clusters = fcluster(d2, it, criterion="distance") - 1
                u, cnt = np.unique(clusters, return_counts=True)
                nl = len(u[cnt >= min_size])
                if abs(nl - target) < abs(best_n - target):
                    best_it, best_n = it, nl
                if nl == target:
                    break
            if best_n != target:
                clusters = fcluster(d2, best_it, criterion="distance") - 1
            uniq, counts = np.unique(clusters, return_counts=True)
            large = uniq[counts >= min_size]
        if len(large) == 0:
            clusters[:] = 0
        else:
            small = uniq[counts < min_size]
            if len(small):
                lc = np.vstack([normed[clusters == k].mean(axis=0) for k in large])
                sc = np.vstack([normed[clusters == k].mean(axis=0) for k in small])
                for j, li in enumerate(np.argmin(cdist(lc, sc, metric="cosine"), axis=0)):
                    clusters[clusters == small[j]] = large[li]
            _, clusters = np.unique(clusters, return_inverse=True)

    k = int(clusters.max()) + 1
    centroids = np.vstack([train[clusters == j].mean(axis=0) for j in range(k)])
    # Inactive local speakers have no voiceprint; they are set to -2 by the
    # caller, so whatever argmax picks for them here is discarded.
    flat = np.nan_to_num(embeddings.reshape(-1, embeddings.shape[2]))
    with np.errstate(divide="ignore", invalid="ignore"):
        soft = 2 - cdist(flat, centroids, metric="cosine").reshape(chunks, LOCAL, k)
    return np.argmax(np.nan_to_num(soft, nan=-np.inf), axis=2).astype(np.int8), centroids


def _reconstruct(binary, hard, count):
    """Map local speakers to clusters and keep the `count` most active per frame.

    Same result as building each chunk's (589, clusters) activity (the max over
    the local speakers in each cluster, NaN elsewhere), overlap-adding it with
    _aggregate(skip_average=True) and ranking every frame; checked identical.
    It never builds that dense array, which before the clean-up can hold 100+
    clusters and a gigabyte for an hour: each chunk has at most LOCAL local
    speakers, so only those are added, in chunk order as before.
    """
    chunks = binary.shape[0]
    k = int(hard.max()) + 1
    total = _closest_frame(WINDOW / RATE + (chunks - 1) * STEP / RATE + 0.5 * FRAME_DUR) + 1
    act = np.zeros((total, k), dtype=np.float32)
    vals = binary.astype(np.float32)          # a copy: duplicates are merged into it
    h = hard.astype(np.intp)
    use = h != -2
    # Two local speakers of one chunk in the same cluster count once, as their max.
    for j in range(h.shape[1]):
        for i in range(j):
            dup = use[:, i] & use[:, j] & (h[:, i] == h[:, j])
            if dup.any():
                vals[dup, :, i] = np.maximum(vals[dup, :, i], vals[dup, :, j])
                use[dup, j] = False
    starts = np.array([_closest_frame(c * STEP / RATE + 0.5 * FRAME_DUR) for c in range(chunks)])
    c_idx, j_idx = np.nonzero(use)                                         # chunk-major
    rows = (starts[c_idx][:, None] + np.arange(NUM_FRAMES)).ravel()
    cols = np.repeat(h[c_idx, j_idx], NUM_FRAMES)
    np.add.at(act, (rows, cols), vals[c_idx, :, j_idx].ravel())
    top = int(count.max()) if count.size else 0
    if act.shape[1] < top:
        act = np.pad(act, ((0, 0), (0, top - act.shape[1])))
    frames = min(len(act), len(count))
    act, count = act[:frames], count[:frames]
    # Keep the count[t] highest of each frame: a column's rank in its frame's
    # order is below count[t]. Only frames with someone talking need sorting;
    # each row sorts on its own values, so ties break exactly as before.
    out = np.zeros_like(act)
    talk = np.flatnonzero(count > 0)
    if talk.size:
        order = np.argsort(-act[talk], axis=-1)
        rank = np.empty_like(order)
        np.put_along_axis(rank, order, np.broadcast_to(np.arange(order.shape[1]), order.shape), axis=1)
        out[talk] = rank < count[talk, None]
    return out


def _to_turns(discrete) -> list[tuple[float, float, int]]:
    """Binarize (onset = offset = 0.5, no padding, min_duration_off 0)."""
    stamps = FRAME_START + np.arange(len(discrete)) * FRAME_STEP + FRAME_DUR / 2
    turns = []
    n = len(discrete)
    for k in range(discrete.shape[1]):
        col = discrete[:, k]
        # On above 0.5, off below it, unchanged at exactly 0.5; the first frame
        # starts on only if above. Carry each frame's state forward, then read
        # the runs off the changes (vectorised, same turns as the frame loop).
        state = np.where(col > 0.5, 1, np.where(col < 0.5, 0, -1)).astype(np.int8)
        state[0] = 1 if col[0] > 0.5 else 0
        last = np.where(state >= 0, np.arange(n), 0)
        np.maximum.accumulate(last, out=last)
        state = state[last]
        change = np.diff(state)
        ons = np.flatnonzero(change == 1) + 1
        offs = np.flatnonzero(change == -1) + 1
        if state[0]:
            ons = np.r_[0, ons]
        for a, b in zip(ons, offs):
            turns.append((float(stamps[a]), float(stamps[b]), k))
        if state[-1]:
            turns.append((float(stamps[ons[-1]]), float(stamps[-1]), k))
    return turns


def _cosine(a, b) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))


def _finish(turns) -> list[Turn]:
    """Join a speaker's turns across short gaps; speaker 0 talks most."""
    by = {}
    for a, b, k in sorted(turns):
        by.setdefault(k, []).append([a, b])
    joined = []
    for k, ts in by.items():
        cur = ts[0]
        for a, b in ts[1:]:
            if a <= cur[1] + JOIN_GAP:
                cur[1] = max(cur[1], b)
            else:
                joined.append((cur[0], cur[1], k)); cur = [a, b]
        joined.append((cur[0], cur[1], k))
    talk = {}
    for a, b, k in joined:
        talk[k] = talk.get(k, 0.0) + b - a
    rank = {k: i for i, k in enumerate(sorted(talk, key=talk.get, reverse=True))}
    return sorted((Turn(a, b, rank[k]) for a, b, k in joined), key=lambda t: t.start)


def prepare(x: np.ndarray, progress=None) -> dict | None:
    """The slow, count-independent part: segmentation, speaker counting and
    voiceprints. Returns arrays that assign() turns into speakers in well under
    a second, for any number of speakers; None when there is no speech."""
    say = progress or (lambda frac: None)
    if x.size < RATE // 2:
        return None
    # Same samples the laptop pipeline sees (its decode goes through 16-bit),
    # which is what the frame-for-frame parity check was run on.
    x = (np.clip(np.round(x * 32768.0), -32768, 32767) / 32768.0).astype(np.float32)
    starts = _chunks(x)
    binary = _segment(x, starts, say)
    count = np.rint(_aggregate(binary.sum(axis=2, keepdims=True), skip_average=False)[:, 0]).astype(int)
    if count.max() == 0:
        return None
    emb = _embeddings(x, starts, binary, say)
    say(1.0)
    return {"binary": binary.astype(np.uint8), "count": count.astype(np.int16), "embeddings": emb}


def levels(x: np.ndarray) -> np.ndarray:
    """Loudness of 16 kHz audio in dB (RMS), LEVELS_PER_S values a second:
    what tells background voices apart. Add it to prepare()'s output as
    "level" for assign() and group() to mark background."""
    hop = RATE // LEVELS_PER_S
    n = len(x) // hop
    blocks = np.asarray(x[:n * hop], dtype=np.float64).reshape(n, hop)
    return (20 * np.log10(np.sqrt((blocks * blocks).mean(axis=1)) + 1e-9)).astype(np.float32)


def _unit(v):
    v = np.asarray(v, dtype=np.float64)
    n = math.sqrt(float(np.dot(v, v)))
    return v / n if n > 0 else None


def _families(turns, centroids):
    """The grouping's groups joined into families (see the top). Returns the
    turns labelled by family, and each family's voiceprint: the talk-weighted
    sum of its members' unit voiceprints (None when none has one)."""
    labels = sorted({k for *_, k in turns})
    talk = {k: 0.0 for k in labels}
    longest = {k: 0.0 for k in labels}
    for a, b, k in turns:
        talk[k] += b - a
        longest[k] = max(longest[k], b - a)
    unit = {k: _unit(centroids[k]) if k < len(centroids) else None for k in labels}
    keep = [k for k in labels if longest[k] >= MIN_TURN] or [max(labels, key=talk.get)]
    fam = {k: [k] for k in keep}
    for k in labels:
        if k in fam:
            continue
        cands = [o for o in keep if unit[o] is not None and unit[k] is not None]
        target = (max(cands, key=lambda o: float(np.dot(unit[k], unit[o]))) if cands
                  else max(keep, key=talk.get))
        fam[target].append(k)

    def weight(f):
        return sum(talk[m] for m in fam[f])

    def likeness(f, g):
        num = den = 0.0
        for a in fam[f]:
            for b in fam[g]:
                if unit[a] is not None and unit[b] is not None:
                    w = talk[a] * talk[b]
                    num += w * float(np.dot(unit[a], unit[b]))
                    den += w
        return num / den if den > 0 else -math.inf

    while len(fam) > 1:
        names = sorted(fam)
        f, g = max(((p, q) for i, p in enumerate(names) for q in names[i + 1:]), key=lambda pq: likeness(*pq))
        if likeness(f, g) < FAMILY_MERGE:
            break
        big, small = (f, g) if weight(f) >= weight(g) else (g, f)
        fam[big] += fam.pop(small)
    root = {m: f for f, ms in fam.items() for m in ms}
    vec = {}
    for f, ms in fam.items():
        parts = [unit[m] * talk[m] for m in ms if unit[m] is not None]
        vec[f] = np.sum(parts, axis=0) if parts else None
    return [(a, b, root[k]) for a, b, k in turns], vec


def _background(turns, level) -> set:
    """Families BACKGROUND_DB or more quieter than the one who talks most."""
    if level is None or not len(level):
        return set()
    level = np.asarray(level, dtype=np.float64)
    spans: dict[int, list] = {}
    for a, b, f in turns:
        spans.setdefault(f, []).append((a, b))

    def loud(f):
        vals = []
        for a, b in spans[f]:
            if b - a < BACKGROUND_MIN_TURN:
                continue
            seg = level[int(a * LEVELS_PER_S):int(math.ceil(b * LEVELS_PER_S))]
            if len(seg):
                vals.append(float(np.percentile(seg, 90)))
        return float(np.median(vals)) if vals else None
    names = sorted(spans)
    talk = {f: sum(b - a for a, b in spans[f]) for f in names}
    main = max(names, key=talk.get)
    top = loud(main)
    if top is None:
        return set()
    out = set()
    for f in names:
        lv = loud(f) if f != main else None
        if lv is not None and lv <= top - BACKGROUND_DB:
            out.add(f)
    return out


def _join(spans) -> list[tuple[float, float]]:
    """Spans joined across gaps <= JOIN_GAP, in order."""
    out = []
    for a, b in sorted(spans):
        if out and a <= out[-1][1] + JOIN_GAP:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def _fold(turns, vec, n: int):
    """Merge speakers until there are n: each time, the one who talks least
    goes into whoever they sound most like (vec: talk-weighted voiceprints,
    summed as they merge)."""
    talk: dict[int, float] = {}
    for a, b, k in turns:
        talk[k] = talk.get(k, 0.0) + b - a
    vec = {k: vec.get(k) for k in talk}
    into = {}
    live = sorted(talk)
    while len(live) > n:
        small = min(live, key=talk.get)
        others = [o for o in live if o != small]
        cands = [o for o in others if vec[o] is not None and vec[small] is not None]
        target = (max(cands, key=lambda o: _cosine(vec[small], vec[o])) if cands
                  else max(others, key=talk.get))
        into[small] = target
        talk[target] += talk[small]
        if vec[target] is not None and vec[small] is not None:
            vec[target] = vec[target] + vec[small]
        live.remove(small)

    def resolve(k):
        while k in into:
            k = into[k]
        return k
    return [(a, b, resolve(k)) for a, b, k in turns]


def group(prep: dict | None, num_speakers: int | None = None) -> tuple[list[Turn], list[tuple[float, float]]]:
    """Speaker turns from prepare()'s output, largest talker first (speaker
    0), and the background's time spans (empty unless prep has "level").

    With num_speakers given: the grouping runs as if the count were unknown,
    then the speakers who talk least are merged into whoever they sound most
    like until that many are left. Only if it found fewer is the grouping
    asked to split into that many. (Asking it for the count directly makes it
    cut its tree at that many branches, and on a call recording that merged
    the two real people and kept a few seconds of crosstalk as the second
    "speaker": 62% of speech right, against 94%.)"""
    if prep is None:
        return [], []
    binary = prep["binary"].astype(np.float32)
    count = prep["count"].astype(int)
    chunks = binary.shape[0]
    if num_speakers == 1:
        hard = np.zeros((chunks, LOCAL), dtype=np.int8)
        hard[binary.sum(axis=1) == 0] = -2
        return _finish(_to_turns(_reconstruct(binary, hard, np.minimum(count, 1)))), []
    hard, centroids = _cluster(prep["embeddings"], binary, None)
    hard[binary.sum(axis=1) == 0] = -2
    turns, vec = _families(_to_turns(_reconstruct(binary, hard, count)), centroids)
    bg = _background(turns, prep.get("level"))
    back = [(a, b) for a, b, f in turns if f in bg]
    turns = [t for t in turns if t[2] not in bg]
    found = len({k for *_, k in turns})
    if num_speakers and found > num_speakers:
        turns = _fold(turns, vec, num_speakers)
    elif num_speakers and found < num_speakers:
        hard, _ = _cluster(prep["embeddings"], binary, num_speakers)
        hard[binary.sum(axis=1) == 0] = -2
        turns = _to_turns(_reconstruct(binary, hard, np.minimum(count, num_speakers)))
        back = []
    return _finish(turns), _join(back)


def assign(prep: dict | None, num_speakers: int | None = None) -> list[Turn]:
    """group()'s speaker turns."""
    return group(prep, num_speakers)[0]


def diarize(x: np.ndarray, num_speakers: int | None = None, progress=None) -> list[Turn]:
    """prepare() then assign(): speaker turns for 16 kHz mono audio."""
    return assign(prepare(x, progress), num_speakers)
