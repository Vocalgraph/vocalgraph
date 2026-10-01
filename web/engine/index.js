// The engine as the browser backend uses it: one place that ties together
// the ports of the Python modules (each checked against Python by test/):
//   analysis.js  core.py's silence analysis       timeline.js  timeline.py
//   speakers.js  speakers.py (with linkage.js)    sources.js   sources.py
//   voice.js     voice.py                         measure.js   live.measure & co
// and the WebAssembly builds: FFmpeg (decode / cut / encode, as core.py runs
// it) and openSMILE (voice measures).
import * as analysis from './analysis.js';
import * as speakers from './speakers.js';
import * as sources from './sources.js';
import * as voice from './voice.js';
import * as M from './measure.js';
export { Timeline, concat, intersect, union } from './timeline.js';
import { loadSmile } from '../smile/smile.js';
import * as ff from './ffmpeg-ops.js';

export const MAX_POINTS = voice.MAX_POINTS;
export const RATE = analysis.RATE;

// --- audio (FFmpeg) ----------------------------------------------------------------
export const decode = ff.decode;          // (blob, name, stream=0) -> Float32Array, 16 kHz mono
export const streams = ff.streams;        // (blob, name) -> [title or ''] per audio stream
export const render = ff.render;          // (blob, name, segs, {fmt, stream, progress}) -> {blob, duration}

// --- analysis --------------------------------------------------------------------
export const analyze = (x, opts) => analysis.analyze(x, opts);

// --- speakers --------------------------------------------------------------------
export const prepare = (x, models, progress) => speakers.prepare(x, models, progress);
// Turns as [start, end, speaker] (speakers.assign gives Turn-like objects).
export const assign = (prep, n) => speakers.assign(prep, n).map(t => [t.start, t.end, t.speaker]);
// The same, with the background's spans: { turns, background: [[start, end]] }.
export const group = (prep, n) => {
  const g = speakers.group(prep, n);
  return { turns: g.turns.map(t => [t.start, t.end, t.speaker]), background: g.background };
};

// --- each input on its own track -------------------------------------------------
export const levels = (x) => sources.levels(x, RATE);
export const lag = sources.lag;
export const shift = sources.shift;
export const activity = (levelsList) => sources.activity(levelsList);
export function refine(turns, act, until = null) {
  const [t, homes] = sources.refine(turns, act, until);
  return { turns: t, homes: Object.fromEntries(homes) };
}
// Is the first stream the mix of the others? Its level follows their combined
// level (server.py _track_activity): correlation above 0.8 over the frames
// where anything is louder than -80 dB.
export function isMixOf(mix, tracks) {
  const n = mix.length, both = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (const t of tracks) s += 10 ** (t[i] / 10); both[i] = 10 * Math.log10(s + 1e-20); }
  const a = [], b = [];
  for (let i = 0; i < n; i++) if (Math.max(mix[i], both[i]) > -80) { a.push(mix[i]); b.push(both[i]); }
  if (a.length <= 50) return false;
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length, ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return sab / Math.sqrt(saa * sbb) > 0.8;
}

// --- voice -----------------------------------------------------------------------
let smile = null;
export async function metrics(x, gate, { place = null, duration = null, points = null } = {}) {
  smile ??= await loadSmile();
  return voice.metrics(smile, x, { gate, place, timelineDuration: duration, points });
}
export const measure = M.measure;
export const framesOf = M.framesOf;
export const join = M.join;
export const offsetOf = M.offsetOf;
export { speakers, sources, voice, analysis };
