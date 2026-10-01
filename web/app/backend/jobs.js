// Recordings: the browser port of vocalgraph/server.py's library and pipeline
// (analyse -> work out who is speaking -> group -> cut), with the same JSON
// answers, so the desktop app's pages work unchanged. Runs in the backend
// worker; the analysis itself is in engine/ (ports of the Python modules).
import * as store from './store.js';
import * as E from '../engine/index.js';
import { loadModels } from './models.js';
import { HttpError, json, error, file } from './http.js';

const SPEECH_PAD = 0.25;
const AUDIO_IN_MEMORY = 2;

// In memory, per job: the decoded audio (a few only), the analysis, voiceprints.
const cache = new Map();          // id -> { x, analysis, prep, activity }
const recent = [];
const running = new Map();        // id -> live progress {stage, frac}, while this worker processes it
const active = new Map();         // id -> the job object a pipeline here is working on

const c = (id) => { if (!cache.has(id)) cache.set(id, {}); return cache.get(id); };

async function input(job) {
  const blob = await store.files.get(job.id, 'input');
  if (!blob) throw new HttpError(404, 'The original recording is missing from this browser.');
  return blob;
}

async function x16k(job) {
  const m = c(job.id);
  if (!m.x) m.x = await E.decode(await input(job), job.input_file);
  const i = recent.indexOf(job.id); if (i >= 0) recent.splice(i, 1);
  recent.push(job.id);
  while (recent.length > AUDIO_IN_MEMORY) { const old = cache.get(recent.shift()); if (old) old.x = null; }
  return m.x;
}

async function analysis(job) {
  const m = c(job.id);
  if (!m.analysis) m.analysis = await store.files.get(job.id, 'analysis.json');
  if (!m.analysis) throw new HttpError(404, 'This recording has no analysis yet.');
  return m.analysis;
}
const trial = (a, t) => { const tr = a.trials.find(x => x.threshold === t); if (!tr) throw new HttpError(400, 'Unknown cut-off.'); return tr; };

async function prep(job) {
  const m = c(job.id);
  if (m.prep === undefined) m.prep = (await store.files.get(job.id, 'speakers')) || null;
  return m.prep;
}

// --- persistence ----------------------------------------------------------------

const SAVED = ['id', 'name', 'created', 'sha256', 'input_file', 'duration', 'threshold', 'speech_only', 'num_speakers',
  'names', 'anchors', 'turns', 'background', 'rev', 'prep_segments', 'output', 'tracks', 'homes', 'track_lags', 'engine'];

async function save(job) {
  const meta = Object.fromEntries(SAVED.map(k => [k, job[k] ?? null]));
  meta.complete = job.status === 'done';
  meta.status = job.status; meta.error = job.error ?? null;
  await store.jobs.put(meta);
}

// A saved job as the pipeline uses it. A job still "working" in the library
// but not being processed here was cut off (the tab closed): it is resumed by
// resumeInterrupted().
async function load(id) {
  if (active.has(id)) return active.get(id);         // being processed here: the very object the pipeline holds
  const meta = await store.jobs.get(id);
  if (!meta) throw new HttpError(404, 'No such recording.');
  const job = { ...meta, names: meta.names || {}, anchors: meta.anchors || {}, turns: meta.turns || [], homes: meta.homes || {} };
  if (meta.complete) Object.assign(job, { status: 'done', stage: 'Done', frac: 1 });
  else if (running.has(id)) Object.assign(job, { status: 'working', ...running.get(id) });
  else if (meta.status === 'working') Object.assign(job, { status: 'working', stage: 'Waiting to continue', frac: null });
  else Object.assign(job, { status: 'error', error: meta.error || 'Processing was interrupted. Drop the file in again to redo it.' });
  return job;
}

// --- pipeline -------------------------------------------------------------------

function say(job, stage) {
  return (s, frac = null) => {
    const p = { stage: stage || s, frac };
    running.set(job.id, p); Object.assign(job, p);
    broadcast(job.id, p);
  };
}
// Other tabs show this job's progress too.
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('vocalgraph-progress') : null;
const remote = new Map();
channel?.addEventListener('message', (e) => { if (e.data?.id) remote.set(e.data.id, e.data.p); });
const broadcast = (id, p) => channel?.postMessage({ id, p });

async function analyze(job) {
  const progress = say(job);
  progress('Reading the recording', null);
  const x = await x16k(job);
  const a = E.analyze(x, { progress }).toDict();
  await store.files.put(job.id, 'analysis.json', a);
  c(job.id).analysis = a;
  job.threshold = a.chosen; job.duration = a.duration;
}

async function prepare(job) {
  if (job.prep_from_live && await prep(job)) { delete job.prep_from_live; return; }
  delete job.prep_from_live;
  const a = await analysis(job), segs = trial(a, a.chosen).segments;
  const progress = say(job, 'Working out who is speaking');
  progress(null, 0);
  const models = await loadModels((s) => progress(s, 0));
  const p = await E.prepare(E.concat(await x16k(job), segs), models, (f) => progress(null, f));
  await store.files.put(job.id, 'speakers', p);
  c(job.id).prep = p;
  job.prep_segments = segs.map(s => [s[0], s[1]]);
  job.engine = { backend: models.backend, threads: models.threads };
}

async function assign(job) {
  // background: quiet voices behind the speakers (a TV, a call in another
  // room), kept as spans of the recording, never as a speaker
  const { turns, background } = E.group(await prep(job), job.num_speakers ?? null);
  const tl = new E.Timeline(job.prep_segments);
  let out = [];
  for (const [s, e, k] of turns) for (const [a, b] of tl.toSource(s, e)) out.push([a, b, k]);
  job.background = background.flatMap(([s, e]) => tl.toSource(s, e).map(([a, b]) => [a, b]));
  let homes = {};
  const act = await trackActivity(job);
  if (act) {
    const r = E.refine(out, act);
    out = r.turns; homes = r.homes;
    // Numbered by talk time again: re-reading can drop crosstalk "speakers".
    const talk = new Map();
    for (const [s, e, k] of out) talk.set(k, (talk.get(k) || 0) + e - s);
    const rank = new Map([...talk.entries()].sort((a, b) => b[1] - a[1]).map(([k], i) => [k, i]));
    out = out.map(([s, e, k]) => [s, e, rank.get(k)]);
    homes = Object.fromEntries(Object.entries(homes).map(([k, h]) => [rank.get(+k), h]));
  }
  job.turns = out; job.homes = homes;
  job.names = namesFromAnchors(job);
  job.rev = (job.rev || 0) + 1;
}

// A recording with a track per input after the mix (a live session with
// several inputs): who is sounding on each input. Cached as "tracks".
async function trackActivity(job) {
  const m = c(job.id);
  if (m.activity !== undefined) return m.activity;
  let saved = await store.files.get(job.id, 'tracks');
  if (!saved) {
    saved = { levels: [] };
    const blob = await input(job), names = await E.streams(blob, job.input_file);
    if (names.length >= 3) {
      const mix = E.levels(await x16k(job));
      let tracks = [];
      for (let i = 1; i < names.length; i++) tracks.push(E.levels(await E.decode(blob, job.input_file, i)));
      const n = Math.min(mix.length, ...tracks.map(t => t.length));
      const lags = tracks.map(t => E.lag(mix, t));
      tracks = tracks.map((t, i) => E.shift(t.subarray(0, n), lags[i]));
      if (E.isMixOf(mix.subarray(0, n), tracks)) {
        saved = { levels: tracks, lags };
        job.track_lags = lags;
        if (!job.tracks) job.tracks = names.slice(1).map((nm, i) => nm || `Input ${i + 1}`);
      }
    }
    await store.files.put(job.id, 'tracks', saved);
  }
  m.activity = saved.levels.length ? E.activity(saved.levels) : null;
  return m.activity;
}
const lagOf = (job, k) => (job.track_lags || [])[k] || 0;

function overlap(a, b) { let t = 0; for (const [a0, b0] of a) for (const [a1, b1] of b) t += Math.max(0, Math.min(b0, b1) - Math.max(a0, a1)); return t; }

// Give each speaker the name whose anchor (the speech it was given to) they overlap most.
function namesFromAnchors(job) {
  const spans = new Map();
  for (const [s, e, k] of job.turns || []) { if (!spans.has(k)) spans.set(k, []); spans.get(k).push([s, e]); }
  const scores = [];
  for (const [name, a] of Object.entries(job.anchors || {})) for (const [k, sp] of spans) scores.push([overlap(a, sp), name, k]);
  // Python sorts tuples descending: score, then name, then speaker.
  scores.sort((x, y) => y[0] - x[0] || (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0) || y[2] - x[2]);
  const names = {}, used = new Set();
  for (const [score, name, k] of scores) if (score > 0 && !(k in names) && !used.has(name)) { names[k] = name; used.add(name); }
  return names;
}

async function outputSegments(job) {
  const a = await analysis(job);
  let segs = trial(a, job.threshold).segments;
  if (job.speech_only && job.turns?.length)
    segs = E.intersect(segs, E.union(job.turns.map(([s, e]) => [s, e]), SPEECH_PAD, a.duration));
  return segs;
}
const outputKey = (job) => `${job.threshold}` + (job.speech_only ? `-speech${job.rev}` : '');

async function render(job) {
  const key = outputKey(job), o = job.output || {};
  if (o.key !== key || !(await store.files.get(job.id, o.file || '-'))) {
    const segs = await outputSegments(job);
    const progress = say(job, 'Writing the trimmed file');
    const r = await E.render(await input(job), job.input_file, segs, { fmt: 'mp3', progress: (f) => progress(null, f) });
    const fileName = `trimmed-${key}.mp3`, segName = `segments-${key}.json`;
    await store.files.put(job.id, fileName, r.blob);
    await store.files.put(job.id, segName, segs.map(([s, e]) => ({ start: s, end: e })));
    job.output = { key, file: fileName, segments_file: segName, duration: r.duration };
  }
  await place(job);
}

// Speaker turns on the trimmed file's timeline, for the page's bar.
async function place(job) {
  const segs = (await store.files.get(job.id, job.output.segments_file)).map(s => [s.start, s.end]);
  const tl = new E.Timeline(segs), placed = [];
  const turns = [...(job.turns || [])].sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  for (const [s, e, spk] of turns) for (const [a, b] of tl.fromSource(s, e)) {
    const last = placed[placed.length - 1];
    if (last && last[2] === spk && a - last[1] < 0.05) last[1] = b;
    else placed.push([a, b, spk]);
  }
  placed.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  job.output.turns = placed.map(([a, b, k]) => [round3(a), round3(b), k]);
  const back = [];
  for (const [s, e] of [...(job.background || [])].sort((p, q) => p[0] - q[0])) for (const [a, b] of tl.fromSource(s, e)) back.push([round3(a), round3(b)]);
  job.output.background = back;
}
const round3 = (v) => Math.round(v * 1000) / 1000;

// Runs the steps, one job at a time per recording across all tabs.
function start(job, ...steps) {
  Object.assign(job, { status: 'working', stage: 'Starting', frac: null, error: null });
  running.set(job.id, { stage: 'Starting', frac: null });
  active.set(job.id, job);
  const work = async () => {
    try {
      await save(job);
      for (const step of steps) await step(job);
      Object.assign(job, { status: 'done', stage: 'Done', frac: 1 });
    } catch (e) {
      console.error('Vocalgraph job', job.id, e);
      Object.assign(job, { status: 'error', error: e.message || String(e) });
    } finally {
      running.delete(job.id);
      active.delete(job.id);
      broadcast(job.id, { stage: job.stage, frac: job.frac, done: true });
      try { await save(job); } catch {}
    }
  };
  (navigator.locks ? navigator.locks.request(`vocalgraph-job-${job.id}`, work) : work());
}
const STEPS = { analyze, prepare, assign, render };

// Jobs left "working" by a closed tab: pick them up where they stopped.
export async function resumeInterrupted() {
  for (const meta of await store.jobs.all()) {
    if (meta.complete || meta.status !== 'working') continue;
    const held = navigator.locks && (await navigator.locks.query()).held.some(l => l.name === `vocalgraph-job-${meta.id}`);
    if (held) continue;
    const job = await load(meta.id);
    const steps = [];
    if (!(await store.files.get(job.id, 'analysis.json'))) steps.push(analyze);
    if (!(await store.files.get(job.id, 'speakers')) || !job.prep_segments) steps.push(prepare);
    steps.push(assign, render);
    start(job, ...steps);
  }
}

// --- JSON views -------------------------------------------------------------------

async function summary(job) {
  const p = running.get(job.id) || remote.get(job.id);
  const out = Object.fromEntries(['id', 'status', 'stage', 'frac', 'error', 'name', 'threshold', 'speech_only', 'num_speakers', 'rev']
    .map(k => [k, job[k] ?? null]));
  if (job.status === 'working' && p) Object.assign(out, { stage: p.stage, frac: p.frac });
  out.names = Object.fromEntries(Object.entries(job.names || {}).map(([k, v]) => [String(k), v]));
  if (job.status !== 'done') return out;
  const a = await analysis(job);
  out.analysis = { duration: a.duration, background: a.noise_floor, voice: a.speech_level, audible: a.audible_above,
    chosen: a.chosen, note: a.note, trials: a.trials.map(t => ({ threshold: t.threshold, kept: t.kept, lost: t.lost })) };
  const talk = new Map(), count = new Map(), o = job.output || {};
  for (const [s, e, k] of job.turns || []) talk.set(k, (talk.get(k) || 0) + e - s);
  for (const [, , k] of o.turns || []) count.set(k, (count.get(k) || 0) + 1);
  const homes = job.homes || {}, tracks = job.tracks || [];
  out.speakers = [...talk.keys()].sort((p1, p2) => p1 - p2).map(k => ({ id: k, talk: talk.get(k), turns: count.get(k) || 0,
    track: homes[k] != null && homes[k] < tracks.length ? tracks[homes[k]] : null }));
  if (o.key) out.output = { version: o.key, duration: o.duration, turns: o.turns || [], background: o.background || [] };
  out.background = (job.background || []).reduce((t, [s, e]) => t + e - s, 0);
  return out;
}

const entry = (job) => ({ id: job.id, name: job.name, created: job.created, status: job.status, duration: job.duration,
  trimmed: job.output?.duration ?? null, speakers: new Set((job.turns || []).map(t => t[2])).size });

const idle = (job) => { if (job.status === 'working') throw new HttpError(409, 'Still working on this recording.'); };
const downloadName = (job, suffix) => job.name.replace(/\.[^.]*$/, '') + suffix;

// --- routes ------------------------------------------------------------------------

export async function library() {
  const all = await Promise.all((await store.jobs.all()).map(m => load(m.id)));
  all.sort((p, q) => (q.created || 0) - (p.created || 0));
  return json(all.map(entry));
}

async function sha256(blob) {
  const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const newId = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');

export async function create(req) {
  const f = req.form?.get('file');
  if (!f || !f.name) return error(400, 'No file received.');
  const digest = await sha256(f);
  for (const m of await store.jobs.all()) {
    if (m.sha256 === digest && (m.complete || m.status === 'working')) return json({ id: m.id, reused: true });
  }
  const job = await register(f, f.name, digest);
  return json({ id: job.id, reused: false });
}

// Add a recording to the library and start the full pipeline on it.
export async function register(blob, name, digest, extra = {}) {
  const id = newId(), ext = (name.match(/\.[^.]{1,10}$/) || [''])[0].toLowerCase();
  const job = { id, name, created: Date.now() / 1000, sha256: digest || await sha256(blob), input_file: 'input' + ext,
    speech_only: false, num_speakers: null, names: {}, anchors: {}, rev: 0, ...extra };
  await store.files.put(id, 'input', blob);
  // A live session files its voiceprints and voice frames with the recording.
  if (extra.prep) { await store.files.put(id, 'speakers', extra.prep); delete job.prep; }
  for (const [name, data] of Object.entries(extra.files || {})) await store.files.put(id, name, data);
  delete job.files;
  start(job, analyze, prepare, assign, render);
  return job;
}

// Names given during a live session, carried to its library copy.
export async function setAnchors(id, anchors) {
  const job = await load(id);
  job.anchors = anchors;
  job.names = namesFromAnchors(job);
  if (job.status === 'done') await save(job);
}

export async function status(id) { return json(await summary(await load(id))); }

export async function remove(id) {
  const job = await load(id); idle(job);
  cache.delete(id);
  await store.jobs.delete(id);
  return json({ ok: true });
}

export async function settings(id, req) {
  const job = await load(id); idle(job);
  const body = req.json(), steps = [];
  if ('num_speakers' in body) {
    let n = body.num_speakers; n = n === null || n === '' || n === 0 ? null : parseInt(n, 10);
    if (n !== null && !(n >= 1 && n <= 20)) return error(400, 'Number of speakers must be between 1 and 20.');
    if (n !== (job.num_speakers ?? null)) { job.num_speakers = n; steps.push(assign); }
  }
  if ('threshold' in body) {
    const t = parseInt(body.threshold, 10), a = await analysis(job);
    if (!a.trials.some(x => x.threshold === t)) return error(400, 'Unknown cut-off.');
    job.threshold = t;
  }
  if ('speech_only' in body) job.speech_only = !!body.speech_only;
  start(job, ...steps, render);
  return json({ ok: true });
}

export async function names(id, req) {
  const job = await load(id), body = req.json(), clean = {};
  for (const [k, v] of Object.entries(body)) { const n = parseInt(k, 10); if (!Number.isNaN(n)) clean[n] = String(v).trim().slice(0, 60); }
  const anchors = { ...(job.anchors || {}) };
  for (const [spk, name] of Object.entries(clean)) {
    const mine = (job.turns || []).filter(t => t[2] === +spk).map(([s, e]) => [s, e]);
    if (!mine.length) continue;
    for (const [old, a] of Object.entries(anchors))
      if (overlap(a, mine) > 0.5 * a.reduce((t, [s, e]) => t + e - s, 0)) delete anchors[old];
    if (name) anchors[name] = mine;
  }
  job.anchors = anchors;
  job.names = namesFromAnchors(job);
  if (job.status === 'done') await save(job);
  return json({ ok: true });
}

const speakerTurns = (job, spk) => {
  const t = (job.turns || []).filter(x => x[2] === spk).map(([s, e]) => [s, e]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (!t.length) throw new HttpError(404, 'No such speaker.');
  return t;
};

export async function audio(id, req) {
  const job = await load(id), o = job.output || {};
  const blob = await store.files.get(id, o.file || '-');
  if (!blob) return error(404, 'Not ready yet.');
  return file(blob, { type: 'audio/mpeg', range: req.headers.get('range'),
    download: req.query.get('download') === '1' ? downloadName(job, '-trimmed.mp3') : null });
}

export async function audioM4a(id, req) {
  const job = await load(id), o = job.output || {};
  if (!o.key) return error(404, 'Not ready yet.');
  const name = `trimmed-${o.key}.m4a`;
  let blob = await store.files.get(id, name);
  if (!blob) {
    const segs = (await store.files.get(id, o.segments_file)).map(s => [s.start, s.end]);
    blob = (await E.render(await input(job), job.input_file, segs, { fmt: 'm4a' })).blob;
    await store.files.put(id, name, blob);
  }
  return file(blob, { type: 'audio/mp4', download: downloadName(job, '-trimmed.m4a') });
}

export async function original(id) {
  const job = await load(id), blob = await input(job);
  return file(blob, { download: job.name.replace(/\.[^.]*$/, '') + (job.input_file.match(/\.[^.]*$/) || [''])[0] });
}

export async function segments(id) {
  const job = await load(id), o = job.output || {};
  const segs = await store.files.get(id, o.segments_file || '-');
  if (!segs) return error(404, 'Not ready yet.');
  return file(new Blob([JSON.stringify(segs, null, 2)], { type: 'application/json' }), { download: downloadName(job, '-segments.json') });
}

export async function speakerAudio(id, spk, req) {
  const job = await load(id), turns = speakerTurns(job, spk);
  const home = (job.homes || {})[spk];
  const name = `speaker${spk}-r${job.rev}${home == null ? '' : '-own'}.mp3`;
  let blob = await store.files.get(id, name);
  if (!blob) {
    const a = await analysis(job);
    let segs = E.union(turns, 0.05, a.duration);
    if (home != null) segs = segs.map(([s, e]) => [Math.max(0, s - lagOf(job, home)), e - lagOf(job, home)]);
    blob = (await E.render(await input(job), job.input_file, segs, { fmt: 'mp3', stream: home == null ? 0 : home + 1 })).blob;
    await store.files.put(id, name, blob);
  }
  const label = (req.query.get('name') || job.names?.[spk] || `speaker ${spk + 1}`).trim().slice(0, 60);
  const safe = label.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || `speaker ${spk + 1}`;
  return file(blob, { type: 'audio/mpeg', range: req.headers.get('range'),
    download: req.query.get('download') === '1' ? downloadName(job, ` - ${safe}.mp3`) : null });
}

export async function speakerVoice(id, spk, req) {
  const job = await load(id), turns = speakerTurns(job, spk), o = job.output;
  if (!o) return error(404, 'Not ready yet.');
  const gate = req.query.get('gate') === '1';
  let points = parseInt(req.query.get('points') || String(E.MAX_POINTS), 10);
  if (Number.isNaN(points)) points = E.MAX_POINTS;
  points = Math.max(100, Math.min(40000, points));
  const home = (job.homes || {})[spk];
  const name = `voice${spk}-r${job.rev}-${o.key}${home == null ? '' : '-own'}${gate ? '-gated' : ''}${points === E.MAX_POINTS ? '' : `-p${points}`}.json`;
  let data = await store.files.get(id, name);
  if (!data) {
    const outSegs = (await store.files.get(id, o.segments_file)).map(s => [s.start, s.end]);
    const own = new E.Timeline(turns), trimmed = new E.Timeline(outSegs);
    const frames = await store.files.get(id, 'voice_frames');
    if (frames && !(home != null && !frames.src)) {
      const { t, raw } = E.framesOf(frames, home ?? null);
      data = E.measure(t, raw, turns, gate, (v) => trimmed.pointsFromSource(v), o.duration, points);
    } else {
      let x = await x16k(job), mine = turns;
      if (home != null) {
        x = await E.decode(await input(job), job.input_file, home + 1);
        mine = turns.map(([s, e]) => [Math.max(0, s - lagOf(job, home)), e - lagOf(job, home)]);
      }
      data = await E.metrics(E.concat(x, mine), gate,
        { place: (v) => trimmed.pointsFromSource(own.pointsToSource(v)), duration: o.duration, points });
    }
    await store.files.put(id, name, data);
  }
  return json(data);
}
