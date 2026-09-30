"""Prototype local helper, for testing the browser version: lists programs and
streams one program's sound to a web page over a WebSocket on 127.0.0.1.
Reuses vocalgraph.appaudio (Windows; the Mac version is untested).

  GET  /version                   -> {"name", "version", "protocol", "platform"}
  GET  /apps                      -> [{"id", "name", "playing"}]   (CORS, allowed origins only)
  GET  /capture?app=<exe>  (WebSocket) -> first a JSON text frame {rate, channels},
       then binary frames: 8-byte float64 send time (ms since epoch) + s16le stereo 48 kHz PCM
  POST /report                    -> the test page's results, appended to results.jsonl here

Only pages on ALLOWED may use it; anything else gets 403. Run from the repo:
  uv run python web/helper-prototype/helper.py

Started from a link: `--register` adds a vocalgraph:// link type for this
Windows user (HKEY_CURRENT_USER only; `--unregister` removes it), so the page
can offer "Start the helper" and the browser opens this, with no window. A
link carries nothing the helper acts on: whatever follows vocalgraph:// is
ignored, so a link from any site can only start it, and the origin check
still decides who may use it. It won't start twice, and it quits after
IDLE_MINUTES without being used, so it isn't left listening all day.
"""
import argparse, base64, hashlib, json, os, socket, struct, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))     # the repo root
from vocalgraph import appaudio

PORT = 8766
# The page reads these from GET /version: VERSION to suggest updating,
# PROTOCOL (how page and helper talk) to tell whether they can work together
# at all. PROTOCOL only goes up when a change would break an older page.
VERSION = "0.2.0"
PROTOCOL = 1
IDLE_MINUTES = 10
SCHEME = "vocalgraph"
ALLOWED = {"https://vocalgraph.github.io", "http://localhost:8790", "http://127.0.0.1:8790"}
LOG_FILE = os.path.join(HERE, "helper.log")


def log(*a):
    line = time.strftime("%H:%M:%S") + " " + " ".join(str(x) for x in a)
    if sys.stdout is not None:            # started from a link (pythonw) there is no console
        print(line, flush=True)
    else:
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")


# Use, for the idle shutdown: when anything last asked, and captures running now.
last_used = time.monotonic()
capturing = 0
_use_lock = threading.Lock()


def touch(delta: int = 0) -> None:
    global last_used, capturing
    with _use_lock:
        last_used = time.monotonic()
        capturing += delta


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"      # Firefox refuses a WebSocket upgrade answered as HTTP/1.0

    def log_message(self, *a):
        pass

    def _origin_ok(self):
        touch()
        o = self.headers.get("Origin")
        if o not in ALLOWED:
            log("refused origin", o, self.path)
            self.send_response(403); self.send_header("Content-Length", "0"); self.end_headers()
            return None
        return o

    def _cors(self, o):
        self.send_header("Access-Control-Allow-Origin", o)
        self.send_header("Vary", "Origin")
        # Chrome's older Private Network Access preflight asks for this.
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        o = self._origin_ok()
        if not o:
            return
        self.send_response(204); self._cors(o)
        self.send_header("Content-Length", "0")
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_POST(self):
        o = self._origin_ok()
        if not o:
            return
        if urlparse(self.path).path != "/report":
            self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers()
            return
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        with open(os.path.join(HERE, "results.jsonl"), "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"at": time.strftime("%H:%M:%S"), "origin": o, "ua": self.headers.get("User-Agent"),
                                 **json.loads(body or b"{}")}) + "\n")
        log("results received from", o)
        self.send_response(204); self._cors(o); self.send_header("Content-Length", "0"); self.end_headers()

    def do_GET(self):
        o = self._origin_ok()
        if not o:
            return
        url = urlparse(self.path)
        if url.path == "/version":
            body = json.dumps({"name": "Vocalgraph helper", "version": VERSION, "protocol": PROTOCOL,
                               "platform": sys.platform}).encode()
            self.send_response(200); self._cors(o)
            self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)
            return
        if url.path == "/apps":
            body = json.dumps(appaudio.apps()).encode()
            self.send_response(200); self._cors(o)
            self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)
            log("apps listed for", o)
            return
        if url.path == "/capture" and self.headers.get("Upgrade", "").lower() == "websocket":
            return self._capture(parse_qs(url.query).get("app", [""])[0], o)
        self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers()

    def _capture(self, exe, origin):
        key = self.headers["Sec-WebSocket-Key"]
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


# --- the vocalgraph:// link type (Windows, this user only) ---------------------------

def _command() -> str:
    """What the link runs: this script under pythonw (no console window)."""
    exe = sys.executable
    w = os.path.join(os.path.dirname(exe), "pythonw.exe")
    return f'"{w if os.path.exists(w) else exe}" "{os.path.abspath(__file__)}" --from-link "%1"'


def register() -> None:
    import winreg
    base = rf"Software\Classes\{SCHEME}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base) as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "URL:Vocalgraph Helper")
        winreg.SetValueEx(k, "URL Protocol", 0, winreg.REG_SZ, "")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r"\shell\open\command") as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, _command())
    print(f"Registered {SCHEME}:// for this user:\n  HKEY_CURRENT_USER\\{base}\n  runs {_command()}")


def unregister() -> None:
    import winreg
    base = rf"Software\Classes\{SCHEME}"
    for sub in (r"\shell\open\command", r"\shell\open", r"\shell", ""):
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, base + sub)
        except FileNotFoundError:
            pass
    print(f"Removed {SCHEME}:// (HKEY_CURRENT_USER\\{base}).")


def main() -> int:
    ap = argparse.ArgumentParser(description="Vocalgraph helper prototype")
    ap.add_argument("--register", action="store_true", help=f"add the {SCHEME}:// link type for this user")
    ap.add_argument("--unregister", action="store_true", help=f"remove the {SCHEME}:// link type")
    ap.add_argument("--from-link", metavar="URL", help=argparse.SUPPRESS)   # the link's text: ignored
    ap.add_argument("--idle-minutes", type=float, default=IDLE_MINUTES, help="quit after this long unused (0: never)")
    ap.add_argument("--origin", action="append", default=[], help="another page address allowed to use it")
    args = ap.parse_args()
    if args.register:
        register(); return 0
    if args.unregister:
        unregister(); return 0
    ALLOWED.update(args.origin)
    try:
        server = Server(("127.0.0.1", PORT), H)
    except OSError:
        log("already running on port", PORT)          # a second start (another link click): nothing to do
        return 0
    log("helper on 127.0.0.1:%d%s, allowed:" % (PORT, " (started from a link)" if args.from_link is not None else ""),
        sorted(ALLOWED), f"; quits after {args.idle_minutes:g} min unused" if args.idle_minutes else "")

    def idle_watch():
        while True:
            time.sleep(5)
            with _use_lock:
                idle = capturing == 0 and time.monotonic() - last_used > args.idle_minutes * 60
            if idle:
                log("unused for", args.idle_minutes, "min: quitting")
                server.shutdown()
                return
    if args.idle_minutes:
        threading.Thread(target=idle_watch, daemon=True).start()
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
