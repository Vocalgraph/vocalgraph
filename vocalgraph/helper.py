"""Vocalgraph Helper: lets the Vocalgraph web page record one program's sound.

A small local server on 127.0.0.1:8766 that lists the programs making sound
and streams one of them to the page over a WebSocket. It captures through
vocalgraph.appaudio (Windows: process loopback; macOS 13+: ScreenCaptureKit).

  GET /version             -> {"name", "version", "protocol", "platform", "packaged"}
  GET /apps                -> [{"id", "name", "playing"}]
  GET /capture?app=<exe>   (WebSocket) -> first a JSON text frame {rate, channels, app},
      then binary frames: 8-byte float64 send time (ms since epoch) + s16le stereo 48 kHz PCM

Security, in short (see helper/README.md):
  * only pages on ALLOWED may use it (the Origin header); anything else gets 403;
  * it listens on the loopback address only, and holds its port exclusively,
    so nothing else can listen on it alongside;
  * the vocalgraph:// link only starts it: whatever follows vocalgraph:// is
    ignored, so a link from any site can do nothing more than that;
  * it won't start twice, and quits after IDLE_MINUTES unused.

Run from the repo:          uv run python -m vocalgraph.helper
Stop a running one:         ... --quit
Installed (Windows), the installer registers the link to run
    "<install dir>\\Vocalgraph Helper.exe" --from-link "%1"
and started with no arguments from there it behaves the same way. On a Mac
the app's Info.plist declares the link (helper/vocalgraph-helper-mac.spec),
and macOS starts the app with no arguments.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import logging.handlers
import os
import socket
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

if not __package__:                     # run as a file (the dev link, PyInstaller): find the package
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from vocalgraph import appaudio  # noqa: E402

NAME = "Vocalgraph Helper"
PORT = 8766
# The page reads these from GET /version: VERSION to suggest updating,
# PROTOCOL (how page and helper talk) to tell whether they can work together
# at all. PROTOCOL only goes up when a change would break an older page.
# VERSION is the one place the version is set: the exe's file version and the
# installer's version are read from it.
VERSION = "0.4.0"
PROTOCOL = 1
IDLE_MINUTES = 10
SCHEME = "vocalgraph"
DEFAULT_ORIGINS = ("https://vocalgraph.github.io",)
ALLOWED: set[str] = set(DEFAULT_ORIGINS)
FROZEN = bool(getattr(sys, "frozen", False))        # the packaged exe
WINDOWS = sys.platform == "win32"
# Windows named objects, in this logon session's namespace ("Local\"), which
# other users' sessions can't see and web pages can't reach.
QUIT_EVENT = r"Local\VocalgraphHelperQuit"
RUNNING_MUTEX = r"Local\VocalgraphHelperRunning"
LOG_BYTES = 1_000_000

log_ = logging.getLogger("vocalgraph.helper")


def data_dir() -> str:
    if WINDOWS:
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser(r"~\AppData\Local")
        return os.path.join(base, NAME)
    if sys.platform == "darwin":
        return os.path.expanduser(f"~/Library/Logs/{NAME}")
    return os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "vocalgraph-helper")


def setup_logging() -> None:
    """To the console when there is one; to a file of at most ~1 MB (plus one
    older one) when packaged or started without a window."""
    windowless = sys.stdout is None or sys.stderr is None
    if windowless:                      # pythonw / the windowed exe: print() and argparse need somewhere to go
        devnull = open(os.devnull, "w", encoding="utf-8")
        sys.stdout = sys.stdout or devnull
        sys.stderr = sys.stderr or devnull
    fmt = logging.Formatter("%(asctime)s %(message)s", "%Y-%m-%d %H:%M:%S")
    if FROZEN or windowless:
        os.makedirs(data_dir(), exist_ok=True)
        h: logging.Handler = logging.handlers.RotatingFileHandler(
            os.path.join(data_dir(), "helper.log"), maxBytes=LOG_BYTES, backupCount=1, encoding="utf-8")
    else:
        h = logging.StreamHandler(sys.stdout)
    h.setFormatter(fmt)
    log_.addHandler(h)
    log_.setLevel(logging.INFO)


def log(*a) -> None:
    log_.info(" ".join(str(x) for x in a))


# Use, for the idle shutdown: when anything last asked, and captures running now.
last_used = time.monotonic()
capturing = 0
_use_lock = threading.Lock()
on_permission_needed = None             # set by main(): quits the helper


def touch(delta: int = 0) -> None:
    global last_used, capturing
    with _use_lock:
        last_used = time.monotonic()
        capturing += delta


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"      # Firefox refuses a WebSocket upgrade answered as HTTP/1.0

    def log_message(self, *a):
        pass

    def _empty(self, code: int) -> None:
        self.send_response(code); self.send_header("Content-Length", "0"); self.end_headers()

    def _origin_ok(self):
        touch()
        o = self.headers.get("Origin")
        if o not in ALLOWED:
            log("refused origin", o, self.path)
            self._empty(403)
            return None
        return o

    def _cors(self, o):
        self.send_header("Access-Control-Allow-Origin", o)
        self.send_header("Vary", "Origin")
        # Chrome's older Private Network Access preflight asks for this.
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, o, value) -> None:
        body = json.dumps(value).encode()
        self.send_response(200); self._cors(o)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_OPTIONS(self):
        o = self._origin_ok()
        if not o:
            return
        self.send_response(204); self._cors(o)
        self.send_header("Content-Length", "0")
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_POST(self):
        if self._origin_ok():
            self._empty(404)

    def do_GET(self):
        o = self._origin_ok()
        if not o:
            return
        url = urlparse(self.path)
        if url.path == "/version":
            return self._json(o, {"name": NAME, "version": VERSION, "protocol": PROTOCOL,
                                  "platform": sys.platform, "packaged": FROZEN})
        if url.path == "/apps":
            try:
                apps = appaudio.apps()
            except Exception as exc:          # shown greyed out in the page's list, not a broken helper
                log("listing apps failed:", repr(exc))
                apps = [{"id": "", "name": f"Apps: couldn't list them ({exc})", "playing": False, "disabled": True}]
            self._json(o, apps)
            log("apps listed for", o)
            if FROZEN and any(a.get("permission") for a in apps):
                # The Mac's Screen Recording permission, not given yet. macOS
                # applies it only to programs started after it's given, so
                # quit: the page's Start button then starts a helper that has it.
                with _use_lock:
                    busy = capturing > 0
                if not busy and on_permission_needed:
                    log("no recording permission yet: quitting, to be started again once it's given")
                    threading.Timer(1.0, on_permission_needed).start()
            return
        if url.path == "/capture" and self.headers.get("Upgrade", "").lower() == "websocket":
            return self._capture(parse_qs(url.query).get("app", [""])[0], o)
        self._empty(404)

    def _capture(self, exe, origin):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            return self._empty(400)
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket"); self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        conn = self.connection
        send = lambda op, data: conn.sendall(bytes([0x80 | op]) + (
            bytes([len(data)]) if len(data) < 126 else b"\x7e" + struct.pack(">H", len(data)) if len(data) < 65536
            else b"\x7f" + struct.pack(">Q", len(data))) + data)
        log("capture", exe, "for", origin)
        touch(+1)
        cap = appaudio.AppCapture(exe, exe)
        cap.start()
        feed = socket.create_connection(("127.0.0.1", cap.port))
        send(1, json.dumps({"rate": appaudio.RATE, "channels": appaudio.CHANNELS, "app": exe}).encode())
        closed = threading.Event()

        def watch():                      # the page closing its end: a close frame, or the connection going
            try:
                while True:
                    data = conn.recv(1024)
                    if not data or data[0] & 0x0F == 8:
                        break
            except OSError:
                pass
            closed.set()
        threading.Thread(target=watch, daemon=True).start()
        sent = 0
        try:
            feed.settimeout(1.0)
            while not closed.is_set():
                try:
                    data = feed.recv(3840 * 4)
                except socket.timeout:
                    continue
                if not data:
                    break
                send(2, struct.pack("<d", time.time() * 1000) + data)
                sent += len(data)
        except OSError:
            pass
        finally:
            try:
                send(8, b"")              # close frame back
            except OSError:
                pass
            self.close_connection = True
            cap.stop(); feed.close()
            touch(-1)
            log("capture ended,", sent, "bytes sent; capture error:", cap.error)


class Server(ThreadingHTTPServer):
    """The port, held exclusively. Python's server asks to share its address,
    which on Windows lets a second program listen on the same port: a second
    helper, or anything else waiting for the page's requests."""
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


# --- stopping a running helper (--quit) ---------------------------------------------
# Windows: a named event the running helper waits on, and a mutex it holds
# while running, so --quit can wait for it to be gone. Elsewhere: its pid in a
# file only this user can write, and SIGTERM.

def _k32():
    import ctypes
    from ctypes import wintypes
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateEventW.restype = k.OpenEventW.restype = k.CreateMutexW.restype = k.OpenMutexW.restype = wintypes.HANDLE
    k.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
    k.OpenEventW.argtypes = k.OpenMutexW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    k.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k.SetEvent.argtypes = k.ResetEvent.argtypes = k.CloseHandle.argtypes = [wintypes.HANDLE]
    k.ReleaseMutex.argtypes = [wintypes.HANDLE]
    return k


def _pid_file() -> str:
    return os.path.join(data_dir(), "helper.pid")


class QuitSignal:
    """Held by the running helper: calls on_quit when --quit asks."""

    def __init__(self, on_quit):
        self.on_quit = on_quit
        self._handles = []
        if WINDOWS:
            k = _k32()
            self._k = k
            mutex = k.CreateMutexW(None, True, RUNNING_MUTEX)       # owned by this (the main) thread
            event = k.CreateEventW(None, True, False, QUIT_EVENT)
            if not mutex or not event:
                raise OSError("couldn't create the helper's quit signal")
            k.ResetEvent(event)                                   # a leftover signal from before isn't for us
            self._mutex, self._event = mutex, event
            threading.Thread(target=self._wait, daemon=True, name="quit-signal").start()
        else:
            import signal
            os.makedirs(data_dir(), mode=0o700, exist_ok=True)
            with open(os.open(_pid_file(), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as fh:
                fh.write(str(os.getpid()))
            signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=on_quit, daemon=True).start())

    def _wait(self):
        if self._k.WaitForSingleObject(self._event, 0xFFFFFFFF) == 0:
            log("asked to quit")
            self.on_quit()

    def close(self):
        if WINDOWS:
            self._k.ReleaseMutex(self._mutex)
            self._k.CloseHandle(self._mutex)
            self._k.CloseHandle(self._event)
        else:
            try:
                with open(_pid_file()) as fh:
                    if fh.read().strip() == str(os.getpid()):
                        os.remove(_pid_file())
            except OSError:
                pass


def request_quit(wait_s: float = 10.0) -> int:
    """Ask a running helper to quit and wait until it has. 0: it's not running (now)."""
    if WINDOWS:
        k = _k32()
        EVENT_MODIFY_STATE, SYNCHRONIZE = 0x0002, 0x00100000
        event = k.OpenEventW(EVENT_MODIFY_STATE, False, QUIT_EVENT)
        if not event:
            print("The helper isn't running.")
            return 0
        mutex = k.OpenMutexW(SYNCHRONIZE, False, RUNNING_MUTEX)
        k.SetEvent(event)
        k.CloseHandle(event)
        if not mutex:
            return 0
        r = k.WaitForSingleObject(mutex, int(wait_s * 1000))      # the helper releasing it: it has finished
        if r in (0, 0x80):                                        # WAIT_OBJECT_0, WAIT_ABANDONED
            k.ReleaseMutex(mutex)
        k.CloseHandle(mutex)
        if r in (0, 0x80):
            print("The helper has quit.")
            return 0
        print("The helper didn't quit in time.")
        return 1
    import signal
    try:
        with open(_pid_file()) as fh:
            pid = int(fh.read().strip())
        os.kill(pid, signal.SIGTERM)
    except (OSError, ValueError):
        print("The helper isn't running.")
        return 0
    end = time.monotonic() + wait_s
    while time.monotonic() < end:
        try:
            os.kill(pid, 0)
        except OSError:
            print("The helper has quit.")
            return 0
        time.sleep(0.1)
    print("The helper didn't quit in time.")
    return 1


# --- the vocalgraph:// link type (Windows, this user only) ---------------------------
# On a Mac the app bundle's Info.plist (CFBundleURLTypes) declares it instead.

LINK_KEY = rf"Software\Classes\{SCHEME}"


def link_command() -> str:
    """What the link runs: the exe itself when packaged; from the repo, this
    file under pythonw (no console window)."""
    if FROZEN:
        return f'"{sys.executable}" --from-link "%1"'
    exe = sys.executable
    w = os.path.join(os.path.dirname(exe), "pythonw.exe")
    return f'"{w if os.path.exists(w) else exe}" "{os.path.abspath(__file__)}" --from-link "%1"'


def install_link() -> int:
    if not WINDOWS:
        print("Only on Windows: on a Mac the app bundle's Info.plist registers vocalgraph://.")
        return 1
    import winreg
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, LINK_KEY) as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "URL:Vocalgraph Helper")
        winreg.SetValueEx(k, "URL Protocol", 0, winreg.REG_SZ, "")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, LINK_KEY + r"\shell\open\command") as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, link_command())
    print(f"Registered {SCHEME}:// for this user:\n  HKEY_CURRENT_USER\\{LINK_KEY}\n  runs {link_command()}")
    log("link registered:", link_command())
    return 0


def uninstall_link() -> int:
    if not WINDOWS:
        print("Only on Windows.")
        return 1
    import winreg
    for sub in (r"\shell\open\command", r"\shell\open", r"\shell", ""):
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, LINK_KEY + sub)
        except FileNotFoundError:
            pass
    print(f"Removed {SCHEME}:// (HKEY_CURRENT_USER\\{LINK_KEY}).")
    log("link removed")
    return 0


def main(argv: list[str] | None = None) -> int:
    setup_logging()
    argv = sys.argv[1:] if argv is None else argv
    ap = argparse.ArgumentParser(prog=NAME, description=f"{NAME} {VERSION}: lets the Vocalgraph page record one program's sound")
    ap.add_argument("--install-link", "--register", action="store_true",
                    help=f"add the {SCHEME}:// link type for this Windows user")
    ap.add_argument("--uninstall-link", "--unregister", action="store_true", help=f"remove the {SCHEME}:// link type")
    ap.add_argument("--quit", action="store_true", help="ask a running helper to quit, and wait for it")
    ap.add_argument("--from-link", metavar="URL", help=argparse.SUPPRESS)   # the link's text: ignored
    ap.add_argument("--idle-minutes", type=float, default=IDLE_MINUTES, help="quit after this long unused (0: never)")
    ap.add_argument("--origin", action="append", default=[], help="another page address allowed to use it (development)")
    ap.add_argument("--version", action="version", version=f"{NAME} {VERSION} (protocol {PROTOCOL})")
    args = ap.parse_args(argv)
    if args.install_link:
        return install_link()
    if args.uninstall_link:
        return uninstall_link()
    if args.quit:
        return request_quit()
    # Packaged and started with nothing (double-clicked, the Start menu): as if from the link.
    from_link = args.from_link is not None or (FROZEN and not argv)
    ALLOWED.update(args.origin)
    try:
        server = Server(("127.0.0.1", PORT), H)
    except OSError:
        log("already running on port", PORT)          # a second start (another link click): nothing to do
        return 0
    quitting = threading.Event()

    def stop():
        if not quitting.is_set():
            quitting.set()
            server.shutdown()
    global on_permission_needed
    on_permission_needed = stop
    signal_ = QuitSignal(stop)
    log(f"{NAME} {VERSION} on 127.0.0.1:{PORT}{' (started from a link)' if from_link else ''}, allowed:",
        sorted(ALLOWED), f"; quits after {args.idle_minutes:g} min unused" if args.idle_minutes else "")

    def idle_watch():
        while not quitting.is_set():
            time.sleep(min(5.0, max(0.5, args.idle_minutes * 60 / 4)))
            with _use_lock:
                idle = capturing == 0 and time.monotonic() - last_used > args.idle_minutes * 60
            if idle:
                log("unused for", f"{args.idle_minutes:g}", "min: quitting")
                stop()
                return
    if args.idle_minutes:
        threading.Thread(target=idle_watch, daemon=True, name="idle-watch").start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        signal_.close()
        log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
