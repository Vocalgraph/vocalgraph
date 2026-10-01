"""Reference data for the JavaScript engine's parity tests (web/engine/test).

Runs the Python app's own functions on the library's recordings and on
generated cases, and writes what they give to a folder OUTSIDE the repo (the
recordings are personal): the decoded samples, fresh analyses, timeline cases,
voice metrics, live-frame measures and offsets.

    .venv/Scripts/python.exe web/engine/test/make_refs.py [--refs DIR] [--library DIR]

The library is only read.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)

from vocalgraph import core, live, voice  # noqa: E402
from vocalgraph.timeline import Timeline, concat, intersect, union  # noqa: E402

DEFAULT_REFS = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")),
                            "Temp", "vstage", "engine-refs-analysis")
VOICE_RECORDINGS = ("f8e05fee4d26", "f1c23ba0b1b4")
MEASURE_RECORDINGS = ("f1c23ba0b1b4", "4ebeb43b0794")


def dump(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, default=lambda o: o.item() if hasattr(o, "item") else o.tolist())


def load_job(folder):
    with open(os.path.join(folder, "job.json"), encoding="utf-8-sig") as fh:
        job = json.load(fh)
    job["homes"] = {int(k): v for k, v in (job.get("homes") or {}).items()}
    job["input"] = os.path.join(folder, job["input_file"])
    return job


def out_segments(folder, job):
    with open(os.path.join(folder, job["output"]["segments_file"]), encoding="utf-8") as fh:
        return [(s["start"], s["end"]) for s in json.load(fh)]


def analyses(lib, refs, only=None):
    for rid in sorted(os.listdir(lib)):
        folder = os.path.join(lib, rid)
        if not os.path.isfile(os.path.join(folder, "job.json")) or (only and rid not in only):
            continue
        job = load_job(folder)
        os.makedirs(os.path.join(refs, rid), exist_ok=True)
        x = core.decode(job["input"])
        x.astype("<f4").tofile(os.path.join(refs, rid, "samples.f32"))
        t0 = time.perf_counter()
        a = core.analyze(job["input"])
        took = time.perf_counter() - t0
        assert np.array_equal(a.x, x)
        d = a.to_dict()
        d["python_seconds"] = took
        dump(os.path.join(refs, rid, "analysis_fresh.json"), d)
        print(f"{rid}: analysis {took:.1f}s, chosen {a.chosen}")


def timeline_cases(refs, count=400, seed=7):
    rng = np.random.default_rng(seed)
    cases = []
    for c in range(count):
        n = int(rng.integers(0, 12))
        # Sorted, non-overlapping segments; sometimes on a 10 ms grid, so
        # boundaries meet exactly.
        grid = c % 3 == 0
        cuts = np.sort(rng.random(2 * n) * 60)
        if grid:
            cuts = np.round(cuts, 2)
        segs = [(float(cuts[2 * i]), float(cuts[2 * i + 1])) for i in range(n)]
        tl = Timeline(segs)
        queries = []
        for _ in range(8):
            a, b = sorted(rng.random(2) * (tl.total + 5) - 1)
            queries.append((float(a), float(b)))
        queries += [(0.0, tl.total), (tl.total, tl.total + 1)]
        if tl.offsets:
            queries.append((tl.offsets[-1], tl.total))
        src_q = [tuple(sorted(map(float, rng.random(2) * 70 - 2))) for _ in range(8)] + [(0.0, 60.0)]
        pts = list(map(float, rng.random(40) * (tl.total + 4) - 2)) + list(tl.offsets) + [tl.total, -0.0, float("nan")]
        spts = list(map(float, rng.random(40) * 64 - 2)) + [a for a, _ in segs] + [b for _, b in segs] + [float("nan")]
        other = sorted(map(float, rng.random(2 * int(rng.integers(0, 10))) * 60))
        other = [(other[2 * i], other[2 * i + 1]) for i in range(len(other) // 2)]
        spans = [tuple(sorted(map(float, rng.random(2) * 60))) for _ in range(int(rng.integers(0, 15)))]
        pad = float(rng.choice([0.0, 0.05, 0.3]))
        limit = None if c % 2 else float(rng.random() * 70)
        nan = lambda v: [None if np.isnan(x) else float(x) for x in v]
        cases.append({
            "segs": segs, "queries": queries, "src_queries": src_q,
            "points": nan(pts), "src_points": nan(spts), "other": other, "spans": spans,
            "pad": pad, "limit": limit,
            "to_source": [tl.to_source(a, b) for a, b in queries],
            "from_source": [tl.from_source(a, b) for a, b in src_q],
            "points_to_source": nan(tl.points_to_source(np.array(pts))),
            "points_from_source": nan(tl.points_from_source(np.array(spts))),
            "intersect": intersect(segs, other),
            "union": union(spans, pad, limit),
            "offsets": tl.offsets, "total": tl.total,
        })
    # concat: on a ramp, so the result shows exactly which samples were taken.
    ramp = np.arange(16000 * 4, dtype=np.float32)
    concat_cases = []
    for _ in range(30):
        cuts = np.sort(rng.random(2 * int(rng.integers(0, 6))) * 4.2)
        segs = [(float(cuts[2 * i]), float(cuts[2 * i + 1])) for i in range(len(cuts) // 2)]
        out = concat(ramp, segs)
        runs = []   # the output as runs of consecutive sample indices
        for v in out.astype(int):
            if runs and runs[-1][1] == v:
                runs[-1][1] = v + 1
            else:
                runs.append([int(v), int(v) + 1])
        concat_cases.append({"segs": segs, "length": int(out.size), "runs": runs})
    dump(os.path.join(refs, "timeline_cases.json"), {"cases": cases, "concat": concat_cases,
                                                      "ramp_length": int(ramp.size)})
    print(f"timeline: {len(cases)} cases, {len(concat_cases)} concat cases")


def voice_cases(lib, refs):
    for rid in VOICE_RECORDINGS:
        folder = os.path.join(lib, rid)
        job = load_job(folder)
        o = job["output"]
        segs_out = out_segments(folder, job)
        streams = {0: core.decode(job["input"])}
        cases = []
        for spk in sorted({k for *_, k in job["turns"]}):
            turns = sorted((s, e) for s, e, k in job["turns"] if k == spk)
            home = job["homes"].get(spk)
            lags = job.get("track_lags") or []
            # As server.speaker_voice does for a recording without usable voice
            # frames: the speaker's own track if they have one, else the mix.
            if home is None:
                stream, mine = 0, turns
            else:
                stream = home + 1
                lag = float(lags[home]) if home < len(lags) else 0.0
                mine = [(max(0.0, a - lag), b - lag) for a, b in turns]
            if stream not in streams:
                streams[stream] = core.decode(job["input"], stream=stream)
                streams[stream].astype("<f4").tofile(os.path.join(refs, rid, f"samples-s{stream}.f32"))
            x = concat(streams[stream], mine)
            # Python openSMILE's own frames for this speech, so the JS test can
            # also check the engine on exactly these (the WebAssembly build can
            # differ from the native one by a float32 rounding on a few frames).
            frame = voice.smile().process_signal(voice.to_16bit(x)[None, :], core.RATE)
            frame[list(voice.COLUMNS)].to_numpy(dtype=np.float32).astype("<f4").tofile(
                os.path.join(refs, rid, f"pyframes-{spk}.f32"))
            np.concatenate([frame.index.get_level_values(k).total_seconds().to_numpy() for k in ("start", "end")]
                           ).astype("<f8").tofile(os.path.join(refs, rid, f"pyframes-{spk}-times.f64"))
            own, trimmed = Timeline(turns), Timeline(segs_out)
            for variant, kw in (("place", {"gate": False, "points": voice.MAX_POINTS}),
                                ("place-gated-p3624", {"gate": True, "points": 3624}),
                                ("joined", {"gate": False}), ("joined-gated", {"gate": True})):
                t0 = time.perf_counter()
                if variant.startswith("place"):
                    data = voice.metrics(x, kw["gate"],
                                         place=lambda t: trimmed.points_from_source(own.points_to_source(t)),
                                         timeline_duration=o["duration"], points=kw["points"])
                else:
                    data = voice.metrics(x, kw["gate"])
                took = time.perf_counter() - t0
                cases.append({"speaker": spk, "variant": variant, "stream": stream, "mine": mine,
                              "own": turns, "trimmed": segs_out, "timeline_duration": o["duration"],
                              **kw, "python_seconds": took, "expected": data})
                print(f"{rid} speaker {spk} {variant}: {took:.2f}s")
        dump(os.path.join(refs, rid, "voice_cases.json"), cases)


def measure_cases(lib, refs):
    for rid in MEASURE_RECORDINGS:
        folder = os.path.join(lib, rid)
        job = load_job(folder)
        o = job["output"]
        segs_out = out_segments(folder, job)
        os.makedirs(os.path.join(refs, rid), exist_ok=True)
        with np.load(os.path.join(folder, "voice_frames.npz")) as z:
            names = list(z.files)
            for k in names:
                z[k].astype("<f8").tofile(os.path.join(refs, rid, f"vframes-{k}.f64"))
            src = (z["src"], z["prim"]) if "src" in names else None
            frames = (z["t"], {k: z[k] for k in names if k not in ("t", "src", "prim")}, src)
        trimmed = Timeline(segs_out)
        cases = []
        speakers = sorted({k for *_, k in job["turns"]})
        for spk in speakers + ["all"]:
            if spk == "all":
                turns = [(a, b) for a, b, _ in live._join([(a, b, 0) for a, b, _ in job["turns"]], 0.0)]
                home = None
            else:
                turns = sorted((s, e) for s, e, k in job["turns"] if k == spk)
                home = job["homes"].get(spk)
            t, raw = live.frames_of(frames, home)
            for gate, points in ((False, voice.MAX_POINTS), (True, 3624), (False, 40000)):
                data = live.measure(t, raw, turns, gate, trimmed.points_from_source, o["duration"], points)
                cases.append({"speaker": spk, "home": home, "turns": turns, "gate": gate, "points": points,
                              "trimmed": segs_out, "duration": o["duration"], "expected": data})
        dump(os.path.join(refs, rid, "measure_cases.json"), {"files": names, "cases": cases})
        print(f"{rid}: {len(cases)} measure cases")


def span_cases(refs, seed=11):
    """_join, _overlap, _inside on random spans."""
    rng = np.random.default_rng(seed)
    cases = []
    for c in range(300):
        turns = [(float(a), float(a + rng.random() * 3), int(rng.integers(0, 4)))
                 for a in rng.random(int(rng.integers(0, 25))) * 60]
        if c % 4 == 0:
            turns = [(round(a, 2), round(b, 2), k) for a, b, k in turns]
        gap = float(rng.choice([0.0, 0.3, 1.0]))
        joined = live._join(turns, gap)
        a = [(s, e) for s, e, k in live._join(turns, 0.0) if k == 0]
        b = [(s, e) for s, e, k in live._join(turns, 0.0) if k == 1]
        t = np.concatenate([rng.random(50) * 62 - 1, [s for s, _ in a], [e for _, e in a]])
        cases.append({"turns": turns, "gap": gap, "join": joined, "a": a, "b": b,
                      "overlap": live._overlap(a, b), "t": t.tolist(),
                      "inside": live._inside(t, a).astype(int).tolist()})
    dump(os.path.join(refs, "span_cases.json"), cases)
    print(f"spans: {len(cases)} cases")


def offset_cases(lib, refs, seed=3):
    """live.offset_of on a live stream and a 'saved' copy with a lead-in."""
    rng = np.random.default_rng(seed)
    job = load_job(os.path.join(lib, "f1c23ba0b1b4"))
    base = voice.to_16bit(core.decode(job["input"], duration=40.0))
    cases = []
    for i, (lead, secs) in enumerate(((0, 30.0), (341, 30.0), (1024, 30.0), (5000, 10.0), (341, 0.5))):
        noise = (rng.normal(0, 1e-4, lead)).astype(np.float32)
        saved = np.concatenate([noise, base])[:int(31.0 * core.RATE)].astype(np.float32)
        x = base[:int(35 * core.RATE)]
        orig = live.core.decode
        live.core.decode = lambda path, duration=None, stream=0: saved[:int(duration * core.RATE)] if duration else saved
        try:
            off = live.offset_of("unused", x, secs)
        finally:
            live.core.decode = orig
        saved.astype("<f4").tofile(os.path.join(refs, f"offset-{i}-saved.f32"))
        x.astype("<f4").tofile(os.path.join(refs, f"offset-{i}-live.f32"))
        cases.append({"i": i, "lead": lead, "seconds": secs, "expected": off})
        print(f"offset case {i}: lead {lead} -> {off}")
    dump(os.path.join(refs, "offset_cases.json"), cases)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--refs", default=DEFAULT_REFS)
    p.add_argument("--library", default=os.path.join(ROOT, "library"))
    p.add_argument("--only", nargs="*", help="steps: analysis timeline voice measure spans offset")
    args = p.parse_args()
    os.makedirs(args.refs, exist_ok=True)
    steps = args.only or ["analysis", "timeline", "voice", "measure", "spans", "offset"]
    if "analysis" in steps:
        analyses(args.library, args.refs)
    if "timeline" in steps:
        timeline_cases(args.refs)
    if "voice" in steps:
        voice_cases(args.library, args.refs)
    if "measure" in steps:
        measure_cases(args.library, args.refs)
    if "spans" in steps:
        span_cases(args.refs)
    if "offset" in steps:
        offset_cases(args.library, args.refs)


if __name__ == "__main__":
    main()
