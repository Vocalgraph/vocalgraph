// Voice measures from frames already measured, and the span helpers they use
// (vocalgraph/live.py: measure, _join, _overlap, _inside, frames_of, offset_of).
import { searchRight, tupleCompare } from './npcompat.js';
import { FORMANTS, MIN_HNR_DB, binByTime, summary, to16bit } from './voice.js';

export const RATE = 16000;
export const JOIN_GAP = 0.3;       // speakers.JOIN_GAP
export const VOICE_HOP = 0.01;     // openSMILE frame step

/** Merge a speaker's turns ([start, end, speaker]) across short gaps; sorted. */
export function join(turns, gap = JOIN_GAP) {
  const by = new Map();
  for (const [a, b, k] of [...turns].sort(tupleCompare)) {
    let runs = by.get(k);
    if (!runs) by.set(k, (runs = []));
    const last = runs[runs.length - 1];
    if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b);
    else runs.push([a, b]);
  }
  const out = [];
  for (const [k, runs] of by) for (const [a, b] of runs) out.push([a, b, k]);
  return out.sort(tupleCompare);
}

/** Total overlap between two sorted, non-overlapping span lists. */
export function overlap(a, b) {
  let i = 0, j = 0, total = 0.0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]), hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) total += hi - lo;
    if (a[i][1] < b[j][1]) i += 1; else j += 1;
  }
  return total;
}

/** Which times fall inside a sorted, non-overlapping list of spans (Uint8Array of 0/1). */
export function inside(t, spans) {
  const out = new Uint8Array(t.length);
  if (!spans.length) return out;
  const starts = spans.map((s) => s[0]), ends = spans.map((s) => s[1]);
  for (let i = 0; i < t.length; i++) {
    const idx = searchRight(starts, t[i]) - 1;
    out[i] = idx >= 0 && t[i] < ends[Math.max(idx, 0)] ? 1 : 0;
  }
  return out;
}

/** (times, measures) of the frames that speak for someone on input `home`, or
 * for someone on no one input (null): the loudest input's at each moment.
 * frames: {t, raw, src} with src null or {input: Int8Array, prim: Uint8Array}. */
export function framesOf({ t, raw, src }, home) {
  if (!src) return { t, raw };
  const keep = [];
  for (let i = 0; i < t.length; i++) if (home !== null && home !== undefined ? src.input[i] === home : src.prim[i]) keep.push(i);
  const pick = (a) => Float64Array.from(keep, (i) => a[i]);
  return { t: pick(t), raw: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, pick(v)])) };
}

/** Voice measures for the frames inside `spans`, from frames already measured
 * (t: Float64Array of frame centres; raw: {f0, f1, f2, f3, loudness, hnr} as
 * Float64Arrays with NaN where undefined), laid out by place(t) on a timeline of
 * `duration` with `points` bins, and summarised. */
export function measure(t, raw, spans, gate, place, duration, points) {
  const mask = inside(t, [...spans].sort(tupleCompare));
  const f0 = Float64Array.from(raw.f0);
  if (gate) for (let i = 0; i < f0.length; i++) if (!(raw.hnr[i] > MIN_HNR_DB)) f0[i] = NaN;
  const vals = { f0 };
  for (const key of FORMANTS) {
    const v = Float64Array.from(raw[key]);
    for (let i = 0; i < v.length; i++) if (Number.isNaN(f0[i])) v[i] = NaN;
    vals[key] = v;
  }
  for (const key of ['loudness', 'hnr']) vals[key] = raw[key];
  const at = new Float64Array(t.length).fill(NaN);
  const idx = [];
  for (let i = 0; i < t.length; i++) if (mask[i]) idx.push(i);
  if (idx.length) {
    const placed = place(Float64Array.from(idx, (i) => t[i]));
    idx.forEach((i, j) => { at[i] = placed[j]; });
  }
  const series = Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, binByTime(v, at, duration, points)]));
  const times = Array.from({ length: points }, (_, i) => duration * (i + 0.5) / points);
  const mine = Object.fromEntries(Object.entries(vals).map(([k, v]) =>
    [k, idx.map((i) => (Number.isNaN(v[i]) ? null : v[i]))]));
  const stats = summary(mine, idx.length * VOICE_HOP);
  return { duration, time: times, series, stats };
}

// In-place iterative radix-2 complex FFT (re, im: Float64Array of a power-of-2 length).
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const half = len >> 1;
    const wr = new Float64Array(half), wi = new Float64Array(half);
    for (let k = 0; k < half; k++) { wr[k] = Math.cos(ang * k); wi[k] = Math.sin(ang * k); }
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * wr[k] - im[b] * wi[k], xi = re[b] * wi[k] + im[b] * wr[k];
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

/** How much later a saved recording starts than the live stream `x`, in
 * seconds, found by lining up their first `seconds` (live.offset_of).
 * `saved`: the saved file decoded (16 kHz mono float32, at least its first
 * seconds + 0.5 s; decoding is the caller's). */
export function offsetOf(saved, x, seconds = 30.0) {
  const n = Math.min(x.length, Math.trunc(seconds * RATE));
  if (n < RATE) return 0.0;
  const s16 = to16bit(saved.subarray(0, Math.min(saved.length, n + RATE / 2)));
  const a = x.subarray(0, n), b = s16;
  if (!a.some((v) => v !== 0) || b.length < n) return 0.0;
  const size = 2 ** Math.ceil(Math.log2(a.length + b.length));
  // Both signals are real: one complex FFT holds both (b real, a imaginary).
  const re = new Float64Array(size), im = new Float64Array(size);
  re.set(b); im.set(a);
  fft(re, im);
  // B = (Z[k] + conj Z[-k]) / 2, A = (Z[k] - conj Z[-k]) / 2i; want B * conj(A).
  const pr = new Float64Array(size), pi = new Float64Array(size);
  for (let k = 0; k < size; k++) {
    const m = (size - k) & (size - 1);
    const zr = re[k], zi = im[k], cr = re[m], ci = -im[m];
    const Br = (zr + cr) / 2, Bi = (zi + ci) / 2;
    const Ar = (zi - ci) / 2, Ai = -(zr - cr) / 2;
    pr[k] = Br * Ar + Bi * Ai;          // B * conj(A)
    pi[k] = Bi * Ar - Br * Ai;
  }
  fft(pr, pi, true);
  let best = 0, bestV = -Infinity;
  for (let lag = 0; lag < RATE / 2; lag++) if (pr[lag] > bestV) { bestV = pr[lag]; best = lag; }
  return best / RATE;
}
