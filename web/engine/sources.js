// Speakers on their own inputs (vocalgraph/sources.py): a recording made from
// several inputs keeps each input as a track of its own next to the mix. When
// one speaker's speech comes almost entirely from one input that carries
// nobody else, their turns are re-read off that track, so crosstalk is marked
// for both people.
//
// Levels are per HOP (20 ms) of 16 kHz mono audio, in dB. An activity matrix
// is { frames, inputs, data: Uint8Array(frames * inputs) } (row-major, as the
// NumPy (frames, inputs) bool array). Turns are [start, end, speaker] arrays;
// homes are Maps, in Python's dict order.

import { pairwiseSum, percentile, pyRound } from './npcompat.js';
import { MIN_TURN } from './speakers.js';

export const HOP = 0.02;
export const HOME_SHARE = 0.8;
export const OWN_SHARE = 0.8;
export const MIN_EVIDENCE = 3.0;
export const JOIN = 0.3;
export const MIN_RUN = 0.2;
export const SPEECH_PAD = 0.3;

/** Loudness (dB RMS) of each HOP of 16 kHz mono audio: Float64Array. */
export function levels(x, rate) {
  const n = Math.trunc(HOP * rate);
  const frames = Math.floor(x.length / n);
  const out = new Float64Array(frames);
  const sq = new Float64Array(n);
  for (let f = 0; f < frames; f++) {
    const o = f * n;
    for (let i = 0; i < n; i++) { const v = x[o + i]; sq[i] = v * v; }
    out[f] = 20 * Math.log10(Math.sqrt(pairwiseSum(sq, 0, n) / n) + 1e-10);
  }
  return out;
}

function mean(a, lo, hi) { return pairwiseSum(a, lo, hi - lo) / (hi - lo); }

// np.corrcoef(x, y)[0, 1] for equal-length slices (float64; NumPy forms the
// covariance with a BLAS product, so the last bits can differ).
function corr(a, ao, b, bo, n) {
  const ma = mean(a, ao, ao + n), mb = mean(b, bo, bo + n);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[ao + i] - ma, db = b[bo + i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  const c = (sab / (n - 1)) / Math.sqrt(saa / (n - 1)) / Math.sqrt(sbb / (n - 1));
  return Math.max(-1, Math.min(1, c));
}

function constant(a, lo, hi) {
  for (let i = lo + 1; i < hi; i++) if (a[i] !== a[lo]) return false;
  return true;
}

/**
 * How much earlier `track` runs than the mix it went into, in seconds
 * (levels of each, per HOP): its sound at t is the mix's at t + lag.
 */
export function lag(mix, track, most = 0.5) {
  const n = Math.min(mix.length, track.length);
  const a = new Float64Array(n), b = new Float64Array(n);
  for (let i = 0; i < n; i++) { a[i] = Math.max(mix[i], -80.0); b[i] = Math.max(track[i], -80.0); }
  const span = Math.trunc(most / HOP);
  let best = 0, score = -Infinity;
  for (let L = -span; L <= span; L++) {
    const xo = Math.max(0, L), xe = n + Math.min(0, L), yo = Math.max(0, -L);
    const len = xe - xo;
    if (len < 50 || constant(a, xo, xe) || constant(b, yo, yo + len)) continue;
    const c = corr(a, xo, b, yo, len);
    if (c > score) { best = L; score = c; }
  }
  return best * HOP;
}

/** Levels moved `by` seconds later (earlier if negative), filled with quiet. */
export function shift(lv, by) {
  const k = pyRound(by / HOP);
  const out = new Float64Array(lv.length).fill(-200.0);
  if (k >= 0) out.set(lv.subarray(0, Math.max(0, lv.length - k)), Math.min(k, lv.length));
  else out.set(lv.subarray(Math.min(-k, lv.length)), 0);
  return out;
}

/** Where speech on a track starts: well above its quiet, within 35 dB of its loudest. */
export function threshold(db) {
  if (!db.length) return 0.0;
  return Math.max(percentile(db, 10) + 15, percentile(db, 99) - 35, -75);
}

/** Who is making sound, per HOP: { frames, inputs, data }. */
export function activity(tracks, thresholds = null) {
  const frames = Math.min(...tracks.map((t) => t.length));
  const thr = thresholds && thresholds.length ? thresholds : tracks.map((t) => threshold(t));
  const inputs = tracks.length;
  const data = new Uint8Array(frames * inputs);
  for (let i = 0; i < inputs; i++) {
    const t = tracks[i], th = thr[i];
    for (let f = 0; f < frames; f++) data[f * inputs + i] = t[f] > th ? 1 : 0;
  }
  return { frames, inputs, data };
}

function grid(spans, n) {
  const m = new Uint8Array(n);
  for (const [a, b] of spans) {
    const lo = Math.max(0, Math.trunc(a / HOP)), hi = Math.min(n, Math.ceil(b / HOP));
    if (hi > lo) m.fill(1, lo, hi);
  }
  return m;
}

/** Runs of true as [start, end] seconds, joined across JOIN, without bursts under MIN_RUN. */
function runs(mask, t0 = 0.0) {
  const out = [];
  let a = -1;
  for (let i = 0; i <= mask.length; i++) {
    const on = i < mask.length && mask[i];
    if (on && a < 0) a = i;
    else if (!on && a >= 0) {
      const s = t0 + a * HOP, e = t0 + i * HOP;
      if (out.length && s - out[out.length - 1][1] <= JOIN) out[out.length - 1][1] = e;
      else out.push([s, e]);
      a = -1;
    }
  }
  return out.filter(([s, e]) => e - s >= MIN_RUN);
}

function sliceAct(act, n) {
  return { frames: n, inputs: act.inputs, data: act.data.subarray(0, n * act.inputs) };
}

/**
 * [home, own]: Map speaker -> input, where one input clearly carries their
 * speech; Map input -> speaker, for inputs that carry only that speaker.
 */
export function homes(turns, act) {
  const { frames: n, inputs, data } = act;
  const ids = [...new Set(turns.map((t) => t[2]))].sort((x, y) => x - y);
  const grids = new Map(ids.map((k) => [k, grid(turns.filter((t) => t[2] === k), n)]));
  const anyone = new Int32Array(n);
  for (const g of grids.values()) for (let i = 0; i < n; i++) anyone[i] += g[i];
  const alone = new Uint8Array(n), which = new Int32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0, w = -1;
    for (let i = 0; i < inputs; i++) if (data[f * inputs + i]) { s++; if (w < 0) w = i; }
    alone[f] = s === 1 ? 1 : 0;
    which[f] = w < 0 ? 0 : w;
  }
  const home = new Map();
  for (const k of ids) {
    const g = grids.get(k);
    const bins = new Float64Array(inputs);
    let total = 0;
    for (let f = 0; f < n; f++) if (g[f] && anyone[f] === 1 && alone[f]) { total++; bins[which[f]]++; }
    if (total * HOP < MIN_EVIDENCE) continue;
    let best = 0;
    for (let i = 1; i < inputs; i++) if (bins[i] / total > bins[best] / total) best = i;
    if (bins[best] / total >= HOME_SHARE) home.set(k, best);
  }
  const own = new Map();
  for (let i = 0; i < inputs; i++) {
    const mine = [...home].filter(([, h]) => h === i).map(([k]) => k);
    if (mine.length !== 1) continue;
    const g = grids.get(mine[0]);
    let here = 0, both = 0;
    for (let f = 0; f < n; f++) {
      if (alone[f] && which[f] === i && anyone[f] >= 1) { here++; if (g[f]) both++; }
    }
    if (here && both / here >= OWN_SHARE) own.set(i, mine[0]);
  }
  return [home, own];
}

/**
 * The grouping's turns with speakers on inputs of their own re-read from
 * those tracks: [turns, homes] (only up to `until` seconds, if given).
 */
export function refine(turns, act, until = null) {
  if (!act || act.inputs < 2 || !turns.length) return [turns.map((t) => [...t]), new Map()];
  const n = until === null ? act.frames : Math.min(act.frames, Math.trunc(until / HOP));
  act = sliceAct(act, n);
  const [home, own] = homes(turns, act);
  if (!own.size) return [turns.map((t) => [...t]), home];
  const speech = grid(turns.map(([a, b]) => [a - SPEECH_PAD, b + SPEECH_PAD]), n);
  const out = [];
  const owned = new Uint8Array(n);
  for (const [i, k] of own) {
    const col = new Uint8Array(n);
    for (let f = 0; f < n; f++) col[f] = act.data[f * act.inputs + i] & speech[f];
    const r = runs(col);
    for (const [a, b] of r) out.push([a, b, k]);
    const g = grid(r, n);
    for (let f = 0; f < n; f++) owned[f] |= g[f];
  }
  const mine = new Set(own.values());
  const rest = [...new Set(turns.map((t) => t[2]))].filter((k) => !mine.has(k)).sort((x, y) => x - y);
  for (const k of rest) {
    const g = grid(turns.filter((t) => t[2] === k), n);
    for (let f = 0; f < n; f++) g[f] &= owned[f] ^ 1;
    const pieces = runs(g);
    if (pieces.length && Math.max(...pieces.map(([a, b]) => b - a)) >= MIN_TURN) {
      for (const [a, b] of pieces) out.push([a, b, k]);
    } else if (home.has(k)) home.delete(k);
  }
  const left = new Set(out.map((t) => t[2]));
  out.sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]));
  return [out, new Map([...home].filter(([k]) => left.has(k)))];
}
