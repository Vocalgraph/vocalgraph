// Find silence and pick the threshold: vocalgraph/core.py's analysis, ported
// to JavaScript with the same numbers (see core.py for the reasoning).
//
// Input: the recording as 16 kHz mono float32 samples (a Float32Array),
// exactly what core.decode gives. Decoding and rendering live elsewhere.
import { pairwiseSum, median, pyRound, pyFixed, pySum, pySumMixed } from './npcompat.js';

export const RATE = 16000;         // analysis sample rate
export const WIN = 0.05;           // seconds per loudness window
export const HOP = 0.01;           // seconds per silence-detection window
export const ABOVE_BACKGROUND = 6.0;   // dB: clearly distinguishable from the background
export const BELOW_VOICE = 30.0;       // dB: loud enough to hear next to the voice

// RMS loudness (dBFS) of each `seconds`-long block (the last partial one dropped).
function blockDb(x, seconds) {
  const n = Math.trunc(seconds * RATE);
  const count = Math.floor(x.length / n);
  const out = new Float64Array(count);
  const sq = new Float64Array(n);
  for (let f = 0; f < count; f++) {
    const base = f * n;
    for (let i = 0; i < n; i++) { const v = x[base + i]; sq[i] = v * v; }
    const rms = Math.sqrt(pairwiseSum(sq, 0, n) / n);
    out[f] = 20 * Math.log10(Math.max(rms, 1e-10));
  }
  return out;
}

/** Loudness (dBFS, RMS) of each WIN-second window. */
export const windowDb = (x) => blockDb(x, WIN);

/** RMS loudness of each HOP-second window, for silence detection. */
export const hopDb = (x) => blockDb(x, HOP);

/** Otsu's threshold: the cut that best separates two clusters of values
 * (np.histogram's binning reproduced exactly). */
export function otsu(values, bins = 256) {
  let first = Infinity, last = -Infinity;
  for (const v of values) { if (v < first) first = v; if (v > last) last = v; }
  if (first === last) { first -= 0.5; last += 0.5; }
  // np.linspace(first, last, bins + 1)
  const edges = new Float64Array(bins + 1);
  const delta = last - first, step = delta / bins;
  for (let i = 0; i <= bins; i++) edges[i] = step === 0 ? (i / bins) * delta + first : i * step + first;
  edges[bins] = last;
  const hist = new Float64Array(bins);
  const denom = last - first;
  for (const v of values) {
    if (!(v >= first && v <= last)) continue;
    let idx = Math.trunc(((v - first) / denom) * bins);
    if (idx === bins) idx -= 1;
    if (v < edges[idx]) idx -= 1;
    if (idx !== bins - 1 && v >= edges[idx + 1]) idx += 1;
    hist[idx] += 1;
  }
  const mids = new Float64Array(bins);
  for (let i = 0; i < bins; i++) mids[i] = (edges[i] + edges[i + 1]) / 2;
  const w0 = new Float64Array(bins), s0 = new Float64Array(bins);
  let cw = 0, cs = 0;
  for (let i = 0; i < bins; i++) {
    cw += hist[i]; w0[i] = cw;
    cs += hist[i] * mids[i]; s0[i] = cs;
  }
  let best = 0, bestScore = -Infinity;
  for (let i = 0; i < bins; i++) {
    const w1 = cw - w0[i];
    const m0 = s0[i] / Math.max(w0[i], 1);
    const m1 = (cs - s0[i]) / Math.max(w1, 1);
    const d = m0 - m1;
    const score = (w0[i] * w1) * (d * d);
    if (score > bestScore) { bestScore = score; best = i; }   // np.argmax: the first maximum
  }
  return mids[best];
}

/** Loudness above which a sound counts as audible, and must not be cut. */
export function audibleLevel(floor, voice) {
  return Math.max(floor + ABOVE_BACKGROUND, voice - BELOW_VOICE);
}

/** Runs of HOP windows quieter than the threshold lasting at least minSilence,
 * as [start, end] seconds. */
export function silences(levels, thresholdDb, minSilence) {
  const need = pyRound(minSilence / HOP);
  const out = [];
  let start = -1;
  for (let i = 0; i <= levels.length; i++) {
    const quiet = i < levels.length && levels[i] < thresholdDb;
    if (quiet && start < 0) start = i;
    else if (!quiet && start >= 0) {
      if (i - start >= need) out.push([start * HOP, i * HOP]);
      start = -1;
    }
  }
  return out;
}

/** Invert silences into sound, pad each piece, merge any that now touch. */
export function keepSegments(sil, duration, pad) {
  return keepTyped(sil, duration, pad).map(([a, b]) => [a, b]);
}

// keepSegments, also tracking which ends are Python floats rather than numpy
// float64s (silence edges are numpy; 0.0 and the duration are Python), since
// Python's sum() of the kept lengths adds the two kinds differently.
// Python's max(p, q) returns p unless q > p; min(p, q) returns p unless q < p.
function keepTyped(sil, duration, pad) {
  const keep = [];
  let cursor = 0.0, cursorPy = true;
  for (const [a, b] of sil) {
    if (a > cursor) keep.push([cursor, a, cursorPy, false]);
    cursor = b; cursorPy = false;
  }
  if (cursor < duration) keep.push([cursor, duration, cursorPy, true]);
  const merged = [];
  for (const [a0, b0, pa0, pb0] of keep) {
    const x = a0 - pad, y = b0 + pad;
    const [a, pa] = x > 0.0 ? [x, pa0] : [0.0, true];
    const [b, pb] = y < duration ? [y, pb0] : [duration, true];
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) {
      if (b > last[1]) { last[1] = b; last[3] = pb; }
    } else merged.push([a, b, pa, pb]);
  }
  return merged;
}

/** The removed stretches between kept segments. */
export function gaps(segs, duration) {
  const out = [];
  let cursor = 0.0;
  for (const [a, b] of segs) {
    if (a > cursor) out.push([cursor, a]);
    cursor = b;
  }
  if (cursor < duration) out.push([cursor, duration]);
  return out;
}

export class Trial {
  constructor(threshold, kept, lost, lostSpans = [], segments = []) {
    this.threshold = threshold;
    this.kept = kept;
    this.lost = lost;               // seconds of audible sound cut
    this.lost_spans = lostSpans;    // [gap start, gap end, audible seconds, peak dB]
    this.segments = segments;       // kept [start, end] in source seconds
  }
}

export class Analysis {
  constructor(duration, noiseFloor, speechLevel, audibleAbove, trials, chosen, note = '', x = null) {
    this.duration = duration;
    this.noise_floor = noiseFloor;
    this.speech_level = speechLevel;
    this.audible_above = audibleAbove;
    this.trials = trials;
    this.chosen = chosen;
    this.note = note;
    this.x = x;                     // the decoded 16 kHz mono samples, if kept
  }

  trial(threshold) {
    const t = this.trials.find((tr) => tr.threshold === threshold);
    if (!t) throw new Error(`No trial at ${threshold} dB`);
    return t;
  }

  /** Everything except the decoded audio: the same JSON as core.Analysis.to_dict. */
  toDict() {
    return {
      duration: this.duration, noise_floor: this.noise_floor,
      speech_level: this.speech_level, audible_above: this.audible_above,
      chosen: this.chosen, note: this.note,
      trials: this.trials.map((t) => ({
        threshold: t.threshold, kept: t.kept, lost: t.lost,
        lost_spans: t.lost_spans.map((s) => [...s]), segments: t.segments.map((s) => [...s]),
      })),
    };
  }

  static fromDict(d) {
    const trials = d.trials.map((t) => new Trial(t.threshold, t.kept, t.lost,
      t.lost_spans.map((s) => [...s]), t.segments.map((s) => [...s])));
    return new Analysis(d.duration, d.noise_floor, d.speech_level, d.audible_above,
      trials, d.chosen, d.note ?? '');
  }
}

/** core.analyze on already-decoded samples. Options as in Python:
 * minSilence 0.8, pad 0.15, tolerance 0, start -25; progress(stage, frac). */
export function analyze(x, { minSilence = 0.8, pad = 0.15, tolerance = 0.0, start = -25, progress = null, keepAudio = false } = {}) {
  const say = progress || (() => {});
  const duration = x.length / RATE;
  if (duration < 1) throw new Error('That recording is under a second long.');

  say('Measuring loudness');
  const win = windowDb(x);
  const split = otsu(win.filter((v) => v > -120.0));
  const below = win.filter((v) => v <= split), above = win.filter((v) => v > split);
  const floor = median(below);
  const level = above.length ? median(above) : split;
  const audible = audibleLevel(floor, level);

  // Audibility on 50 ms windows sliding in 10 ms steps.
  const levels = hopDb(x);
  const per = pyRound(WIN / HOP);
  const energy = new Float64Array(levels.length);
  for (let i = 0; i < levels.length; i++) energy[i] = 10 ** (levels[i] / 10);
  const k = 1 / per;
  const nSlide = Math.max(0, levels.length - per + 1);
  const slide = new Float64Array(nSlide);
  const loud = new Uint8Array(nSlide);
  for (let i = 0; i < nSlide; i++) {
    let s = 0.0;
    for (let j = 0; j < per; j++) s += energy[i + j] * k;
    slide[i] = 10 * Math.log10(Math.max(s, 1e-20));   // slide[i] covers hops i..i+per-1
    loud[i] = slide[i] > audible ? 1 : 0;
  }

  function audibleCut(a, b) {
    const lo = Math.ceil(a / HOP), hi = Math.trunc(b / HOP) - per + 1;
    if (hi <= lo) return null;
    const L = Math.min(hi, nSlide) - lo;   // numpy slicing clips at the end
    if (L <= 0) return null;
    let any = false, peak = -Infinity;
    for (let i = lo; i < lo + L; i++) {
      if (loud[i]) any = true;
      if (slide[i] > peak) peak = slide[i];
    }
    if (!any) return null;
    // Hops covered by at least one loud window (np.convolve, full mode).
    let covered = 0, last = -1;
    for (let j = 0; j < L + per - 1; j++) {
      if (j < L && loud[lo + j]) last = j;
      if (last >= 0 && j - last < per) covered++;
    }
    return [a, b, covered * HOP, peak];
  }

  say('Choosing the threshold');
  const trials = [];
  const lowest = Math.floor(floor + 3);
  for (let t = start; t > Math.min(start, lowest) - 1; t--) {
    const typed = keepTyped(silences(levels, t, minSilence), duration, pad);
    const segs = typed.map(([a, b]) => [a, b]);
    const cut = gaps(segs, duration).map(([a, b]) => audibleCut(a, b)).filter((c) => c);
    // As Python's sum() adds them: compensated for Python floats, plain for numpy ones.
    const kept = pySumMixed(typed.map(([a, b, pa, pb]) => [b - a, pa && pb]));
    const lost = pySum(cut.map((c) => c[2]));
    trials.push(new Trial(t, kept, lost, cut, segs));
  }

  let note = '', chosen;
  const ok = trials.filter((tr) => tr.lost <= tolerance);
  if (ok.length) {
    chosen = ok[0].threshold;   // trials run from most to least aggressive
  } else {
    let best = trials[0];
    for (const tr of trials) if (tr.lost < best.lost) best = tr;
    chosen = best.threshold;
    note = `No threshold kept every audible sound; ${chosen} dB cuts the least (${pyFixed(best.lost, 1)}s).`;
  }
  return new Analysis(duration, floor, level, audible, trials, chosen, note, keepAudio ? x : null);
}
