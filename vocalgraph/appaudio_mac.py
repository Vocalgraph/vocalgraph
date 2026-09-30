"""One app's sound on a Mac, via ScreenCaptureKit (macOS 13 or later).

UNTESTED: written on Windows, where none of this can run. Run
"Check Mac app audio.command" in the tools folder on a Mac and send its output
back; it exercises everything here step by step.

ScreenCaptureKit records an app's audio as part of a screen capture, so:
  * it needs the Screen Recording permission (System Settings -> Privacy &
    Security -> Screen & System Audio Recording). macOS asks the first time and
    gives it to the program that started the app: Terminal, when it's started
    from "Start Vocalgraph.command";
  * a tiny, once-a-second video stream comes along with the audio and is
    ignored;
  * only apps with windows are offered (ScreenCaptureKit lists those), and
    whether an app is making sound isn't known, so none is marked as playing.

Same names as appaudio.py's Windows versions: supported(), apps(), AppCapture.
"""
from __future__ import annotations

import platform
import threading
import time

import numpy as np

from .appaudio import CHANNELS, RATE, Feed

# Apps that are part of macOS itself, not something anyone records.
HIDDEN = {"com.apple.WindowManager", "com.apple.dock", "com.apple.controlcenter", "com.apple.notificationcenterui",
          "com.apple.Spotlight", "com.apple.systemuiserver", "com.apple.loginwindow", "com.apple.TextInputMenuAgent",
          "com.apple.wallpaper.agent", "com.apple.universalcontrol"}
TIMEOUT = 10.0                       # seconds to wait for macOS to answer
PERMISSION_HELP = ("Allow Screen & System Audio Recording for Terminal in System Settings -> Privacy & Security "
                   "(or for whichever program started Vocalgraph), then quit Vocalgraph and start it again.")


def _macos() -> tuple[int, ...]:
    try:
        return tuple(int(p) for p in platform.mac_ver()[0].split("."))
    except ValueError:
        return (0,)


def supported() -> bool:
    """ScreenCaptureKit captures audio from macOS 13 (Ventura) on."""
    if _macos() < (13,):
        return False
    try:
        import ScreenCaptureKit  # noqa: F401
        return True
    except ImportError:
        return False


def _explain(error) -> str:
    """An NSError from ScreenCaptureKit, in words, with the fix if it's the permission."""
    text = str(error.localizedDescription()) if hasattr(error, "localizedDescription") else str(error)
    code = error.code() if hasattr(error, "code") else None
    # -3801: SCStreamErrorUserDeclined, the usual first-run case.
    if code == -3801 or "declined" in text.lower() or "TCC" in text:
        return f"macOS hasn't allowed recording yet. {PERMISSION_HELP}"
    return text


def _content():
    """What ScreenCaptureKit can capture now (displays and apps)."""
    import ScreenCaptureKit as SCK
    done, box = threading.Event(), {}

    def handler(content, error):
        box["content"], box["error"] = content, error
        done.set()

    SCK.SCShareableContent.getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler_(
        False, False, handler)
    if not done.wait(TIMEOUT):
        raise OSError("macOS didn't answer when asked which apps can be recorded.")
    if box.get("error") is not None:
        raise PermissionError(_explain(box["error"]))
    return box["content"]


def apps() -> list[dict]:
    """[{"id": "app:<bundle id>", "name", "playing": False}], by name."""
    if not supported():
        return []
    try:
        content = _content()
    except PermissionError as exc:
        # Shown in the input list, greyed out, so the fix is where it's needed.
        return [{"id": "", "name": f"Apps: {exc}", "playing": False, "disabled": True}]
    import os
    seen, out = set(), []
    for app in content.applications():
        bid = app.bundleIdentifier()
        if not bid or bid in HIDDEN or bid in seen or app.processID() == os.getpid():
            continue
        seen.add(bid)
        out.append({"id": f"app:{bid}", "name": str(app.applicationName() or bid), "playing": False})
    return sorted(out, key=lambda a: a["name"].lower())


def _pcm16(sbuf, formats: set) -> bytes | None:
    """A CMSampleBuffer of audio -> interleaved s16le stereo at RATE. The
    format is read from the buffer where PyObjC allows it; otherwise
    ScreenCaptureKit's usual one (32-bit float, one block per channel) is
    assumed. Every format seen is noted in `formats`, for the self-test."""
    import CoreMedia
    frames = int(CoreMedia.CMSampleBufferGetNumSamples(sbuf))
    block = CoreMedia.CMSampleBufferGetDataBuffer(sbuf)
    if not frames or block is None:
        return None
    length = int(CoreMedia.CMBlockBufferGetDataLength(block))
    status, data = CoreMedia.CMBlockBufferCopyDataBytes(block, 0, length, None)
    if status != 0 or data is None:
        raise OSError(f"couldn't read an audio buffer (status {status})")
    data = bytes(data)

    rate, channels, planar = float(RATE), max(1, length // (frames * 4)), True
    try:
        desc = CoreMedia.CMSampleBufferGetFormatDescription(sbuf)
        asbd = CoreMedia.CMAudioFormatDescriptionGetStreamBasicDescription(desc)
        if asbd is not None:
            asbd = asbd[0] if isinstance(asbd, (list, tuple)) else asbd
            rate, channels = float(asbd.mSampleRate), int(asbd.mChannelsPerFrame)
            planar = bool(asbd.mFormatFlags & 0x20)          # kAudioFormatFlagIsNonInterleaved
            is_float, bits = bool(asbd.mFormatFlags & 0x1), int(asbd.mBitsPerChannel)
            formats.add((rate, channels, bits, "float" if is_float else "int", "planar" if planar else "interleaved"))
            if not is_float or bits != 32:
                raise OSError(f"unexpected audio format: {bits}-bit {'float' if is_float else 'integer'}")
        else:
            formats.add(("format not readable; assumed", rate, channels, "float32", "planar"))
    except (AttributeError, TypeError, IndexError):
        formats.add(("format not readable; assumed", rate, channels, "float32", "planar"))

    x = np.frombuffer(data, dtype="<f4")
    if x.size < frames * channels:
        return None
    x = x[:frames * channels]
    x = x.reshape(channels, frames) if planar else x.reshape(frames, channels).T
    if channels == 1:
        x = np.vstack([x, x])
    elif channels > CHANNELS:
        x = x[:CHANNELS]
    if abs(rate - RATE) > 1:                                   # not asked for, but just in case
        n = max(1, int(round(frames * RATE / rate)))
        grid = np.linspace(0, frames - 1, n)
        x = np.vstack([np.interp(grid, np.arange(frames), ch) for ch in x])
    pcm = np.clip(np.round(x.T * 32767.0), -32768, 32767).astype("<i2")
    return pcm.tobytes()


def _classes():
    """The Objective-C side: a stream output that hands audio to its feed, and a
    delegate that notes why a stream stopped. Made once, on first use."""
    global _Output, _Delegate
    if "_Output" in globals():
        return _Output, _Delegate
    import objc
    from Foundation import NSObject

    class _VocalgraphAudioOutput(NSObject, protocols=[objc.protocolNamed("SCStreamOutput")]):
        def stream_didOutputSampleBuffer_ofType_(self, stream, sbuf, kind):
            feed = getattr(self, "feed", None)
            if feed is None or kind != 1:                      # 1 = SCStreamOutputTypeAudio
                return
            try:
                pcm = _pcm16(sbuf, feed.formats)
                if pcm:
                    feed.send(pcm)
            except Exception as exc:                            # ffmpeg gone, or a format problem
                feed.fail(exc)

    class _VocalgraphStreamDelegate(NSObject, protocols=[objc.protocolNamed("SCStreamDelegate")]):
        def stream_didStopWithError_(self, stream, error):
            feed = getattr(self, "feed", None)
            if feed is not None:
                feed.fail(OSError(_explain(error)))

    _Output, _Delegate = _VocalgraphAudioOutput, _VocalgraphStreamDelegate
    return _Output, _Delegate


class AppCapture(Feed):
    """One app (by bundle id): its audio via a ScreenCaptureKit stream."""

    def __init__(self, bundle_id: str, name: str | None = None):
        super().__init__(bundle_id, name)
        self.bundle_id = bundle_id
        self.formats: set = set()          # audio formats seen, for the self-test
        self.packets = 0
        self._failed: Exception | None = None
        self._stream = self._output = self._delegate = None

    def send(self, pcm: bytes) -> None:
        self.packets += 1
        super().send(pcm)

    def fail(self, exc: Exception) -> None:
        if self._failed is None:
            self._failed = exc
        self.stop()

    def capture(self) -> None:
        import CoreMedia
        import ScreenCaptureKit as SCK
        content = _content()
        app = next((a for a in content.applications() if a.bundleIdentifier() == self.bundle_id), None)
        if app is None:
            raise OSError(f"{self.name} isn't open.")
        displays = list(content.displays())
        if not displays:
            raise OSError("no display to attach the capture to.")
        flt = SCK.SCContentFilter.alloc().initWithDisplay_includingApplications_exceptingWindows_(displays[0], [app], [])
        cfg = SCK.SCStreamConfiguration.alloc().init()
        cfg.setCapturesAudio_(True)
        cfg.setSampleRate_(RATE)
        cfg.setChannelCount_(CHANNELS)
        cfg.setExcludesCurrentProcessAudio_(True)
        cfg.setWidth_(2)                     # the video that has to come along: as small and slow as allowed
        cfg.setHeight_(2)
        cfg.setMinimumFrameInterval_(CoreMedia.CMTimeMake(1, 1))

        Output, Delegate = _classes()
        self._output, self._delegate = Output.alloc().init(), Delegate.alloc().init()
        self._output.feed = self._delegate.feed = self
        self._stream = SCK.SCStream.alloc().initWithFilter_configuration_delegate_(flt, cfg, self._delegate)
        queue = None
        try:
            import dispatch
            queue = dispatch.dispatch_queue_create(b"vocalgraph.app-audio", None)
        except ImportError:
            pass                             # ScreenCaptureKit then uses a queue of its own
        res = self._stream.addStreamOutput_type_sampleHandlerQueue_error_(self._output, 1, queue, None)
        ok, err = res if isinstance(res, tuple) else (res, None)
        if not ok:
            raise OSError(_explain(err) if err is not None else "couldn't add the audio output")

        started, box = threading.Event(), {}

        def on_start(error):
            box["error"] = error
            started.set()

        self._stream.startCaptureWithCompletionHandler_(on_start)
        if not started.wait(TIMEOUT):
            raise OSError("macOS didn't start the capture.")
        if box.get("error") is not None:
            raise PermissionError(_explain(box["error"]))

        while not self.stopping:
            time.sleep(0.02)
            self.keep_time()
        if self._failed is not None and not isinstance(self._failed, (ConnectionError, BrokenPipeError)):
            raise self._failed

    def cleanup(self) -> None:
        if self._stream is not None:
            done = threading.Event()
            try:
                self._stream.stopCaptureWithCompletionHandler_(lambda error: done.set())
                done.wait(3)
            except Exception:
                pass
        if self._output is not None:
            self._output.feed = None
        if self._delegate is not None:
            self._delegate.feed = None
