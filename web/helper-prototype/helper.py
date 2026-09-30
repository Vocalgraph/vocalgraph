"""Prototype local helper, for testing the browser version: lists programs and
streams one program's sound to a web page over a WebSocket on 127.0.0.1.
Reuses vocalgraph.appaudio (Windows; the Mac version is untested).

  GET  /apps                      -> [{"id", "name", "playing"}]   (CORS, allowed origins only)
  GET  /capture?app=<exe>  (WebSocket) -> first a JSON text frame {rate, channels},
       then binary frames: 8-byte float64 send time (ms since epoch) + s16le stereo 48 kHz PCM
  POST /report                    -> the test page's results, appended to results.jsonl here

Only pages on ALLOWED may use it; anything else gets 403. Run from the repo:
  uv run python web/helper-prototype/helper.py
"""
import base64, hashlib, json, os, socket, struct, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))     # the repo root
from vocalgraph import appaudio

PORT = 8766
ALLOWED = {"https://vocalgraph.github.io", "http://localhost:8790", "http://127.0.0.1:8790"} | set(sys.argv[1:])
log = lambda *a: print(time.strftime("%H:%M:%S"), *a, flush=True)


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"      # Firefox refuses a WebSocket upgrade answered as HTTP/1.0

    def log_message(self, *a):
        pass

    def _origin_ok(self):
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
            log("capture ended,", sent, "bytes sent; capture error:", cap.error)


log("helper on 127.0.0.1:%d, allowed:" % PORT, sorted(ALLOWED))
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
