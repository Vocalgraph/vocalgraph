"""Reference outputs from the desktop app's FFmpeg, for test/parity.mjs.

    python web/ffmpeg/test/make_refs.py            # write references
    python web/ffmpeg/test/make_refs.py --check    # after parity.mjs: check the
                                                   # wasm-encoded files play

Run with the app's venv (it imports vocalgraph). The recordings are read,
never modified or copied; everything goes to REFS, outside the repository.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")))
from vocalgraph import core  # noqa: E402

# Outside the repository: they're made from personal recordings.
REFS = os.environ.get("VG_FFMPEG_REFS", os.path.join(tempfile.gettempdir(), "vocalgraph-ffmpeg-refs"))
LIB = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "library"))

DECODES = [  # (id, path, stream)
    ("wav", os.path.join(LIB, "f8e05fee4d26", "input.wav"), 0),
    ("mp3", os.path.join(LIB, "1c0172b58117", "input.mp3"), 0),
    ("m4a_s0", os.path.join(LIB, "f1c23ba0b1b4", "input.m4a"), 0),
    ("m4a_s2", os.path.join(LIB, "f1c23ba0b1b4", "input.m4a"), 2),
]
CUT_SRC = os.path.join(LIB, "f1c23ba0b1b4", "input.m4a")
CUT_STREAM = 0
SEGS = [(1.25, 9.5), (20.0, 31.75), (60.123456, 75.5), (120.0, 151.25)]


def part_cmd(path, segs, stream, out):
    """The first ffmpeg call of core.render (one batch), verbatim."""
    chain = [f"[0:a:{stream}]atrim=start={a:.6f}:end={b:.6f},asetpts=N/SR/TB[s{j}]"
             for j, (a, b) in enumerate(segs)]
    labels = "".join(f"[s{j}]" for j in range(len(segs)))
    chain.append(f"{labels}concat=n={len(segs)}:v=0:a=1[out]")
    return ["-v", "error", "-y", "-i", path, "-filter_complex", ";".join(chain),
            "-map", "[out]", out]


def make():
    os.makedirs(REFS, exist_ok=True)
    meta = {"decodes": [], "cut": {}}
    for ident, path, stream in DECODES:
        t = time.perf_counter()
        x = core.decode(path, stream=stream)
        dt = time.perf_counter() - t
        x.astype("<f4").tofile(os.path.join(REFS, f"dec_{ident}.f32"))
        meta["decodes"].append({"id": ident, "path": path, "stream": stream,
                                "samples": int(x.size), "desktop_seconds": dt})
        print(f"{ident}: {x.size} samples ({x.size / core.RATE:.1f} s) in {dt:.2f} s")

    # Cutting: the FLAC part (lossless, so comparable bit for bit) and the
    # finished mp3/m4a from core.render itself.
    part = os.path.join(REFS, "cut_part_desktop.flac")
    res = core._run([core.ffmpeg(), *part_cmd(CUT_SRC, SEGS, CUT_STREAM, part)])
    assert res.returncode == 0, res.stderr
    core.decode(part).astype("<f4").tofile(os.path.join(REFS, "cut_part_desktop.f32"))
    for fmt in ("mp3", "m4a"):
        out = os.path.join(REFS, f"cut_desktop.{fmt}")
        core.render(CUT_SRC, SEGS, out, fmt=fmt, stream=CUT_STREAM)
        core.decode(out).astype("<f4").tofile(os.path.join(REFS, f"cut_desktop_{fmt}.f32"))
    meta["cut"] = {"path": CUT_SRC, "stream": CUT_STREAM, "segs": SEGS,
                   "part_args": part_cmd("IN", SEGS, CUT_STREAM, "part0.flac"),
                   "codecs": core.CODECS}
    with open(os.path.join(REFS, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    print("references in", REFS)


def check():
    """Decode the wasm-encoded files with the desktop ffmpeg; any error fails."""
    ok = True
    for name in sorted(os.listdir(REFS)):
        if not name.startswith("wasm_") or name.split(".")[-1] not in ("mp3", "m4a", "flac"):
            continue
        p = os.path.join(REFS, name)
        res = subprocess.run([core.ffmpeg(), "-v", "error", "-xerror", "-i", p, "-f", "null", "-"],
                             capture_output=True)
        err = res.stderr.decode(errors="replace").strip()
        x = core.decode(p)
        good = res.returncode == 0 and not err and x.size > 0
        ok &= good
        print(f"{name}: {'OK' if good else 'FAIL'}, {x.size / core.RATE:.2f} s decoded"
              + (f", stderr: {err[:200]}" if err else ""))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    check() if "--check" in sys.argv else make()
