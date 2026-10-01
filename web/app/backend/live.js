// Live in the browser: the /api/live/... routes of vocalgraph/server.py, with
// microphones opened by the page (page.js), programs' sound from the local
// helper, the inputs kept in step (inputs.js), the analysis (session.js), and
// the recording filed in the library when it stops, with its voiceprints and
// voice frames so the library doesn't analyse it again.
import { json, error } from './http.js';
import * as store from './store.js';
import * as jobs from './jobs.js';
import * as E from '../engine/index.js';
import * as ff from '../engine/ffmpeg-ops.js';
import { Inputs, RATE as IN_RATE } from './inputs.js';
import { Session } from './session.js';
import { loadModels } from './models.js';
import { loadSmile } from '../smile/smile.js';

const HELPER = 'http://127.0.0.1:8766', HELPER_WS = 'ws://127.0.0.1:8766';
const HELPER_PROTOCOL = 1, HELPER_LATEST = '0.4.0';
// The release of HELPER_LATEST exactly (not "latest", which could one day be
// another kind of release), and its files for each system.
const RELEASE = `https://github.com/Vocalgraph/vocalgraph/releases/tag/helper-v${HELPER_LATEST}`;
const FILES = `https://github.com/Vocalgraph/vocalgraph/releases/download/helper-v${HELPER_LATEST}/`;
const DOWNLOADS = {
  windows: { file: `VocalgraphHelperSetup-${HELPER_LATEST}.exe`, label: 'for Windows' },
  'mac-apple-silicon': { file: `VocalgraphHelper-${HELPER_LATEST}-mac-apple-silicon.dmg`, label: 'for Mac', other: 'Apple Silicon Mac?' },
  'mac-intel': { file: `VocalgraphHelper-${HELPER_LATEST}-mac-intel.dmg`, label: 'for Intel Mac', other: 'Intel Mac?' },
};
const FORMATS = ['m4a', 'flac'];

let live = null;            // { id, status, error, label, kind, format, session, inputs, names, warnings, job, started, dir }
let lastJob = new Map();    // live id -> library job id

// The speaker models and openSMILE, loaded once per page: they take a few
// seconds the first time, so the Live page starts this as soon as it lists
// the inputs, and recording doesn't wait for it.
let warming = null;
const warm = () => (warming ||= Promise.all([loadModels(), loadSmile()]).catch((e) => { warming = null; throw e; }));

// --- the page (microphones) ---------------------------------------------------------
let calls = 0;
const pending = new Map();
function page(op, args = {}, transfer = []) {
  const call = ++calls;
  return new Promise((resolve, reject) => {
    pending.set(call, { resolve, reject });
    self.postMessage({ kind: 'page', op, args, call }, transfer);
  });
}
export function message(ev) {
  const m = ev.data;
  if (m?.kind === 'page-reply' && pending.has(m.call)) {
    const p = pending.get(m.call); pending.delete(m.call);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  }
}

// --- the helper ------------------------------------------------------------------------
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
let system = null;          // from the page, once: { os, chip }
// The download for this computer: {download, downloadText, file, other?}. A
// computer it can't tell gets the release page, with every download on it.
async function download(text) {
  system ||= await page('system').catch(() => ({}));
  const key = system.os === 'windows' ? 'windows' : system.os === 'mac' ? `mac-${system.chip}` : null;
  if (!DOWNLOADS[key]) return { download: RELEASE, downloadText: text || 'Download the helper (Windows or Mac)', page: true };
  const d = DOWNLOADS[key];
  const out = { download: FILES + d.file, downloadText: text || `Download the helper ${d.label}`, file: d.file };
  if (system.os === 'mac') {
    const o = DOWNLOADS[key === 'mac-intel' ? 'mac-apple-silicon' : 'mac-intel'];
    out.other = { href: FILES + o.file, text: o.other };
  }
  return out;
}
async function helper() {
  try {
    const v = await (await fetch(HELPER + '/version', { signal: AbortSignal.timeout(1500) })).json();
    if ((v.protocol || 0) < HELPER_PROTOCOL) return { notice: { kind: 'notice', text: `The Vocalgraph helper on this computer (${v.version}) is too old for this page.`, ...await download('Download the new helper') } };
    // A Mac being asked for the recording permission waits for macOS (up to 10 s).
    const apps = await (await fetch(HELPER + '/apps', { signal: AbortSignal.timeout(15000) })).json();
    const notice = newer(HELPER_LATEST, v.version)
      ? { kind: 'notice', text: `A newer Vocalgraph helper (${HELPER_LATEST}) is available.`, ...await download('Download it') } : null;
    return { apps: apps.map(a => ({ ...a, kind: 'app' })), notice };
  } catch {
    // auto: the page may start this download itself when Start finds no
    // helper, if it has never seen one in this browser.
    return { notice: { kind: 'notice', text: "To record one program's sound (a call, a video), Vocalgraph needs its small helper app on this computer.",
      start: 'vocalgraph://start', auto: true, ...await download() } };
  }
}

// --- routes ---------------------------------------------------------------------------
export async function get(what, req) {
  if (what === 'devices') {
    warm().catch(() => {});
    const [mics, h] = await Promise.all([page('mics').catch(() => []), helper()]);
    return json([...mics, ...(h.apps || []), ...(h.notice ? [h.notice] : [])]);
  }
  if (!live) return what === 'state' ? json({ status: 'idle' }) : error(404, 'No live session.');
  if (what === 'state') return json(await state());
  if (what === 'frames') return json(live.session.frames(parseInt(req.query.get('from') || '0', 10)));
  if (what === 'voice') {
    let spk = req.query.get('spk') || 'all'; if (spk !== 'all') spk = parseInt(spk, 10);
    const points = Math.max(100, Math.min(20000, parseInt(req.query.get('points') || String(E.MAX_POINTS), 10) || E.MAX_POINTS));
    return json(live.session.voiceFor(spk, points, req.query.get('gate') === '1'));
  }
  return error(404, 'Not found.');
}

async function state() {
  const s = live.session;
  const out = s.state({ id: live.id, status: live.status, error: live.error || s.error || null, label: live.label, kind: live.kind,
    format: live.format, warnings: live.warnings });
  if (live.inputs) out.input_stats = live.inputs.list.map(i => ({ name: i.name, channels: i.channels, ...(i.stats || {}) }));
  out.preparing = s.preparing && live.status === 'live';
  // Microphones giving no sound: while recording, and as they were at the end.
  out.silent = live.inputs && live.status === 'live' ? live.inputs.silent() : live.silent || [];
  const jid = lastJob.get(live.id);
  if (jid) {
    const meta = await store.jobs.get(jid);
    if (!meta) { if (live.status === 'stopped') { live = null; return { status: 'idle' }; } }
    else {
      const st = JSON.parse((await jobs.status(jid)).body);
      out.job = { id: jid, status: st.status, stage: st.stage, frac: st.frac, error: st.error };
    }
  }
  return out;
}

export async function post(what, req) {
  const body = req.json();
  if (what === 'start') return start(body);
  if (what === 'stop') { if (!live) return error(404, 'No live session.'); stop(); return json({ ok: true }); }
  if (what === 'discard') { if (!live) return error(404, 'No live session.'); await discard(); return json({ ok: true }); }
  if (what === 'new') {
    if (live && ['starting', 'live', 'stopping', 'finishing'].includes(live.status)) return error(409, 'A live session is still running.');
    live = null; return json({ ok: true });
  }
  if (what === 'settings') {
    if (!live) return error(404, 'No live session.');
    if ('num_speakers' in body) {
      let n = body.num_speakers; n = n === null || n === '' || n === 0 ? null : parseInt(n, 10);
      if (n !== null && !(n >= 1 && n <= 20)) return error(400, 'Number of speakers must be between 1 and 20.');
      live.session.numSpeakers = n; live.session.askRegroup = true; live.session.kick();
    }
    return json({ ok: true });
  }
  if (what === 'names') {
    if (!live) return error(404, 'No live session.');
    for (const [k, v] of Object.entries(body)) { const n = parseInt(k, 10); if (!Number.isNaN(n)) live.session.speakerNames[n] = String(v).trim().slice(0, 60); }
    const jid = lastJob.get(live.id);
    if (jid) await jobs.setAnchors(jid, live.session.anchors());
    return json({ ok: true });
  }
  return error(404, 'Not found.');
}

const newId = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');

async function start(body) {
  if (live && ['starting', 'live', 'stopping', 'finishing'].includes(live.status)) return error(409, 'A live session is already running.');
  const fmt = FORMATS.includes(body.format) ? body.format : 'm4a';
  const id = newId();
  if (body.replay) { const [models, smile] = await warm(); return startReplay(id, String(body.replay), fmt, models, smile, body); }
  const devs = (body.devices || (body.device ? [{ id: body.device, name: body.device_name }] : []))
    .filter(d => d && d.id).slice(0, 8);
  if (!devs.length) return error(400, 'Choose a microphone.');
  // The computer's sound (page.js) gets a short name for its track.
  const names = devs.map(d => d.id === 'system:' ? 'Computer sound' : String(d.name || d.id));
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(`live-${id}`, { create: true });
  const session = new Session({ tracks: devs.length > 1 ? devs.length : 0, names });
  session.numSpeakers = body.num_speakers ? parseInt(body.num_speakers, 10) : null;
  const inputs = new Inputs(dir, (mix, ins) => { session.feed(mix, ins); if (live?.status === 'starting') live.status = 'live'; });
  live = { id, status: 'starting', error: null, label: names.join(' + '), kind: 'device', format: fmt, session, inputs, names,
           warnings: [], started: Date.now(), dir, dirName: `live-${id}` };
  try {
    for (const [i, d] of devs.entries()) {
      if (String(d.id).startsWith('app:')) {
        const inp = await inputs.add(d.id, names[i], 2);
        await inputs.connectHelper(inp, `${HELPER_WS}/capture?app=${encodeURIComponent(String(d.id).slice(4))}`);
      } else {
        const { port1, port2 } = new MessageChannel();
        const opened = await page('openMic', { id: d.id, deviceId: String(d.id).replace(/^mic:/, '') }, [port2]);
        const inp = await inputs.add(d.id, names[i], opened.channels);
        port1.onmessage = (e) => { if (e.data?.kind === 'pcm') inputs.pcmFromPage(e.data, opened.clock); };
        inp.close = () => page('closeMic', { id: d.id }).catch(() => {});
      }
    }
    inputs.begin();
    const L = live;
    L.ready = warm().then(([models, smile]) => session.ready(models, smile))
      .catch((e) => { L.warnings.push(`The analysis couldn't start (${e.message || e}); the sound is still being recorded.`); });
  } catch (e) {
    await teardown();
    live.status = 'error'; live.error = e.message || String(e);
    return error(400, live.error);
  }
  return json({ id });
}

// Replay a saved recording at its own speed, as if live (with its tracks,
// if it has a track per input after the mix).
async function startReplay(id, jobId, fmt, models, smile, body) {
  const meta = await store.jobs.get(jobId);
  if (!meta) return error(404, 'No such recording.');
  const blob = await store.files.get(jobId, 'input');
  const titles = await ff.streams(blob, meta.input_file);
  const tracks = titles.length >= 3 ? titles.length - 1 : 0;
  const names = tracks ? titles.slice(1).map((t, i) => t || `Input ${i + 1}`) : [];
  const mix = await E.decode(blob, meta.input_file, 0);
  const ins = [];
  for (let i = 1; i <= tracks; i++) ins.push(await E.decode(blob, meta.input_file, i));
  const session = new Session({ tracks, names, models, smile });
  session.numSpeakers = body.num_speakers ? parseInt(body.num_speakers, 10) : null;
  live = { id, status: 'live', error: null, label: `Replay of ${meta.name.replace(/\.[^.]*$/, '')}`, kind: 'file', format: fmt,
           session, names, warnings: [], started: Date.now(), replay: { blob, name: meta.input_file, ext: (meta.input_file.match(/\.[^.]*$/) || ['.m4a'])[0] } };
  const step = 800, t0 = performance.now();     // 50 ms at 16 kHz
  let at = 0;
  live.timer = setInterval(() => {
    const due = Math.floor((performance.now() - t0) / 1000 * 16000);
    while (at + step <= Math.min(due, mix.length)) {
      session.feed(mix.subarray(at, at + step), tracks ? ins.map(t => t.subarray(at, at + step)) : null);
      at += step;
    }
    if (at + step > mix.length) stop();
  }, 25);
  return json({ id });
}

function stop() {
  if (!live || !['starting', 'live'].includes(live.status)) return;
  live.status = 'stopping';
  if (live.timer) clearInterval(live.timer);
  if (live.inputs) { live.silent = live.inputs.silent(); live.inputs.stop(); for (const inp of live.inputs.list) inp.close?.(); }
  live.session.end();
  live.status = 'finishing';
  finish(live).catch(e => { live.status = 'error'; live.error = e.message || String(e); console.error(e); });
}

async function teardown() {
  if (!live) return;
  if (live.timer) clearInterval(live.timer);
  if (live.inputs) { try { live.inputs.stop(); } catch {} for (const inp of live.inputs.list) inp.close?.(); }
  if (live.dirName) { try { await (await navigator.storage.getDirectory()).removeEntry(live.dirName, { recursive: true }); } catch {} }
}

async function discard() {
  live.discarded = true;
  await teardown();
  const jid = lastJob.get(live.id);
  if (jid) { try { await jobs.remove(jid); } catch {} }
  live = null;
}

// The session has ended: wait for the analysis to catch up, make the
// recording, and file it in the library.
async function finish(L) {
  const s = L.session;
  await L.ready;                          // stopped before the models had loaded: analyse it all now
  const settled = async () => { do await new Promise(r => setTimeout(r, 50)); while (s.busy); };
  await settled();                        // the last windows and voice blocks (end() started them)
  s.askRegroup = true; s.kick();
  await settled();                        // and a final grouping on all of it
  if (L.discarded) return;
  L.status = 'stopped';
  if (s.n < 16000 / 2) { await teardown(); return; }     // under half a second: nothing worth keeping
  const stamp = new Date(L.started);
  const pad = (v) => String(v).padStart(2, '0');
  const when = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}.${pad(stamp.getMinutes())}`;
  let blob, ext;
  if (L.kind === 'file') {
    ext = L.replay.ext;
    blob = await ff.cut(L.replay.blob, L.replay.name, s.n / 16000);
  } else {
    const tracks = [];
    for (const [i, inp] of L.inputs.list.entries()) {
      const f = await (await L.dir.getFileHandle(`input${i}.s16`)).getFile();
      tracks.push({ data: new Uint8Array(await f.arrayBuffer()), channels: inp.channels, name: inp.name });
    }
    ({ blob, ext } = await ff.encodeLive(tracks, IN_RATE, L.format, `Vocalgraph live: ${L.inputs.summary()}`));
  }
  const name = (L.kind === 'device' ? `Live ${when}` : L.label) + ext;
  // The saved file can start slightly later than the live stream (AAC's
  // lead-in): line the two up, then file the analysis with it.
  let extra = { anchors: s.anchors(), num_speakers: s.numSpeakers };
  try {
    const saved = await E.decode(blob, 'input' + ext, 0, 31);
    const offset = E.offsetOf(saved, s.x.view());
    const a = s.analysisToSave(offset);
    if (a) extra = { ...extra, prep_from_live: true, prep_segments: [[offset, offset + s.n / 16000]], prep: a.prep,
                     files: { voice_frames: a.frames } };
  } catch (e) { console.warn('live analysis not kept:', e); }
  if (s.tracks) extra.tracks = [...L.names];
  if (L.inputs) extra.live_inputs = L.inputs.summary();
  const job = await jobs.register(blob, name, null, extra);
  lastJob.set(L.id, job.id);
  await teardown();
}
