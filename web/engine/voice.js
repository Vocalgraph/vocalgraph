// Pitch, resonance, loudness and breathiness over time, via openSMILE eGeMAPS
// (vocalgraph/voice.py). openSMILE itself is the WebAssembly build in
// web/smile/smile.js; pass its loadSmile() instance to metrics().
//
// Series values are numbers, or null where a measure is undefined (Python's None).
import { median, percentile, pyFixed, pyDivmod, npRound } from './npcompat.js';

export const RATE = 16000;
export const COLUMNS = {
  'F0semitoneFrom27.5Hz_sma3nz': 'f0',
  'F1frequency_sma3nz': 'f1',
  'F2frequency_sma3nz': 'f2',
  'F3frequency_sma3nz': 'f3',
  // Capital L at frame level (lowercase in the summary set).
  'Loudness_sma3': 'loudness',
  'HNRdBACF_sma3nz': 'hnr',
};
export const KEYS = Object.values(COLUMNS);
export const NULL_AT_ZERO = new Set(['f0', 'f1', 'f2', 'f3', 'hnr']);
export const FORMANTS = ['f1', 'f2', 'f3'];
export const F0_MIN_HZ = 50.0, F0_MAX_HZ = 500.0;
export const MIN_HNR_DB = 0.0;
export const MAX_POINTS = 1400;

const missing = (v) => v === null || v === undefined || Number.isNaN(v);

/** At most `target` points, by median per bin. */
export function bin(values, target) {
  const n = values.length;
  if (n <= target) return Array.from(values, (v) => (missing(v) ? null : v));
  // np.linspace(0, n, target + 1).astype(int)
  const step = n / target;
  const edges = new Array(target + 1);
  for (let i = 0; i <= target; i++) edges[i] = Math.trunc(i * step);
  edges[target] = n;
  const out = new Array(target);
  for (let i = 0; i < target; i++) {
    const chunk = [];
    for (let j = edges[i]; j < edges[i + 1]; j++) if (!missing(values[j])) chunk.push(values[j]);
    out[i] = chunk.length ? median(chunk) : null;
  }
  return out;
}

/** Median per time bin over [0, duration]; frames placed at NaN are dropped. */
export function binByTime(values, at, duration, points) {
  const out = new Array(points).fill(null);
  if (!(duration > 0)) return out;
  const buckets = new Map();
  for (let i = 0; i < values.length; i++) {
    const v = values[i], t = at[i];
    if (missing(v) || Number.isNaN(t)) continue;
    let idx = Math.trunc((t / duration) * points);
    idx = Math.min(points - 1, Math.max(0, idx));
    let b = buckets.get(idx);
    if (!b) buckets.set(idx, (b = []));
    b.push(v);
  }
  for (const [idx, chunk] of buckets) out[idx] = median(chunk);
  return out;
}

/** Round to 16-bit as the desktop app does: returns the int16 samples, which
 * is what openSMILE is given. */
export function toPcm16(x) {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = npRound(Math.fround(x[i] * 32768.0));
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/** voice.to_16bit: the same, back as float32 in [-1, 1). */
export function to16bit(x) {
  const pcm = toPcm16(x), out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768.0;
  return out;
}

/** Frame start and end times as the Python package reports them: seconds via
 * pandas nanosecond timedeltas, and (audinterface) the first frame starting at
 * 0 and the last ending at the end of the signal (`samples` long). */
export function frameTimes(frame, samples) {
  const conv = (s) => Float64Array.from(s, (v) => Math.round(v * 1e9) / 1e9);
  const starts = conv(frame.starts), ends = conv(frame.ends);
  if (frame.frames) {
    starts[0] = 0;
    ends[frame.frames - 1] = Math.round((samples / RATE) * 1e9) / 1e9;
  }
  return { starts, ends };
}

/** openSMILE frames -> {measure: [value or null]}, with the undefined and
 * out-of-range rules applied (not the HNR gate or formant masking). */
export function rawSeries(frame) {
  const raw = {};
  for (const [column, key] of Object.entries(COLUMNS)) {
    const c = frame.names.indexOf(column);
    const series = new Array(frame.frames);
    for (let i = 0; i < frame.frames; i++) {
      if (c < 0) { series[i] = null; continue; }
      const value = frame.values[i * frame.width + c];
      if (Number.isNaN(value) || (NULL_AT_ZERO.has(key) && value === 0.0)) series[i] = null;
      else if (key === 'f0') {
        const hz = 27.5 * (2.0 ** (value / 12.0));   // semitones -> Hz
        series[i] = hz >= F0_MIN_HZ && hz <= F0_MAX_HZ ? hz : null;
      } else series[i] = value;
    }
    raw[key] = series;
  }
  return raw;
}

/** The optional HNR gate on pitch, then formants masked to voiced frames. */
export function applyRules(raw, gateLowConfidence = false) {
  const out = { ...raw };
  if (gateLowConfidence) {
    out.f0 = raw.f0.map((v, i) => (raw.hnr[i] === null || raw.hnr[i] <= MIN_HNR_DB ? null : v));
  }
  for (const key of FORMANTS) out[key] = out[key].map((v, i) => (out.f0[i] !== null ? v : null));
  return out;
}

export function summary(raw, duration) {
  const [mins, secs] = [pyDivmod(duration, 60)[0], pyDivmod(duration, 60)[1]];
  const stats = [['Speech analysed', `${Math.trunc(mins)}:${String(Math.trunc(secs)).padStart(2, '0')}`]];
  const voiced = raw.f0.filter((v) => !missing(v));
  if (voiced.length) {
    stats.push(['Median pitch', `${pyFixed(median(voiced), 0)} Hz`],
      ['Pitch range', `${pyFixed(percentile(voiced, 10), 0)}–${pyFixed(percentile(voiced, 90), 0)} Hz`],
      ['Voiced', `${pyFixed(100 * voiced.length / Math.max(1, raw.f0.length), 0)}%`]);
  }
  const hnr = raw.hnr.filter((v) => !missing(v));
  if (hnr.length) stats.push(['Median HNR', `${pyFixed(median(hnr), 1)} dB`]);
  return stats;
}

/** Voice measurements for `x` (Float32Array, 16 kHz), one speaker's speech
 * joined together; `smile` is loadSmile()'s instance.
 *
 * place, if given, maps times within `x` (seconds, an array) to positions on
 * another timeline of length timelineDuration (NaN where a frame has no place
 * there), and the series are laid out on that timeline instead. */
export function metrics(smile, x, { gate = false, place = null, timelineDuration = null, points = null } = {}) {
  const duration = x.length / RATE;
  const frame = smile.process(toPcm16(x), RATE);
  const raw = applyRules(rawSeries(frame), gate);
  let axis, series, times;
  if (!place) {
    axis = duration;
    const n = Math.min(MAX_POINTS, frame.frames);
    series = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, bin(v, n)]));
    times = Array.from({ length: n }, (_, i) => duration * (i + 0.5) / n);
  } else {
    const { starts, ends } = frameTimes(frame, x.length);
    const mids = Float64Array.from(starts, (s, i) => (s + ends[i]) / 2);
    const at = Float64Array.from(place(mids));
    axis = Number(timelineDuration);
    const n = Math.trunc(points || MAX_POINTS);
    series = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, binByTime(v, at, axis, n)]));
    times = Array.from({ length: n }, (_, i) => axis * (i + 0.5) / n);
  }
  return { duration: axis, time: times, series, stats: summary(raw, duration) };
}
