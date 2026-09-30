"""Local web page for the trimmer. Listens on 127.0.0.1 only: recordings never
leave this computer.

Every processed recording is kept in a library folder inside the app folder
(so deleting the app removes it too): the original, the settings and speaker
names, the analysis, and the slow speaker-identification step's output. Opening
it again is instant; so is changing the number of speakers, which only redoes
the fast final grouping.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
import uuid

import numpy as np
from flask import Flask, abort, jsonify, request, send_file, send_from_directory

from . import core, live, sources, speakers, voice
from .timeline import Timeline, concat, intersect, union

STATIC = os.path.join(os.path.dirname(__file__), "static")
APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBRARY = os.environ.get("SILENCE_TRIMMER_LIBRARY") or os.path.join(APP_DIR, "library")
SPEECH_PAD = 0.25    # seconds kept around detected speech when removing other sounds
AUDIO_IN_MEMORY = 2  # decoded recordings kept in memory; others are re-decoded on demand
LIVE_DIR = os.path.join(LIBRARY, ".live")   # sessions in progress; no job.json, so not listed

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 ** 3   # 4 GB
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}


@app.before_request
def _this_computer_only():
    """Listening on 127.0.0.1 keeps other computers out, but not other
    websites open in this computer's browser. Two checks close that:
      * the address asked for must be this computer: a site can make its own
        name resolve to 127.0.0.1 ("DNS rebinding") and read this app's
        pages as its own, but its name is still in the request's Host;
      * a request made by a page must come from this app's own pages: a
        browser names the sending site in Origin, and another site could
        otherwise send an upload or start a recording."""
    host = request.host.lower()
    name = host[:host.index("]") + 1] if host.startswith("[") else host.rsplit(":", 1)[0]
    if name not in LOCAL_HOSTS:
        abort(403)
    origin = request.headers.get("Origin")
    if origin is not None and origin.lower() != f"http://{host}":
        abort(403)

_jobs: dict[str, dict] = {}
_lock = threading.RLock()
_recent_audio: list[str] = []
SAVED = ("id", "name", "created", "sha256", "input_file", "duration", "threshold", "speech_only",
         "num_speakers", "names", "anchors", "turns", "rev", "prep_segments", "output",
         "tracks", "homes", "track_lags")


# --- persistence ----------------------------------------------------------------

def _save(job: dict) -> None:
    meta = {k: job.get(k) for k in SAVED}
    meta["complete"] = job.get("status") == "done"
    tmp = os.path.join(job["dir"], "job.json.part")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(meta, fh)
    os.replace(tmp, os.path.join(job["dir"], "job.json"))
    a_path = os.path.join(job["dir"], "analysis.json")
    if job.get("analysis") is not None and not os.path.exists(a_path):
        with open(a_path, "w", encoding="utf-8") as fh:
            json.dump(job["analysis"].to_dict(), fh)
    p_path = os.path.join(job["dir"], "speakers.npz")
    if job.get("prep") is not None and not os.path.exists(p_path):
        np.savez_compressed(p_path, **job["prep"])


def _scan_library() -> None:
    """Sync with the library folder: pick up saves added from outside (e.g.
    copied from another computer) and forget ones whose folder was deleted.
    Run on every list request, so no restart is needed."""
    os.makedirs(LIBRARY, exist_ok=True)
    with _lock:
        known = {j["dir"] for j in _jobs.values()}
        present = set()
        for name in os.listdir(LIBRARY):
            d = os.path.join(LIBRARY, name)
            if not os.path.isfile(os.path.join(d, "job.json")):
                continue
            present.add(d)
            if d not in known:
                job = _load_job(d)
                if job and job["id"] not in _jobs:
                    _jobs[job["id"]] = job
        for jid, j in list(_jobs.items()):
            if j["dir"] not in present and j.get("status") != "working":
                _jobs.pop(jid)


def _load_job(d: str) -> dict | None:
    try:
        with open(os.path.join(d, "job.json"), encoding="utf-8-sig") as fh:
            meta = json.load(fh)
    except (OSError, ValueError):
        return None
    if not meta.get("id") or not meta.get("input_file"):
        return None
    job = {**meta, "dir": d, "input": os.path.join(d, meta["input_file"]),
           "names": {int(k): v for k, v in (meta.get("names") or {}).items()},
           "anchors": {n: [tuple(s) for s in a] for n, a in (meta.get("anchors") or {}).items()},
           "turns": [tuple(t) for t in meta.get("turns") or []],
           "homes": {int(k): v for k, v in (meta.get("homes") or {}).items()}}
    if meta.get("complete"):
        job.update(status="done", stage="Done", frac=1.0)
    else:
        job.update(status="error", error="Processing was interrupted. Drop the file in again to redo it.")
    return job


def _analysis(job: dict) -> core.Analysis:
    if job.get("analysis") is None:
        with open(os.path.join(job["dir"], "analysis.json"), encoding="utf-8-sig") as fh:
            job["analysis"] = core.Analysis.from_dict(json.load(fh))
    return job["analysis"]


def _prep(job: dict):
    if "prep" not in job:
        p = os.path.join(job["dir"], "speakers.npz")
        job["prep"] = dict(np.load(p)) if os.path.exists(p) else None
    return job["prep"]


def _x(job: dict) -> np.ndarray:
    """The decoded recording, kept for the most recently used few only."""
    with _lock:
        if job.get("x") is None:
            job["x"] = core.decode(job["input"])
        if job["id"] in _recent_audio:
            _recent_audio.remove(job["id"])
        _recent_audio.append(job["id"])
        while len(_recent_audio) > AUDIO_IN_MEMORY:
            old = _jobs.get(_recent_audio.pop(0))
            if old:
                old["x"] = None
    return job["x"]


# --- pipeline -----------------------------------------------------------------

def _set(job: dict, **kw) -> None:
    with _lock:
        job.update(kw)


def _progress(job, stage=None):
    def say(s, frac=None):
        _set(job, stage=stage or s, frac=frac)
    return say


def _analyze(job: dict) -> None:
    a = core.analyze(job["input"], progress=_progress(job))
    job["analysis"], job["x"] = a, a.x
    a.x = None
    job["threshold"], job["duration"] = a.chosen, a.duration
    _x(job)


def _prepare(job: dict) -> None:
    """The slow speaker step, on the audio kept at the recommended cut-off.
    Skipped for a recording made live: its voiceprints were worked out while
    it was recorded (on the whole recording) and filed with it."""
    if job.pop("prep_from_live", False) and _prep(job) is not None:
        return
    segs = _analysis(job).trial(_analysis(job).chosen).segments
    say = _progress(job, "Working out who is speaking")
    job["prep"] = speakers.prepare(concat(_x(job), segs), progress=lambda f: say(None, f))
    job["prep_segments"] = [list(s) for s in segs]


def _assign(job: dict) -> None:
    """The fast speaker step: group into people, re-read the turns of anyone
    on an input of their own from its track, carry names across."""
    turns = speakers.assign(_prep(job), job.get("num_speakers"))
    tl = Timeline([tuple(s) for s in job["prep_segments"]])
    new = [(s, e, t.speaker) for t in turns for s, e in tl.to_source(t.start, t.end)]
    homes = {}
    act = _track_activity(job)
    if act is not None:
        new, homes = sources.refine(new, act)
        # Numbered by talk time again: re-reading can drop crosstalk "speakers".
        talk = {}
        for s, e, k in new:
            talk[k] = talk.get(k, 0.0) + e - s
        rank = {k: i for i, k in enumerate(sorted(talk, key=talk.get, reverse=True))}
        new = [(s, e, rank[k]) for s, e, k in new]
        homes = {rank[k]: h for k, h in homes.items()}

    job["turns"] = new
    job["homes"] = homes
    job["names"] = _names_from_anchors(job)
    job["rev"] = (job.get("rev") or 0) + 1


def _track_activity(job: dict):
    """For a recording with a track per input after the mix (what a live
    session with several inputs saves): who is sounding on each input, per
    sources.HOP. None for an ordinary recording. Cached in tracks.npz."""
    path = os.path.join(job["dir"], "tracks.npz")
    if os.path.exists(path):
        with np.load(path) as z:
            lev = z["levels"]
        return sources.activity(list(lev)) if lev.size else None
    names = core.audio_streams(job["input"])
    lev = np.zeros((0, 0))
    if len(names) >= 3:
        tracks = [sources.levels(core.decode(job["input"], stream=i), core.RATE) for i in range(1, len(names))]
        mix = sources.levels(_x(job), core.RATE)
        n = min(len(mix), *(len(t) for t in tracks))
        # Line each track up with the mix, which is the timeline of the turns.
        lags = [sources.lag(mix, t) for t in tracks]
        tracks = [sources.shift(t[:n], L) for t, L in zip(tracks, lags)]
        # The first stream must be the tracks' mix, not, say, other languages:
        # the mix's level follows the tracks' combined level.
        both = 10 * np.log10(sum(10 ** (t / 10) for t in tracks) + 1e-20)
        use = np.maximum(mix[:n], both) > -80
        if use.sum() > 50 and np.corrcoef(mix[:n][use], both[use])[0, 1] > 0.8:
            lev = np.stack(tracks)
            job["track_lags"] = lags
            if not job.get("tracks"):
                job["tracks"] = [nm or f"Input {i + 1}" for i, nm in enumerate(names[1:])]
    np.savez_compressed(path, levels=lev)
    return sources.activity(list(lev)) if lev.size else None


def _lag(job: dict, track: int) -> float:
    """How much earlier input `track`'s own track runs than the mix (see
    sources.lag): a moment t of the mix is t - lag on that track."""
    lags = job.get("track_lags") or []
    return float(lags[track]) if track < len(lags) else 0.0


def _overlap(spans_a, spans_b) -> float:
    return sum(max(0.0, min(b0, b1) - max(a0, a1)) for a0, b0 in spans_a for a1, b1 in spans_b)


def _names_from_anchors(job: dict) -> dict:
    """Give each current speaker the name whose anchor they overlap most.

    A name is anchored to the stretches of speech it was given to, not to a
    speaker number, so it survives re-grouping: set the count to 1 and back,
    and both people get their names back.
    """
    anchors = job.get("anchors") or {}
    spans = {}
    for s, e, k in job.get("turns") or []:
        spans.setdefault(k, []).append((s, e))
    scores = sorted(((_overlap(a, spans[k]), name, k) for name, a in anchors.items() for k in spans),
                    reverse=True)
    names, used = {}, set()
    for score, name, k in scores:
        if score > 0 and k not in names and name not in used:
            names[k] = name
            used.add(name)
    return names


def _output_segments(job: dict):
    a = _analysis(job)
    segs = a.trial(job["threshold"]).segments
    if job.get("speech_only") and job.get("turns"):
        speech = union([(s, e) for s, e, _ in job["turns"]], SPEECH_PAD, a.duration)
        segs = intersect(segs, speech)
    return segs


def _output_key(job: dict) -> str:
    return f"{job['threshold']}" + (f"-speech{job.get('rev')}" if job.get("speech_only") else "")


def _render(job: dict) -> None:
    key = _output_key(job)
    out = job.get("output") or {}
    if out.get("key") != key or not os.path.exists(os.path.join(job["dir"], out.get("file", ""))):
        segs = _output_segments(job)
        file = f"trimmed-{key}.mp3"
        dur = core.render(job["input"], segs, os.path.join(job["dir"], file),
                          progress=_progress(job, "Writing the trimmed file"))
        seg_file = f"segments-{key}.json"
        core.write_segments(segs, os.path.join(job["dir"], seg_file))
        job["output"] = {"key": key, "file": file, "segments_file": seg_file, "duration": dur}
    _place(job)


def _place(job: dict) -> None:
    """Speaker turns on the trimmed file's timeline, for the page's bar."""
    with open(os.path.join(job["dir"], job["output"]["segments_file"]), encoding="utf-8") as fh:
        segs = [(s["start"], s["end"]) for s in json.load(fh)]
    tl = Timeline(segs)
    placed = []
    for s, e, spk in sorted(job.get("turns") or []):
        for a, b in tl.from_source(s, e):
            if placed and placed[-1][2] == spk and a - placed[-1][1] < 0.05:
                placed[-1] = (placed[-1][0], b, spk)
            else:
                placed.append((a, b, spk))
    job["output"]["turns"] = [[round(a, 3), round(b, 3), k] for a, b, k in sorted(placed)]


def _worker(job: dict, steps) -> None:
    try:
        for step in steps:
            step(job)
        _set(job, status="done", stage="Done", frac=1.0)
        _save(job)
    except Exception as exc:  # shown on the page rather than lost in a console
        _set(job, status="error", error=str(exc))
        try:
            _save(job)
        except OSError:
            pass


def _start(job: dict, *steps) -> None:
    _set(job, status="working", stage="Starting", frac=None, error=None)
    threading.Thread(target=_worker, args=(job, steps), daemon=True).start()


# --- JSON views -----------------------------------------------------------------

def _summary(job: dict) -> dict:
    out = {k: job.get(k) for k in ("id", "status", "stage", "frac", "error", "name",
                                   "threshold", "speech_only", "num_speakers", "rev")}
    out["names"] = {str(k): v for k, v in (job.get("names") or {}).items()}
    if job.get("status") != "done":
        return out
    a = _analysis(job)
    out["analysis"] = {
        "duration": a.duration, "background": a.noise_floor, "voice": a.speech_level,
        "audible": a.audible_above, "chosen": a.chosen, "note": a.note,
        "trials": [{"threshold": t.threshold, "kept": t.kept, "lost": t.lost} for t in a.trials],
    }
    talk, count = {}, {}
    for s, e, spk in job.get("turns") or []:
        talk[spk] = talk.get(spk, 0.0) + e - s
    o = job.get("output") or {}
    for _, _, spk in o.get("turns") or []:
        count[spk] = count.get(spk, 0) + 1
    homes, tracks = job.get("homes") or {}, job.get("tracks") or []
    out["speakers"] = [{"id": k, "talk": talk[k], "turns": count.get(k, 0),
                        "track": tracks[homes[k]] if k in homes and homes[k] < len(tracks) else None}
                       for k in sorted(talk)]
    if o:
        out["output"] = {"version": o["key"], "duration": o["duration"], "turns": o.get("turns") or []}
    return out


def _entry(job: dict) -> dict:
    o = job.get("output") or {}
    spk = {k for *_, k in job.get("turns") or []}
    return {"id": job["id"], "name": job.get("name"), "created": job.get("created"),
            "status": job.get("status"), "duration": job.get("duration"),
            "trimmed": o.get("duration"), "speakers": len(spk)}


def _job(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if not job:
        _scan_library()            # maybe copied into the library just now
        job = _jobs.get(job_id) or abort(404)
    return job


def _idle(job: dict):
    if job.get("status") == "working":
        abort(409, "Still working on this recording.")


# --- routes -----------------------------------------------------------------------

@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/tracks")
def tracks():
    """The second layout: everything on one stacked, shared timeline."""
    return send_from_directory(STATIC, "tracks.html")


@app.get("/static/<path:name>")
def static_file(name):
    return send_from_directory(STATIC, name)


@app.get("/api/library")
def library():
    _scan_library()
    with _lock:
        jobs = sorted(_jobs.values(), key=lambda j: j.get("created") or 0, reverse=True)
        return jsonify([_entry(j) for j in jobs])


@app.post("/api/jobs")
def create():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="No file received."), 400
    job_id = uuid.uuid4().hex[:12]
    work = os.path.join(LIBRARY, job_id)
    os.makedirs(work)
    ext = os.path.splitext(f.filename)[1].lower()[:10]
    path = os.path.join(work, "input" + ext)
    f.save(path)
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    digest = h.hexdigest()
    with _lock:
        same = next((j for j in _jobs.values()
                     if j.get("sha256") == digest and j.get("status") in ("done", "working")), None)
        if same:   # already in the library: open that instead of redoing it
            shutil.rmtree(work, ignore_errors=True)
            return jsonify(id=same["id"], reused=True)
    _register(job_id, work, path, f.filename, digest)
    return jsonify(id=job_id, reused=False)


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _register(job_id, work, path, name, digest, **extra) -> dict:
    """Add a recording to the library and start the full pipeline on it."""
    job = {"id": job_id, "dir": work, "input": path, "input_file": os.path.basename(path),
           "name": name, "created": time.time(), "sha256": digest,
           "speech_only": False, "num_speakers": None, "names": {}, "anchors": {}, "rev": 0, **extra}
    with _lock:
        _jobs[job_id] = job
    _start(job, _analyze, _prepare, _assign, _render)
    return job


@app.get("/api/jobs/<job_id>")
def status(job_id):
    with _lock:
        return jsonify(_summary(_job(job_id)))


@app.delete("/api/jobs/<job_id>")
def delete(job_id):
    job = _job(job_id)
    _idle(job)
    with _lock:
        _jobs.pop(job_id, None)
        if job_id in _recent_audio:
            _recent_audio.remove(job_id)
    shutil.rmtree(job["dir"], ignore_errors=True)
    return jsonify(ok=True)


@app.post("/api/jobs/<job_id>/settings")
def settings(job_id):
    """Change the cut-off, non-speech removal or the known number of speakers."""
    job = _job(job_id)
    _idle(job)
    body = request.get_json(silent=True) or {}
    steps = []
    if "num_speakers" in body:
        n = body["num_speakers"]
        n = int(n) if n not in (None, "", 0) else None
        if n is not None and not 1 <= n <= 20:
            return jsonify(error="Number of speakers must be between 1 and 20."), 400
        if n != job.get("num_speakers"):
            job["num_speakers"] = n
            steps.append(_assign)
    if "threshold" in body:
        try:
            t = int(body["threshold"])
            _analysis(job).trial(t)
        except (ValueError, TypeError, StopIteration):
            return jsonify(error="Unknown cut-off."), 400
        job["threshold"] = t
    if "speech_only" in body:
        job["speech_only"] = bool(body["speech_only"])
    # Re-cutting is skipped when the trimmed file would come out the same, which
    # is the case for a speaker-count change unless non-speech removal is on.
    _start(job, *steps, _render)
    return jsonify(ok=True)


@app.post("/api/jobs/<job_id>/names")
def names(job_id):
    job = _job(job_id)
    body = request.get_json(silent=True) or {}
    clean = {}
    for k, v in body.items():
        try:
            clean[int(k)] = str(v).strip()[:60]
        except ValueError:
            continue
    with _lock:
        anchors = dict(job.get("anchors") or {})
        for spk, name in clean.items():
            mine = [(s, e) for s, e, k in job.get("turns") or [] if k == spk]
            if not mine:
                continue
            # Renaming someone replaces the anchor that already stands for them.
            for old in [n for n, a in anchors.items()
                        if _overlap(a, mine) > 0.5 * sum(e - s for s, e in a)]:
                del anchors[old]
            if name:
                anchors[name] = mine
        job["anchors"] = anchors
        job["names"] = _names_from_anchors(job)
        if job.get("status") == "done":
            _save(job)
    return jsonify(ok=True)


def _speaker_turns(job: dict, spk: int):
    turns = [(s, e) for s, e, k in job.get("turns") or [] if k == spk]
    if not turns:
        abort(404)
    return sorted(turns)


def _download_name(job: dict, suffix: str) -> str:
    return os.path.splitext(job["name"])[0] + suffix


@app.get("/api/jobs/<job_id>/audio")
def audio(job_id):
    job = _job(job_id)
    o = job.get("output") or abort(404)
    return send_file(os.path.join(job["dir"], o["file"]), mimetype="audio/mpeg",
                     as_attachment=request.args.get("download") == "1",
                     download_name=_download_name(job, "-trimmed.mp3"))


@app.get("/api/jobs/<job_id>/audio.m4a")
def audio_m4a(job_id):
    """The trimmed file as M4A (AAC), made on first request from the same cut."""
    job = _job(job_id)
    o = job.get("output") or abort(404)
    path = os.path.join(job["dir"], f"trimmed-{o['key']}.m4a")
    if not os.path.exists(path):
        with open(os.path.join(job["dir"], o["segments_file"]), encoding="utf-8") as fh:
            segs = [(s["start"], s["end"]) for s in json.load(fh)]
        part = os.path.join(job["dir"], f"trimmed-{o['key']}.part.m4a")
        core.render(job["input"], segs, part, fmt="m4a")
        os.replace(part, path)
    return send_file(path, mimetype="audio/mp4", as_attachment=True,
                     download_name=_download_name(job, "-trimmed.m4a"))


@app.get("/api/jobs/<job_id>/original")
def original(job_id):
    """The full, untrimmed recording as it was added (or recorded live)."""
    job = _job(job_id)
    ext = os.path.splitext(job["input"])[1]
    return send_file(job["input"], as_attachment=True,
                     download_name=os.path.splitext(job["name"])[0] + ext)


@app.get("/api/jobs/<job_id>/segments")
def segments(job_id):
    job = _job(job_id)
    o = job.get("output") or abort(404)
    return send_file(os.path.join(job["dir"], o["segments_file"]), mimetype="application/json",
                     as_attachment=True, download_name=_download_name(job, "-segments.json"))


@app.get("/api/jobs/<job_id>/speaker/<int:spk>/audio")
def speaker_audio(job_id, spk):
    """One speaker's speech only, joined into its own MP3 (made on first request)."""
    job = _job(job_id)
    turns = _speaker_turns(job, spk)
    home = (job.get("homes") or {}).get(spk)
    # Someone on an input of their own is cut from that input's track (the
    # mix is stream 0), so nobody else is in it, even when talking over them.
    path = os.path.join(job["dir"], f"speaker{spk}-r{job.get('rev')}{'' if home is None else '-own'}.mp3")
    if not os.path.exists(path):
        segs = union(turns, 0.05, _analysis(job).duration)
        if home is not None:
            segs = [(max(0.0, a - _lag(job, home)), b - _lag(job, home)) for a, b in segs]
        core.render(job["input"], segs, path, stream=0 if home is None else home + 1)
    name = (request.args.get("name") or job.get("names", {}).get(spk) or f"speaker {spk + 1}").strip()[:60]
    safe = "".join(c for c in name if c.isalnum() or c in " -_").strip() or f"speaker {spk + 1}"
    return send_file(path, mimetype="audio/mpeg",
                     as_attachment=request.args.get("download") == "1",
                     download_name=_download_name(job, f" - {safe}.mp3"))


@app.get("/api/jobs/<job_id>/speaker/<int:spk>/voice")
def speaker_voice(job_id, spk):
    """Pitch, resonance, loudness and breathiness for one speaker's speech."""
    job = _job(job_id)
    turns = _speaker_turns(job, spk)
    gate = request.args.get("gate") == "1"
    o = job.get("output") or abort(404)
    # The track view asks for finer resolution (points), so it can zoom in.
    try:
        points = max(100, min(40000, int(request.args.get("points", voice.MAX_POINTS))))
    except ValueError:
        points = voice.MAX_POINTS
    home = (job.get("homes") or {}).get(spk)
    path = os.path.join(job["dir"], f"voice{spk}-r{job.get('rev')}-{o['key']}{'' if home is None else '-own'}"
                                    f"{'-gated' if gate else ''}{'' if points == voice.MAX_POINTS else f'-p{points}'}.json")
    if not os.path.exists(path):
        # Laid out on the trimmed file's timeline, like the speaker timeline:
        # speaker speech -> original recording -> trimmed file.
        with open(os.path.join(job["dir"], o["segments_file"]), encoding="utf-8") as fh:
            out_segs = [(s["start"], s["end"]) for s in json.load(fh)]
        own, trimmed = Timeline(turns), Timeline(out_segs)
        frames = _voice_frames(job)
        if frames is not None and home is not None and frames[2] is None:
            frames = None          # made live before inputs were measured apiece: measure their track
        if frames is not None:
            # Made live: the voice was measured frame by frame as it was
            # recorded, so this only retags those frames with the speaker.
            t, raw = live.frames_of(frames, home)
            data = live.measure(t, raw, turns, gate, trimmed.points_from_source, o["duration"], points)
        else:
            if home is None:
                x, mine = _x(job), turns
            else:
                x = core.decode(job["input"], stream=home + 1)
                mine = [(max(0.0, a - _lag(job, home)), b - _lag(job, home)) for a, b in turns]
            data = voice.metrics(concat(x, mine), gate,
                                 place=lambda t: trimmed.points_from_source(own.points_to_source(t)),
                                 timeline_duration=o["duration"], points=points)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
    return send_file(path, mimetype="application/json")


def _voice_frames(job: dict):
    """(times, measures, inputs) for a recording made live, else None.
    inputs is (input of each frame, loudest input at that moment) when each
    input was measured apiece, else None."""
    if "vframes" not in job:
        p = os.path.join(job["dir"], "voice_frames.npz")
        if os.path.exists(p):
            with np.load(p) as z:
                src = (z["src"], z["prim"]) if "src" in z.files else None
                job["vframes"] = (z["t"], {k: z[k] for k in z.files if k not in ("t", "src", "prim")}, src)
        else:
            job["vframes"] = None
    return job["vframes"]


# --- live -------------------------------------------------------------------------
# One live session at a time. When its input ends (Stop, or the end of a file
# being replayed), the full recording moves into the library as an ordinary
# recording and the normal pipeline trims it; names given live carry across.

_live: live.Session | None = None
_live_job: dict[str, str] = {}      # live session id -> library job id


@app.get("/live")
def live_page():
    return send_from_directory(STATIC, "live.html")


@app.get("/api/live/devices")
def live_devices():
    try:
        return jsonify(live.list_devices())
    except Exception as exc:
        return jsonify(error=str(exc)), 500


@app.post("/api/live/start")
def live_start():
    global _live
    body = request.get_json(silent=True) or {}
    with _lock:
        if _live and _live.status in ("starting", "live", "stopping", "finishing"):
            return jsonify(error="A live session is already running."), 409
        if body.get("replay"):
            job = _job(str(body["replay"]))
            source = {"kind": "file", "path": job["input"]}
            label = f"Replay of {os.path.splitext(job['name'])[0]}"
        elif body.get("devices") or body.get("device") not in (None, ""):
            # One input or several, mixed: [{"id", "name"}], or the older single "device".
            devs = body.get("devices") or [{"id": body["device"], "name": body.get("device_name")}]
            devs = [d for d in devs if isinstance(d, dict) and str(d.get("id") or "")][:8]
            if not devs:
                return jsonify(error="Choose a microphone."), 400
            names = [str(d.get("name") or d["id"]) for d in devs]
            source = {"kind": "device", "devices": [str(d["id"]) for d in devs], "names": names}
            label = " + ".join(names)
        else:
            return jsonify(error="Choose a microphone."), 400
        os.makedirs(LIVE_DIR, exist_ok=True)
        sess = live.Session(source, LIVE_DIR, label, fmt=str(body.get("format") or "m4a"))
        n = body.get("num_speakers")
        sess.num_speakers = int(n) if n not in (None, "", 0) else None
        _live = sess
    sess.start()
    threading.Thread(target=_live_keep, args=(sess,), daemon=True).start()
    return jsonify(id=sess.id)


def _live_keep(sess: live.Session) -> None:
    """When the session has finished, file the recording in the library."""
    for t in sess.threads:
        t.join()
    if sess.status != "stopped" or sess.discarded or not os.path.exists(sess.recording):
        return
    if sess.n < live.RATE // 2:          # under half a second: nothing worth keeping
        shutil.rmtree(sess.dir, ignore_errors=True)
        return
    stamp = time.strftime("%Y-%m-%d %H.%M", time.localtime(sess.started))
    name = (f"Live {stamp}" if sess.source["kind"] == "device" else sess.label) + os.path.splitext(sess.recording)[1]
    work = os.path.join(LIBRARY, sess.id)
    os.replace(sess.dir, work)
    path = os.path.join(work, os.path.basename(sess.recording))
    sess.recording = path
    # File the live analysis with it, so the library groups and cuts without
    # analysing again. Its times are the live stream's; the saved file can
    # start slightly later (M4A's encoder lead-in), so line the two up first.
    reuse = {}
    try:
        with sess.lock:
            x = sess.x[:sess.n].copy()
        offset = live.offset_of(path, x)
        if sess.save_analysis(work, offset):
            reuse = {"prep_from_live": True, "prep_segments": [[offset, offset + x.size / live.RATE]]}
    except Exception:          # analysing from scratch still works
        for f in ("speakers.npz", "voice_frames.npz"):
            try:
                os.remove(os.path.join(work, f))
            except OSError:
                pass
    if sess.tracks:
        reuse["tracks"] = list(sess.source.get("names") or [])
    _register(sess.id, work, path, name, _sha256(path),
              anchors=sess.anchors(), num_speakers=sess.num_speakers, **reuse)
    with _lock:
        _live_job[sess.id] = sess.id


def _live_or_404() -> live.Session:
    return _live or abort(404)


@app.get("/api/live/state")
def live_state():
    global _live
    with _lock:
        # A finished session whose recording was since deleted from the library
        # is over: show the start screen, not "saving" for ever.
        if _live and _live.status == "stopped" and _live.id in _live_job and _live_job[_live.id] not in _jobs:
            _live = None
    if not _live:
        return jsonify(status="idle")
    out = _live.state()
    job = _jobs.get(_live_job.get(_live.id, ""))
    if job:
        out["job"] = {"id": job["id"], "status": job.get("status"), "stage": job.get("stage"),
                      "frac": job.get("frac"), "error": job.get("error")}
    return jsonify(out)


@app.post("/api/live/stop")
def live_stop():
    _live_or_404().stop()
    return jsonify(ok=True)


@app.post("/api/live/discard")
def live_discard():
    """Stop and throw the recording away instead of keeping it."""
    global _live
    sess = _live_or_404()
    sess.discarded = True
    sess.discard()
    jid = _live_job.get(sess.id)
    if jid and jid in _jobs:
        job = _jobs[jid]
        for _ in range(600):              # let the pipeline stop touching it first
            if job.get("status") != "working":
                break
            time.sleep(0.1)
        with _lock:
            _jobs.pop(jid, None)
        shutil.rmtree(job["dir"], ignore_errors=True)
    with _lock:
        _live = None
    return jsonify(ok=True)


@app.post("/api/live/new")
def live_new():
    """Leave a finished session (already kept in the library) for a fresh one."""
    global _live
    with _lock:
        if _live and _live.status in ("starting", "live", "stopping", "finishing"):
            return jsonify(error="A live session is still running."), 409
        _live = None
    return jsonify(ok=True)


@app.post("/api/live/settings")
def live_settings():
    sess = _live_or_404()
    body = request.get_json(silent=True) or {}
    if "num_speakers" in body:
        n = body["num_speakers"]
        n = int(n) if n not in (None, "", 0) else None
        if n is not None and not 1 <= n <= 20:
            return jsonify(error="Number of speakers must be between 1 and 20."), 400
        with sess.lock:
            sess.num_speakers = n
        sess.ask_regroup()
    return jsonify(ok=True)


@app.post("/api/live/names")
def live_names():
    sess = _live_or_404()
    body = request.get_json(silent=True) or {}
    with sess.lock:
        for k, v in body.items():
            try:
                sess.names[int(k)] = str(v).strip()[:60]
            except ValueError:
                continue
    # Already filed? Carry the names to the library copy as well.
    job = _jobs.get(_live_job.get(sess.id, ""))
    if job:
        with _lock:
            job["anchors"] = sess.anchors()
            job["names"] = _names_from_anchors(job)
            if job.get("status") == "done":
                _save(job)
    return jsonify(ok=True)


@app.get("/api/live/frames")
def live_frames():
    """Voice frames measured since frame `from`: the page keeps them and draws
    them straight away, then colours them by speaker as the turns come in."""
    sess = _live_or_404()
    try:
        start = int(request.args.get("from", 0))
    except ValueError:
        abort(400)
    return jsonify(sess.frames(start))


@app.get("/api/live/voice")
def live_voice():
    sess = _live_or_404()
    spk = request.args.get("spk", "all")
    if spk != "all":
        try:
            spk = int(spk)
        except ValueError:
            abort(400)
    try:
        points = max(100, min(20000, int(request.args.get("points", voice.MAX_POINTS))))
    except ValueError:
        points = voice.MAX_POINTS
    return jsonify(sess.voice_for(spk, points, request.args.get("gate") == "1"))


def recover_live() -> None:
    """A session cut off by the app closing leaves its recording in LIVE_DIR.
    M4A is written in fragments, so it is readable up to the last second:
    file it in the library like a stopped session, rather than lose it."""
    if not os.path.isdir(LIVE_DIR):
        return
    for sid in os.listdir(LIVE_DIR):
        d = os.path.join(LIVE_DIR, sid)
        rec = next((os.path.join(d, f) for f in os.listdir(d) if f.startswith("input.")), None) \
            if os.path.isdir(d) else None
        if not rec or os.path.getsize(rec) < 4096 or os.path.exists(os.path.join(LIBRARY, sid)):
            shutil.rmtree(d, ignore_errors=True)
            continue
        work = os.path.join(LIBRARY, sid)
        os.replace(d, work)
        path = os.path.join(work, os.path.basename(rec))
        stamp = time.strftime("%Y-%m-%d %H.%M", time.localtime(os.path.getmtime(path)))
        _register(sid, work, path, f"Recovered live {stamp}{os.path.splitext(path)[1]}", _sha256(path))


def cleanup() -> None:
    """Stop a live session cleanly, so its recording is finalised."""
    if _live and _live.status in ("starting", "live"):
        _live.stop()
        for t in _live.threads:
            t.join(timeout=10)


_scan_library()
