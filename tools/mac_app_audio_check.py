"""Checks recording one app's sound on a Mac, step by step, and writes what it
found to mac-app-audio-check.txt (send that file back) plus a short recording,
mac-app-audio-check.wav, to listen to.

Run it with "Check Mac app audio.command" in this folder. Before running it,
start something playing in the app you'll test (music, a video).
"""
from __future__ import annotations

import os
import platform
import socket
import sys
import time
import traceback
import wave

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, APP_DIR)
REPORT = os.path.join(APP_DIR, "mac-app-audio-check.txt")
WAV = os.path.join(APP_DIR, "mac-app-audio-check.wav")
lines: list[str] = []


def say(text: str = "") -> None:
    print(text)
    lines.append(text)


def step(title: str, fn):
    say(f"\n== {title}")
    try:
        out = fn()
        say("   ok")
        return out
    except Exception:
        say("   FAILED:")
        for ln in traceback.format_exc().rstrip().splitlines():
            say("   " + ln)
        return None


def main() -> None:
    say(f"macOS {platform.mac_ver()[0]} on {platform.machine()}, Python {platform.python_version()}")

    def imports():
        import objc
        import CoreMedia  # noqa: F401
        import ScreenCaptureKit  # noqa: F401
        say(f"   PyObjC {objc.__version__}")
        try:
            import dispatch  # noqa: F401
            say("   libdispatch bindings: yes")
        except ImportError as exc:
            say(f"   libdispatch bindings: no ({exc})")
    step("1. Apple framework bindings load", imports)

    from vocalgraph import appaudio
    say(f"\n   appaudio uses {appaudio.AppCapture.__module__}; supported() = {appaudio.supported()}")

    apps = step("2. List apps (the first time, macOS should ask for Screen Recording permission)", appaudio.apps) or []
    for a in apps:
        say(f"   {a['id']:<55} {a['name']}{'  [disabled]' if a.get('disabled') else ''}")
    usable = [a for a in apps if a["id"]]
    if not usable:
        say("\nNo app can be recorded yet. If macOS asked for permission, allow it, quit Terminal "
            "completely (Cmd+Q), and run this again.")
        return

    want = (sys.argv[1] if len(sys.argv) > 1 else "").strip().lower()
    pick = next((a for a in usable if want and (want in a["name"].lower() or want in a["id"].lower())), None)
    if pick is None:
        say(f"\nNo app matched {want!r}. Run it again with part of an app's name from the list above.")
        return
    say(f"\n   testing: {pick['name']} ({pick['id']})")

    def capture():
        import numpy as np
        cap = appaudio.AppCapture(pick["id"][4:], pick["name"])
        cap.start()
        s = socket.create_connection(("127.0.0.1", cap.port))   # standing in for ffmpeg
        s.settimeout(3)
        buf, t0 = bytearray(), time.monotonic()
        while time.monotonic() - t0 < 6:
            try:
                d = s.recv(65536)
            except socket.timeout:
                break
            if not d:
                break
            buf += d
        took = time.monotonic() - t0
        cap.stop(); s.close(); cap.thread.join(5)
        say(f"   {len(buf)} bytes in {took:.1f} s = {len(buf) / 4 / max(took, 1e-6):.0f} frames/s (should be about 48000)")
        say(f"   packets from macOS: {getattr(cap, 'packets', '?')}; formats seen: {sorted(map(str, getattr(cap, 'formats', [])))}")
        say(f"   capture error: {cap.error}")
        x = np.frombuffer(bytes(buf[:len(buf) // 4 * 4]), dtype="<i2").reshape(-1, 2)
        if x.size:
            peak = np.abs(x).max() / 32768
            say(f"   loudest moment: {20 * np.log10(peak + 1e-9):.1f} dBFS "
                f"({'silence - was the app playing?' if peak < 1e-4 else 'sound came through'})")
            with wave.open(WAV, "wb") as w:
                w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000); w.writeframes(x.tobytes())
            say(f"   saved {WAV}: listen to check it's the app's sound, and only that")
        if cap.error:
            raise RuntimeError(cap.error)
    step("3. Record 6 seconds of that app", capture)

    def with_ffmpeg():
        from vocalgraph import core, live
        cap = appaudio.AppCapture(pick["id"][4:], pick["name"])
        cap.start()
        out = os.path.join(APP_DIR, "mac-app-audio-check-ffmpeg.m4a")
        cmd = [core.ffmpeg(), "-y", "-hide_banner", "-loglevel", "error", *live._input_args(
            {"kind": "device", "devices": [pick["id"]]}, {pick["id"]: cap}), "-t", "4", *live.FORMATS["m4a"], out]
        res = core._run(cmd)
        cap.stop(); cap.thread.join(5)
        say(f"   ffmpeg exit {res.returncode}; {res.stderr.decode(errors='replace').strip()[-400:]}")
        say(f"   {out}: {os.path.getsize(out) if os.path.exists(out) else 0} bytes; capture error: {cap.error}")
        if res.returncode != 0:
            raise RuntimeError("ffmpeg failed")
    step("4. The same through ffmpeg, as a live session does", with_ffmpeg)


try:
    main()
finally:
    with open(REPORT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"\nWrote {REPORT}. Please send that file back.")
