"""One program's sound, on Windows: its own audio (and that of the programs it
started), not the whole computer's and not the microphone.

Windows 10 (version 2004) and later can capture a process tree's audio
("process loopback"). It is only reachable through COM, which is called here
with ctypes, so there is nothing extra to install or to be blocked on first
run. ffmpeg can't capture a single program, so the sound is handed to it over
a local socket as raw 16-bit stereo PCM.

    apps()                    programs that have an audio session now
    AppCapture(exe).start()   capture one, see live.py

On a Mac the same names come from appaudio_mac.py (ScreenCaptureKit) instead.
"""
from __future__ import annotations

import ctypes
import os
import socket
import sys
import threading
import time
from ctypes import wintypes

RATE = 48000                 # what the capture is asked to deliver
CHANNELS = 2
BYTES = 2                    # 16-bit samples
FRAME = CHANNELS * BYTES

if sys.platform == "win32":
    ole32 = ctypes.OleDLL("ole32")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    HRESULT = ctypes.HRESULT
    WINFUNCTYPE = ctypes.WINFUNCTYPE
else:                        # importable everywhere; apps() is simply empty
    ole32 = kernel32 = None
    HRESULT = ctypes.c_long
    WINFUNCTYPE = ctypes.CFUNCTYPE   # only so the module loads: the Windows code is never called here


class GUID(ctypes.Structure):
    _fields_ = [("d1", ctypes.c_uint32), ("d2", ctypes.c_uint16), ("d3", ctypes.c_uint16), ("d4", ctypes.c_ubyte * 8)]

    @classmethod
    def of(cls, text: str) -> "GUID":
        h = text.replace("-", "")
        return cls(int(h[0:8], 16), int(h[8:12], 16), int(h[12:16], 16),
                   (ctypes.c_ubyte * 8)(*bytes.fromhex(h[16:32])))

    def __eq__(self, other):
        return bytes(self) == bytes(other)


CLSID_MMDeviceEnumerator = GUID.of("BCDE0395-E52F-467C-8E3D-C4579291692E")
IID_IMMDeviceEnumerator = GUID.of("A95664D2-9614-4F35-A746-DE8DB63617E6")
IID_IAudioSessionManager2 = GUID.of("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")
IID_IAudioSessionControl2 = GUID.of("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")
IID_IAudioClient = GUID.of("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2")
IID_IAudioCaptureClient = GUID.of("C8ADBD64-E71E-48A0-A4DE-185C395CD317")
IID_IUnknown = GUID.of("00000000-0000-0000-C000-000000000046")
IID_IAgileObject = GUID.of("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90")
IID_IActivateAudioInterfaceCompletionHandler = GUID.of("41D949AB-9862-444A-80F6-C261334DA5EB")

CLSCTX_ALL = 23
COINIT_MULTITHREADED = 0
E_RENDER, DEVICE_STATE_ACTIVE = 0, 1
AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000
AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000
AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000
AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000
AUDCLNT_BUFFERFLAGS_SILENT = 0x2
VT_BLOB = 65
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def _method(obj, index: int, *argtypes, restype=HRESULT):
    """Method `index` of COM interface pointer `obj` (a c_void_p)."""
    vtbl = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    fn = WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(vtbl[index])
    return lambda *args: fn(obj, *args)


def _release(obj) -> None:
    if obj:
        _method(obj, 2, restype=ctypes.c_ulong)()


def _qi(obj, iid: GUID) -> ctypes.c_void_p:
    out = ctypes.c_void_p()
    _method(obj, 0, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p))(ctypes.byref(iid), ctypes.byref(out))
    return out


def _com_init() -> None:
    try:
        ole32.CoInitializeEx(None, COINIT_MULTITHREADED)
    except OSError:          # already initialised on this thread, perhaps differently: fine
        pass


# --- which programs have sound -------------------------------------------------------

def _exe_path(pid: int) -> str | None:
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return None
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(len(buf))
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
        return None
    finally:
        kernel32.CloseHandle(h)


def _describe(path: str) -> str:
    """A program's own name for itself (its file description), else its file name."""
    stem = os.path.splitext(os.path.basename(path))[0]
    try:
        version = ctypes.WinDLL("version")
        size = version.GetFileVersionInfoSizeW(path, None)
        if not size:
            return stem
        data = ctypes.create_string_buffer(size)
        if not version.GetFileVersionInfoW(path, 0, size, data):
            return stem
        ptr, n = ctypes.c_void_p(), wintypes.UINT()
        if not version.VerQueryValueW(data, "\\VarFileInfo\\Translation", ctypes.byref(ptr), ctypes.byref(n)) or n.value < 4:
            return stem
        lang, cp = ctypes.cast(ptr, ctypes.POINTER(ctypes.c_uint16 * 2)).contents
        key = f"\\StringFileInfo\\{lang:04x}{cp:04x}\\FileDescription"
        if version.VerQueryValueW(data, key, ctypes.byref(ptr), ctypes.byref(n)) and n.value > 1:
            text = ctypes.wstring_at(ptr, n.value - 1).strip()
            return text or stem
    except OSError:
        pass
    return stem


def _parents() -> dict[int, tuple[int, str]]:
    """pid -> (parent pid, exe file name), for every process."""
    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_void_p), ("th32ModuleID", wintypes.DWORD),
                    ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
                    ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260)]
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    snap = kernel32.CreateToolhelp32Snapshot(0x2, 0)       # TH32CS_SNAPPROCESS
    out = {}
    entry = PROCESSENTRY32W(); entry.dwSize = ctypes.sizeof(entry)
    try:
        ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            out[entry.th32ProcessID] = (entry.th32ParentProcessID, entry.szExeFile.lower())
            ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return out


def _sessions() -> list[tuple[int, bool]]:
    """(pid, playing now) for every audio session on every playback device."""
    _com_init()
    enum = ctypes.c_void_p()
    ole32.CoCreateInstance(ctypes.byref(CLSID_MMDeviceEnumerator), None, CLSCTX_ALL,
                           ctypes.byref(IID_IMMDeviceEnumerator), ctypes.byref(enum))
    out = []
    coll = ctypes.c_void_p()
    try:
        _method(enum, 3, ctypes.c_int, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p))(E_RENDER, DEVICE_STATE_ACTIVE, ctypes.byref(coll))
        count = wintypes.UINT()
        _method(coll, 3, ctypes.POINTER(wintypes.UINT))(ctypes.byref(count))
        for i in range(count.value):
            dev, mgr, sess_enum = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
            try:
                _method(coll, 4, wintypes.UINT, ctypes.POINTER(ctypes.c_void_p))(i, ctypes.byref(dev))
                _method(dev, 3, ctypes.POINTER(GUID), wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(
                    ctypes.byref(IID_IAudioSessionManager2), CLSCTX_ALL, None, ctypes.byref(mgr))
                _method(mgr, 5, ctypes.POINTER(ctypes.c_void_p))(ctypes.byref(sess_enum))
                n = ctypes.c_int()
                _method(sess_enum, 3, ctypes.POINTER(ctypes.c_int))(ctypes.byref(n))
                for j in range(n.value):
                    ctl = ctypes.c_void_p()
                    _method(sess_enum, 4, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p))(j, ctypes.byref(ctl))
                    try:
                        ctl2 = _qi(ctl, IID_IAudioSessionControl2)
                        try:
                            state, pid = ctypes.c_int(), wintypes.DWORD()
                            _method(ctl, 3, ctypes.POINTER(ctypes.c_int))(ctypes.byref(state))
                            _method(ctl2, 14, ctypes.POINTER(wintypes.DWORD))(ctypes.byref(pid))
                            if pid.value and state.value != 2:          # 2 = expired
                                out.append((pid.value, state.value == 1))
                        finally:
                            _release(ctl2)
                    except OSError:
                        pass
                    finally:
                        _release(ctl)
            except OSError:
                pass
            finally:
                for o in (sess_enum, mgr, dev):
                    _release(o)
    finally:
        _release(coll)
        _release(enum)
    return out


# Windows' own audio plumbing, not a program anyone would want to record.
HIDDEN = {"audiodg.exe", "svchost.exe", "explorer.exe", "systemsettings.exe", "shellexperiencehost.exe"}


def supported() -> bool:
    """Process loopback needs Windows 10 version 2004 (build 19041) or later."""
    return sys.platform == "win32" and sys.getwindowsversion().build >= 19041


def apps() -> list[dict]:
    """Programs with an audio session, one entry per program:
    [{"id": "app:<exe>", "name": ..., "playing": bool}], playing ones first."""
    if not supported():
        return []
    me = os.getpid()
    by_exe: dict[str, dict] = {}
    for pid, playing in _sessions():
        if pid == me:
            continue
        path = _exe_path(pid)
        if not path:
            continue
        exe = os.path.basename(path).lower()
        if exe in HIDDEN:
            continue
        e = by_exe.setdefault(exe, {"id": "app:" + exe, "name": _describe(path), "playing": False})
        e["playing"] = e["playing"] or playing
    return sorted(by_exe.values(), key=lambda e: (not e["playing"], e["name"].lower()))


def _root_pid(exe: str) -> int | None:
    """The program's topmost process: capturing its tree takes in all its
    helper processes (browsers and Electron apps play sound from a helper)."""
    procs = _parents()
    # Sessions of processes still running (a closed one's session can linger),
    # the ones making sound first.
    sess = sorted((not playing, pid) for pid, playing in _sessions() if procs.get(pid, (0, ""))[1] == exe)
    pids = [pid for _, pid in sess]
    if not pids:
        pids = [pid for pid, (_, name) in procs.items() if name == exe]
    if not pids:
        return None
    pid = pids[0]
    # Climb only to parents that are the same program file: a program's
    # helpers are (Firefox, Discord). A launcher of the same name elsewhere
    # (a Python virtual environment's python.exe starts the real one) isn't,
    # and a capture of the tree from it comes back silent.
    path = (_exe_path(pid) or "").lower()
    seen = set()
    while pid not in seen:
        seen.add(pid)
        parent = procs.get(pid, (0, ""))[0]
        if parent and procs.get(parent, (0, ""))[1] == exe and (_exe_path(parent) or "").lower() == path:
            pid = parent
        else:
            break
    return pid


# --- capturing one program -------------------------------------------------------------

class _PROPVARIANT_BLOB(ctypes.Structure):
    _fields_ = [("vt", ctypes.c_ushort), ("r1", ctypes.c_ushort), ("r2", ctypes.c_ushort), ("r3", ctypes.c_ushort),
                ("cbSize", ctypes.c_ulong), ("pBlobData", ctypes.c_void_p)]


class _ACTIVATION_PARAMS(ctypes.Structure):
    _fields_ = [("ActivationType", ctypes.c_int),           # 1 = process loopback
                ("TargetProcessId", wintypes.DWORD),
                ("ProcessLoopbackMode", ctypes.c_int)]      # 0 = include the process tree


class _WAVEFORMATEX(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("wFormatTag", ctypes.c_ushort), ("nChannels", ctypes.c_ushort), ("nSamplesPerSec", ctypes.c_uint32),
                ("nAvgBytesPerSec", ctypes.c_uint32), ("nBlockAlign", ctypes.c_ushort),
                ("wBitsPerSample", ctypes.c_ushort), ("cbSize", ctypes.c_ushort)]


_QI = WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p))
_REF = WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)
_DONE = WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p)


class _Handler:
    """A minimal COM object for IActivateAudioInterfaceCompletionHandler (also
    IAgileObject, which activation requires): it just signals when done."""

    def __init__(self):
        self.done = threading.Event()
        self.op = None
        self._fns = (_QI(self._qi), _REF(lambda this: 1), _REF(lambda this: 1), _DONE(self._completed))
        self._vtbl = (ctypes.c_void_p * 4)(*[ctypes.cast(f, ctypes.c_void_p) for f in self._fns])
        self._obj = ctypes.c_void_p(ctypes.addressof(self._vtbl))   # an object is a pointer to its vtable
        self.ptr = ctypes.addressof(self._obj)

    def _qi(self, this, riid, ppv):
        if riid.contents in (IID_IUnknown, IID_IActivateAudioInterfaceCompletionHandler, IID_IAgileObject):
            ppv[0] = this
            return 0
        ppv[0] = None
        return -2147467262                                      # E_NOINTERFACE

    def _completed(self, this, op):
        self.done.set()
        return 0


def _activate(pid: int) -> ctypes.c_void_p:
    """An IAudioClient for process `pid` and its children."""
    params = _ACTIVATION_PARAMS(1, pid, 0)
    pv = _PROPVARIANT_BLOB(vt=VT_BLOB, cbSize=ctypes.sizeof(params), pBlobData=ctypes.addressof(params))
    handler = _Handler()
    op = ctypes.c_void_p()
    mmdev = ctypes.OleDLL("Mmdevapi")
    mmdev.ActivateAudioInterfaceAsync(ctypes.c_wchar_p("VAD\\Process_Loopback"), ctypes.byref(IID_IAudioClient),
                                      ctypes.byref(pv), ctypes.c_void_p(handler.ptr), ctypes.byref(op))
    try:
        if not handler.done.wait(5):
            raise OSError("Windows didn't answer the request to capture that program's sound.")
        hr, client = ctypes.c_long(), ctypes.c_void_p()
        # GetActivateResult fails on its own errors; the activation's goes in hr.
        _method(op, 3, ctypes.POINTER(ctypes.c_long), ctypes.POINTER(ctypes.c_void_p))(ctypes.byref(hr), ctypes.byref(client))
        if hr.value < 0:
            raise OSError(f"Windows refused to capture that program's sound (error {hr.value & 0xFFFFFFFF:#010x}).")
        return client
    finally:
        _release(op)
        handler.keep = (params, pv)        # alive until here


class Feed:
    """One program's sound, streamed as raw s16le 48 kHz stereo to whoever
    connects to `port` on 127.0.0.1 (ffmpeg, in live.py). Silence is filled in
    when the program plays nothing, so the stream keeps time with the clock and
    ffmpeg never waits on it. The capturing itself is per platform: capture()
    calls send() with each packet and keep_time() now and then, until stopping."""

    def __init__(self, key: str, name: str | None = None):
        self.name = name or key
        self.error: str | None = None
        self._stop = threading.Event()
        self._conn = None
        self._send_lock = threading.Lock()     # packets may arrive on another thread (the Mac's do)
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.bind(("127.0.0.1", 0))
        self._server.listen(1)
        self.port = self._server.getsockname()[1]
        self.thread = threading.Thread(target=self._run, daemon=True, name=f"app-audio-{key}")

    def ffmpeg_input(self) -> list[str]:
        # The format is known, so no probing: by default ffmpeg reads seconds of
        # an input to work it out before opening the next one, and holds
        # everything up meanwhile.
        return ["-f", "s16le", "-ar", str(RATE), "-ac", str(CHANNELS), "-probesize", "32",
                "-analyzeduration", "0", "-fflags", "nobuffer", "-i", f"tcp://127.0.0.1:{self.port}"]

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self._stop.set()

    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    def send(self, pcm: bytes) -> None:
        """Interleaved s16le stereo at RATE."""
        with self._send_lock:
            self._conn.sendall(pcm)
            self._sent += len(pcm) // FRAME

    def keep_time(self) -> None:
        """No packets at all while a program is quiet: fill in silence up to now,
        so this input keeps pace with the others."""
        with self._send_lock:
            due = int((time.monotonic() - self._t0) * RATE)
            if due - self._sent > RATE // 20:
                self._conn.sendall(bytes((due - self._sent) * FRAME))
                self._sent = due

    def capture(self) -> None:
        raise NotImplementedError

    def cleanup(self) -> None:
        pass

    def _run(self) -> None:
        try:
            self._server.settimeout(15)
            self._conn, _ = self._server.accept()          # ffmpeg connecting
            self._conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self._t0, self._sent = time.monotonic(), 0
            self.capture()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass                                            # ffmpeg finished and hung up: the normal end
        except Exception as exc:                            # shown on the page
            if not self._stop.is_set():
                self.error = f"Couldn't capture {self.name}'s sound: {exc}"
        finally:
            try:
                self.cleanup()
            except Exception:
                pass
            for sock in (self._conn, self._server):
                try:
                    if sock:
                        sock.close()
                except OSError:
                    pass


class AppCapture(Feed):
    """Windows: process loopback of the program's whole process tree."""

    def __init__(self, exe: str, name: str | None = None):
        super().__init__(exe, name)
        self.exe = exe
        self._client = self._capture = self._event = None

    def capture(self) -> None:
        _com_init()
        pid = _root_pid(self.exe)
        if pid is None:
            raise OSError(f"{self.name} isn't running.")
        client = self._client = _activate(pid)
        fmt = _WAVEFORMATEX(1, CHANNELS, RATE, RATE * FRAME, FRAME, BYTES * 8, 0)
        flags = (AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                 AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY)
        _method(client, 3, ctypes.c_int, wintypes.DWORD, ctypes.c_longlong, ctypes.c_longlong,
                ctypes.POINTER(_WAVEFORMATEX), ctypes.c_void_p)(0, flags, 200000, 0, ctypes.byref(fmt), None)
        kernel32.CreateEventW.restype = wintypes.HANDLE
        event = self._event = kernel32.CreateEventW(None, False, False, None)
        _method(client, 13, wintypes.HANDLE)(event)
        capture = self._capture = ctypes.c_void_p()
        _method(client, 14, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p))(
            ctypes.byref(IID_IAudioCaptureClient), ctypes.byref(capture))
        next_size = _method(capture, 5, ctypes.POINTER(ctypes.c_uint32))
        get = _method(capture, 3, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_uint32),
                      ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p, ctypes.c_void_p)
        give_back = _method(capture, 4, ctypes.c_uint32)
        _method(client, 10)()                     # Start

        data, frames, bflags, n = ctypes.c_void_p(), ctypes.c_uint32(), wintypes.DWORD(), ctypes.c_uint32()
        while not self.stopping:
            kernel32.WaitForSingleObject(event, 20)
            while True:
                next_size(ctypes.byref(n))
                if not n.value:
                    break
                get(ctypes.byref(data), ctypes.byref(frames), ctypes.byref(bflags), None, None)
                size = frames.value * FRAME
                chunk = bytes(size) if bflags.value & AUDCLNT_BUFFERFLAGS_SILENT else ctypes.string_at(data, size)
                give_back(frames)
                self.send(chunk)
            self.keep_time()

    def cleanup(self) -> None:
        if self._client:
            try:
                _method(self._client, 11)()        # Stop
            except OSError:
                pass
        _release(self._capture)
        _release(self._client)
        if self._event:
            kernel32.CloseHandle(self._event)


if sys.platform == "darwin":        # the Mac's own way, via ScreenCaptureKit: see appaudio_mac.py
    from .appaudio_mac import AppCapture, apps, supported  # noqa: E402,F811
