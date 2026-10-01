// Moving between the original recording's timeline and a trimmed one
// (vocalgraph/timeline.py). A trimmed file is the kept segments (source
// seconds, [start, end] pairs) played back to back.
import { searchRight, tupleCompare } from './npcompat.js';

export const RATE = 16000;

// Python slice bounds x[a:b] for an integer index, with negative wrap-around.
function sliceIndex(i, len) {
  if (i < 0) return Math.max(0, len + i);
  return Math.min(i, len);
}

/** The audio a trim would produce, from the decoded original (Float32Array). */
export function concat(x, segs) {
  const bounds = segs.map(([a, b]) => {
    const lo = sliceIndex(Math.trunc(a * RATE), x.length), hi = sliceIndex(Math.trunc(b * RATE), x.length);
    return [lo, Math.max(lo, hi)];
  });
  const out = new Float32Array(bounds.reduce((n, [lo, hi]) => n + hi - lo, 0));
  let at = 0;
  for (const [lo, hi] of bounds) { out.set(x.subarray(lo, hi), at); at += hi - lo; }
  return out;
}

export class Timeline {
  constructor(segs) {
    this.segs = segs.map(([a, b]) => [a, b]);
    this.offsets = [];              // where each segment starts in the trimmed file
    let t = 0.0;
    for (const [a, b] of this.segs) { this.offsets.push(t); t += b - a; }
    this.total = t;
  }

  /** Trimmed [start, end) as source pieces, cut at every segment boundary. */
  toSource(start, end) {
    const out = [];
    let i = Math.max(0, searchRight(this.offsets, start) - 1);
    while (start < end && i < this.segs.length) {
      const segEnd = this.offsets[i] + (this.segs[i][1] - this.segs[i][0]);
      const pieceEnd = Math.min(end, segEnd);
      if (pieceEnd > start) {
        const src = this.segs[i][0] + (start - this.offsets[i]);
        out.push([src, src + (pieceEnd - start)]);
      }
      start = pieceEnd; i += 1;
    }
    return out;
  }

  /** Trimmed-timeline times -> source times (NaN past the end). */
  pointsToSource(t) {
    const out = new Float64Array(t.length);
    const n = this.segs.length;
    for (let k = 0; k < t.length; k++) {
      const v = t[k];
      if (!n) { out[k] = NaN; continue; }
      const i = Math.min(n - 1, Math.max(0, searchRight(this.offsets, v) - 1));
      const len = this.segs[i][1] - this.segs[i][0];
      out[k] = (v < 0 || v >= this.offsets[i] + len) ? NaN : this.segs[i][0] + (v - this.offsets[i]);
    }
    return out;
  }

  /** Source times -> trimmed-timeline times (NaN where the audio was cut). */
  pointsFromSource(s) {
    const out = new Float64Array(s.length);
    const n = this.segs.length;
    if (!this._starts) this._starts = this.segs.map(([a]) => a);
    for (let k = 0; k < s.length; k++) {
      const v = s[k];
      if (!n || Number.isNaN(v)) { out[k] = NaN; continue; }
      const j = Math.min(n - 1, Math.max(0, searchRight(this._starts, v) - 1));
      const [a, b] = this.segs[j];
      out[k] = (v < a || v >= b) ? NaN : this.offsets[j] + (v - a);
    }
    return out;
  }

  /** Source [start, end) as pieces of the trimmed timeline; parts that fall in
   * removed audio are dropped. */
  fromSource(start, end) {
    const out = [];
    this.segs.forEach(([a, b], i) => {
      const lo = Math.max(a, start), hi = Math.min(b, end);
      if (hi > lo) out.push([this.offsets[i] + lo - a, this.offsets[i] + hi - a]);
    });
    return out;
  }
}

/** Overlap of two sorted lists of [start, end]. */
export function intersect(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]), hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i += 1; else j += 1;
  }
  return out;
}

/** Spans merged where they touch or overlap, each padded by `pad` (not below 0,
 * nor past `limit` if given). */
export function union(spans, pad = 0.0, limit = null) {
  const out = [];
  for (let [a, b] of [...spans].sort(tupleCompare)) {
    a = Math.max(0.0, a - pad); b = b + pad;
    if (limit !== null && limit !== undefined) b = Math.min(limit, b);
    const last = out[out.length - 1];
    if (last && a <= last[1]) out[out.length - 1] = [last[0], Math.max(last[1], b)];
    else out.push([a, b]);
  }
  return out;
}
