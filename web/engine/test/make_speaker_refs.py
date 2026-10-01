"""Reference data for the speaker engine's parity tests (speakers.test.mjs,
sources.test.mjs, fbank inside the prepare test).

Run with the app's venv from the repo root:

    .venv/Scripts/python.exe web/engine/test/make_speaker_refs.py [OUT_DIR]

It reads the user's library (never writes to it) and writes everything to
OUT_DIR (default %LOCALAPPDATA%/Temp/vstage/engine-refs, or VOCALGRAPH_SPEAKER_REFS).
The files are made from personal recordings: keep them out of the repository.

  <id>/binary.u8 count.i16 emb.f32 meta.json   prepare() outputs (speakers.npz)
  <id>/assign.json                              assign(prep, n), n in None,1..4
  <id>/level.f32 group.json                     levels() of the analysed audio; group(prep + level, n)
  <id>/dendro.f64 fcluster.i32 centroids.f32 hard.i8   _cluster internals
  prepare/...                                   model I/O of one prepare() run
  sources/...                                   decoded streams + sources.py results
"""
from __future__ import annotations

import glob
import json
import os
import sys

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)

from vocalgraph import core, sources, speakers  # noqa: E402
from vocalgraph.fbank import fbank  # noqa: E402
from vocalgraph.timeline import Timeline, concat  # noqa: E402

LIBRARY = os.environ.get("VOCALGRAPH_LIBRARY") or os.path.join(ROOT, "library")
OUT = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VOCALGRAPH_SPEAKER_REFS")
       or os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "Temp", "vstage", "engine-refs"))
PREPARE_ID = "f8e05fee4d26"      # two-voices.wav, 75 s
SOURCES_ID = "f1c23ba0b1b4"      # 4-minute call: mix, mic, Discord


def save(path, arr, dtype):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    np.ascontiguousarray(arr, dtype=dtype).tofile(path)


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, default=lambda o: o.item() if hasattr(o, "item") else o.tolist())


def load_job(rid):
    with open(os.path.join(LIBRARY, rid, "job.json"), encoding="utf-8-sig") as fh:
        return json.load(fh)


def turns_json(turns):
    return [[t.start, t.end, t.speaker] for t in turns]


def library_refs():
    from scipy.cluster.hierarchy import fcluster, linkage
    ids = []
    for npz in sorted(glob.glob(os.path.join(LIBRARY, "*", "speakers.npz"))):
        rid = os.path.basename(os.path.dirname(npz))
        d = os.path.join(OUT, rid)
        with np.load(npz) as z:
            prep = {k: z[k] for k in ("binary", "count", "embeddings")}
        save(os.path.join(d, "binary.u8"), prep["binary"], np.uint8)
        save(os.path.join(d, "count.i16"), prep["count"], np.int16)
        save(os.path.join(d, "emb.f32"), prep["embeddings"], np.float32)
        dump(os.path.join(d, "assign.json"),
             {str(n): turns_json(speakers.assign(prep, n)) for n in (None, 1, 2, 3, 4)})
        # Loudness of the audio the speaker step analysed (the kept stretches
        # joined, or the whole of a live recording), and group() with it.
        job = load_job(rid)
        x = core.decode(os.path.join(LIBRARY, rid, job["input_file"]))
        segs = job.get("prep_segments")
        level = speakers.levels(concat(x, segs) if segs else x)
        frames_s = prep["count"].shape[0] * speakers.FRAME_STEP
        if abs(frames_s - len(level) / speakers.LEVELS_PER_S) > 2:
            print(rid, f"level covers {len(level) / speakers.LEVELS_PER_S:.1f} s, the speaker step {frames_s:.1f} s: skipped")
        else:
            save(os.path.join(d, "level.f32"), level, np.float32)
            with_level = dict(prep, level=level)
            dump(os.path.join(d, "group.json"),
                 {str(n): {"turns": turns_json(g[0]), "background": g[1]}
                  for n in (None, 1, 2, 3, 4) for g in [speakers.group(with_level, n)]})
        # the clustering's internals, for a direct comparison
        binary = prep["binary"].astype(np.float32)
        emb = prep["embeddings"]
        active = binary.sum(axis=1) > 0
        valid = ~np.any(np.isnan(emb), axis=2)
        ci, si = np.where(active & valid)
        train = emb[ci, si]
        normed = train / np.linalg.norm(train, axis=-1, keepdims=True)
        dendro = linkage(normed, method="centroid", metric="euclidean")
        save(os.path.join(d, "dendro.f64"), dendro, np.float64)
        save(os.path.join(d, "fcluster.i32"), fcluster(dendro, speakers.THRESHOLD, criterion="distance"), np.int32)
        hard, centroids = speakers._cluster(emb, binary, None)
        save(os.path.join(d, "centroids.f32"), centroids, np.float32)
        save(os.path.join(d, "hard.i8"), hard, np.int8)
        dump(os.path.join(d, "meta.json"), {"chunks": prep["binary"].shape[0], "frames": prep["count"].shape[0],
                                            "train": len(train), "clusters": len(centroids)})
        ids.append(rid)
        print(rid, prep["binary"].shape, "train", len(train), "clusters", len(centroids))
    return ids


class Recorder:
    """Wraps an ONNX session, keeping every input and output it sees."""

    def __init__(self, sess):
        self.sess, self.calls = sess, []

    def get_inputs(self):
        return self.sess.get_inputs()

    def run(self, names, feeds):
        out = self.sess.run(names, feeds)
        self.calls.append(({k: np.array(v) for k, v in feeds.items()}, out[0]))
        return out


def prepare_refs():
    d = os.path.join(OUT, "prepare")
    job = load_job(PREPARE_ID)
    x = core.decode(os.path.join(LIBRARY, PREPARE_ID, job["input_file"]))
    save(os.path.join(d, "x.f32"), x, np.float32)
    real = speakers._session
    rec = {name: Recorder(real(name)) for name in ("segmentation", "embedding")}
    speakers._session = lambda name: rec[name]
    try:
        prep = speakers.prepare(x)
    finally:
        speakers._session = real
    seg_in = np.concatenate([f[next(iter(f))] for f, _ in rec["segmentation"].calls])[:, 0, :]
    seg_out = np.concatenate([o for _, o in rec["segmentation"].calls])
    fb = np.concatenate([f["fbank"] for f, _ in rec["embedding"].calls])
    w = np.concatenate([f["weights"] for f, _ in rec["embedding"].calls])
    emb_out = np.concatenate([o for _, o in rec["embedding"].calls])
    save(os.path.join(d, "seg_in.f32"), seg_in, np.float32)
    save(os.path.join(d, "seg_out.f32"), seg_out, np.float32)
    save(os.path.join(d, "emb_fbank.f32"), fb, np.float32)
    save(os.path.join(d, "emb_weights.f32"), w, np.float32)
    save(os.path.join(d, "emb_out.f32"), emb_out, np.float32)
    # prepare.js adds the loudness of the samples it analyses (rounded to 16-bit)
    save(os.path.join(d, "level.f32"),
         speakers.levels((np.clip(np.round(x * 32768.0), -32768, 32767) / 32768.0).astype(np.float32)), np.float32)
    save(os.path.join(d, "binary.u8"), prep["binary"], np.uint8)
    save(os.path.join(d, "count.i16"), prep["count"], np.int16)
    save(os.path.join(d, "emb.f32"), prep["embeddings"], np.float32)
    dump(os.path.join(d, "meta.json"), {
        "samples": x.size, "windows": seg_in.shape[0], "jobs": fb.shape[0], "fbank_frames": fb.shape[1],
        "chunks": prep["binary"].shape[0], "frames": prep["count"].shape[0],
        "fbank_selfcheck": float(np.abs(fbank(seg_in[0]) - fb[0]).max())})
    print("prepare", seg_in.shape, fb.shape)


def sources_refs():
    d = os.path.join(OUT, "sources")
    job = load_job(SOURCES_ID)
    path = os.path.join(LIBRARY, SOURCES_ID, job["input_file"])
    names = core.audio_streams(path)
    streams = [core.decode(path, stream=i) for i in range(len(names))]
    for i, s in enumerate(streams):
        save(os.path.join(d, f"stream{i}.f32"), s, np.float32)
    # server._track_activity, step by step
    mix = sources.levels(streams[0], core.RATE)
    tracks = [sources.levels(s, core.RATE) for s in streams[1:]]
    n = min(len(mix), *(len(t) for t in tracks))
    lags = [sources.lag(mix, t) for t in tracks]
    lev = np.stack([sources.shift(t[:n], L) for t, L in zip(tracks, lags)])
    thr = [sources.threshold(t) for t in lev]
    act = sources.activity(list(lev))
    save(os.path.join(d, "levels0.f64"), mix, np.float64)
    for i, t in enumerate(tracks):
        save(os.path.join(d, f"levels{i + 1}.f64"), t, np.float64)
    save(os.path.join(d, "lev.f64"), lev, np.float64)
    save(os.path.join(d, "act.u8"), act, np.uint8)
    # server._assign: the grouping's turns in source time, then refine
    with np.load(os.path.join(LIBRARY, SOURCES_ID, "speakers.npz")) as z:
        prep = {k: z[k] for k in ("binary", "count", "embeddings")}
    tl = Timeline([tuple(s) for s in job["prep_segments"]])
    result = {"names": names, "lags": lags, "thresholds": thr, "n": n, "frames": act.shape[0], "cases": {}}
    for ns in (None, 2, 3):
        turns = speakers.assign(prep, ns)
        new = [(s, e, t.speaker) for t in turns for s, e in tl.to_source(t.start, t.end)]
        home, own = sources.homes(new, act)
        refined, homes = sources.refine(new, act)
        until = sources.refine(new, act, until=120.0)
        result["cases"][str(ns)] = {
            "input": new, "home": list(home.items()), "own": list(own.items()),
            "refined": refined, "homes": list(homes.items()),
            "until120": until[0], "until120_homes": list(until[1].items())}
    dump(os.path.join(d, "result.json"), result)
    print("sources", names, lags, thr, act.shape)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    ids = library_refs()
    prepare_refs()
    sources_refs()
    dump(os.path.join(OUT, "index.json"), {"recordings": ids, "prepare": PREPARE_ID, "sources": SOURCES_ID})
    print("refs in", OUT)
