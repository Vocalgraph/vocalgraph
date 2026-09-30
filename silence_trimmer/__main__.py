"""Start the trimmer and open it in the browser: python -m silence_trimmer"""
from __future__ import annotations

import argparse
import atexit
import socket
import sys
import threading
import webbrowser

PORT = 8765


def free_port(preferred: int) -> int:
    for port in (preferred, 0):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise SystemExit("Could not find a free port.")


def main() -> int:
    ap = argparse.ArgumentParser(description="Silence Trimmer")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    # Imported here, not at the top: live analysis starts a worker process,
    # which on Windows re-imports this module, and must not start a server.
    from waitress import serve

    from .server import app, cleanup, recover_live
    recover_live()

    port = free_port(args.port)
    url = f"http://127.0.0.1:{port}/"
    atexit.register(cleanup)
    print(f"Silence Trimmer is running at {url}")
    print("Keep this window open while you use it. Close it to quit.")
    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    serve(app, host="127.0.0.1", port=port, threads=4, _quiet=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
