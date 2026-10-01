// Who spoke when (vocalgraph/speakers.py): pyannote 3.1's speaker-diarization
// pipeline without PyTorch, then the laptop pipeline's calibrated clean-up.
// A line-for-line port: assign() gives the Python app's turns exactly (same
// floats), which takes reproducing SciPy's linkage, NumPy's float32 sums and
// unstable argsort, OpenBLAS's sdot and CPython's set order (pycompat.js).
//
// The two models are injected, so the browser can run them with ONNX Runtime
// Web and tests can replay recorded outputs:
//   models.segment(batch)  batch: Float32Array[] of 160000 samples
//                          -> Promise<Float32Array> logits (b, 589, 7)
//   models.embed(fbanks, weights)  fbanks: Float32Array[] (998 x 80 each),
//                          weights: Float32Array[] (125 each)
//                          -> Promise<Float32Array> (b, 256)
//   models.segmentBatch / models.embedBatch  windows per call (default 8)
//
// prepare()'s output has the Python layout, flattened row-major:
//   binary      Uint8Array  (chunks, 589, 3)
//   count       Int16Array  (frames,)
//   embeddings  Float32Array (chunks, 3, 256), NaN for inactive local speakers
//   chunks      number of 10 s windows

import { fbank } from './fbank.js';
import { linkageCentroid, fcluster, cdistCosine } from './linkage.js';
import { argsort, sum32, sdot, norm32, pySum, pySetOrder } from './pycompat.js';

const f32 = Math.fround;

export const RATE = 16000;
export const WINDOW = 10 * RATE, STEP = 1 * RATE;
export const FRAME_START = 0.0, FRAME_DUR = 0.0619375, FRAME_STEP = 0.016875;
export const NUM_FRAMES = 589, LOCAL = 3, DIM = 256;
export const THRESHOLD = 0.7045654963945799;
export const MIN_CLUSTER_SIZE = 1;
export const MIN_EMBED_SAMPLES = 400;
export const MERGE_SIMILAR = 0.35;
export const MIN_TURN = 0.8;
export const JOIN_GAP = 0.3;

/** powerset class -> (speaker 1, 2, 3) active. */
export const POWERSET = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1]];

const F32_1E12 = f32(1e-12);

/** np.rint: round half to even. */
export function rint(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export function closestFrame(t) {
  return rint((t - FRAME_START - 0.5 * FRAME_DUR) / FRAME_STEP);
}

/** Start sample of each 10 s window, as pyannote slides them (last one padded). */
export function chunkStarts(n) {
  const full = n >= WINDOW ? Math.floor((n - WINDOW) / STEP) + 1 : 0;
  const starts = [];
  for (let c = 0; c < full; c++) starts.push(c * STEP);
  if (n < WINDOW || (n - WINDOW) % STEP > 0) starts.push(full * STEP);
  return starts;
}

export function crop(x, start) {
  const out = new Float32Array(WINDOW);
  out.set(x.subarray(start, Math.min(x.length, start + WINDOW)));
  return out;
}

function totalFrames(chunks) {
  return closestFrame(WINDOW / RATE + (chunks - 1) * STEP / RATE + 0.5 * FRAME_DUR) + 1;
}

function chunkFrameStarts(chunks) {
  const s = new Int32Array(chunks);
  for (let c = 0; c < chunks; c++) s[c] = closestFrame(c * STEP / RATE + 0.5 * FRAME_DUR);
  return s;
}

/**
 * Overlap-add per-chunk frame scores onto one timeline (Inference.aggregate,
 * no Hamming window, no warm-up, missing (NaN) -> 0), in float32 as NumPy.
 * scores: (chunks, 589, k) row-major. Returns Float32Array (frames, k).
 */
export function aggregate(scores, chunks, k, skipAverage) {
  const total = totalFrames(chunks);
  const out = new Float32Array(total * k), count = new Float32Array(total * k), seen = new Uint8Array(total * k);
  const starts = chunkFrameStarts(chunks);
  for (let c = 0; c < chunks; c++) {
    for (let f = 0; f < NUM_FRAMES; f++) {
      const src = (c * NUM_FRAMES + f) * k, dst = (starts[c] + f) * k;
      for (let j = 0; j < k; j++) {
        const v = scores[src + j];
        if (Number.isNaN(v)) continue;
        out[dst + j] = out[dst + j] + v;
        count[dst + j] += 1;
        seen[dst + j] = 1;
      }
    }
  }
  if (!skipAverage) for (let i = 0; i < out.length; i++) out[i] = out[i] / Math.max(count[i], 1e-12);
  for (let i = 0; i < out.length; i++) if (!seen[i]) out[i] = 0;
  return out;
}

// --------------------------------------------------------------- prepare ---

async function segment(x, starts, models, say) {
  const B = models.segmentBatch || 8;
  const binary = new Uint8Array(starts.length * NUM_FRAMES * LOCAL);
  for (let i = 0; i < starts.length; i += B) {
    const part = starts.slice(i, i + B);
    const logp = await models.segment(part.map((s) => crop(x, s)));
    for (let b = 0; b < part.length; b++) {
      for (let f = 0; f < NUM_FRAMES; f++) {
        const o = (b * NUM_FRAMES + f) * 7;
        let best = 0;
        for (let c = 1; c < 7; c++) if (logp[o + c] > logp[o + best]) best = c;   // first max, as argmax
        const dst = ((i + b) * NUM_FRAMES + f) * LOCAL;
        binary[dst] = POWERSET[best][0]; binary[dst + 1] = POWERSET[best][1]; binary[dst + 2] = POWERSET[best][2];
      }
    }
    say(0.3 * Math.min(1.0, (i + B) / starts.length));
  }
  return binary;
}

async function embeddings(x, starts, binary, models, say) {
  const B = models.embedBatch || 8;
  const minFrames = Math.ceil((NUM_FRAMES * MIN_EMBED_SAMPLES) / WINDOW);
  const jobs = [];
  for (let c = 0; c < starts.length; c++) {
    for (let k = 0; k < LOCAL; k++) {
      let on = 0, clean = 0;
      for (let f = 0; f < NUM_FRAMES; f++) {
        const o = (c * NUM_FRAMES + f) * LOCAL;
        const b = binary[o + k];
        on += b;
        if (b && binary[o] + binary[o + 1] + binary[o + 2] < 2) clean++;
      }
      if (on === 0) continue;
      const useClean = clean > minFrames;
      const mask = new Uint8Array(NUM_FRAMES);
      for (let f = 0; f < NUM_FRAMES; f++) {
        const o = (c * NUM_FRAMES + f) * LOCAL;
        mask[f] = useClean ? (binary[o + k] && binary[o] + binary[o + 1] + binary[o + 2] < 2 ? 1 : 0) : binary[o + k];
      }
      jobs.push([c, k, starts[c], mask]);
    }
  }
  const result = new Float32Array(starts.length * LOCAL * DIM).fill(NaN);
  let cacheC = -1, cacheF = null;
  for (let i = 0; i < jobs.length; i += B) {
    const part = jobs.slice(i, i + B);
    const feats = part.map(([c, , s]) => {
      if (c !== cacheC) { cacheC = c; cacheF = fbank(crop(x, s)); }
      return cacheF;
    });
    const frames = feats[0].length / 80;
    const pooled = Math.ceil(Math.ceil(Math.ceil(frames / 2) / 2) / 2);
    const idx = new Int32Array(pooled);
    for (let p = 0; p < pooled; p++) idx[p] = Math.min(Math.floor(p * (NUM_FRAMES / pooled)), NUM_FRAMES - 1);
    const weights = part.map(([, , , m]) => Float32Array.from(idx, (j) => m[j]));
    const vecs = await models.embed(feats, weights);
    part.forEach(([c, k], b) => result.set(vecs.subarray(b * DIM, (b + 1) * DIM), (c * LOCAL + k) * DIM));
    say(0.3 + 0.6 * Math.min(1.0, (i + B) / Math.max(1, jobs.length)));
  }
  return result;
}

/**
 * The slow, count-independent part: segmentation, speaker counting and
 * voiceprints, for 16 kHz mono audio. null when there is no speech.
 */
export async function prepare(x16k, models, progress) {
  const say = progress || (() => {});
  if (x16k.length < RATE / 2) return null;
  // the samples the laptop pipeline sees (its decode goes through 16-bit)
  const x = new Float32Array(x16k.length);
  for (let i = 0; i < x.length; i++) {
    const v = rint(f32(x16k[i] * 32768.0));
    x[i] = Math.min(32767, Math.max(-32768, v)) / 32768.0;
  }
  const starts = chunkStarts(x.length);
  const chunks = starts.length;
  const binary = await segment(x, starts, models, say);
  const sums = new Float32Array(chunks * NUM_FRAMES);
  for (let i = 0; i < sums.length; i++) sums[i] = binary[3 * i] + binary[3 * i + 1] + binary[3 * i + 2];
  const avg = aggregate(sums, chunks, 1, false);
  const count = new Int16Array(avg.length);
  let top = 0;
  for (let i = 0; i < avg.length; i++) { count[i] = rint(avg[i]); if (count[i] > top) top = count[i]; }
  if (top === 0) return null;
  const emb = await embeddings(x, starts, binary, models, say);
  say(1.0);
  return { binary, count, embeddings: emb, chunks };
}

// ---------------------------------------------------------------- assign ---

// np.unique(values, return_counts=True) for non-negative ints.
function unique(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  const uniq = [...counts.keys()].sort((a, b) => a - b);
  return [uniq, uniq.map((u) => counts.get(u))];
}

// Rows of float32 X (d wide) averaged as np.mean(axis=0) does: summed row by
// row in float32, then divided (float64 division, rounded to float32).
function meanRows(X, rows, d) {
  const out = new Float32Array(d);
  for (const r of rows) for (let j = 0; j < d; j++) out[j] = out[j] + X[r * d + j];
  for (let j = 0; j < d; j++) out[j] = out[j] / rows.length;
  return out;
}

/** pyannote's AgglomerativeClustering + assign_embeddings (unconstrained). */
export function cluster(emb, binary, chunks, numSpeakers) {
  const active = [];
  for (let c = 0; c < chunks; c++) {
    for (let k = 0; k < LOCAL; k++) {
      let on = false;
      for (let f = 0; f < NUM_FRAMES && !on; f++) on = binary[(c * NUM_FRAMES + f) * LOCAL + k] > 0;
      let valid = true;
      const o = (c * LOCAL + k) * DIM;
      for (let j = 0; j < DIM && valid; j++) valid = !Number.isNaN(emb[o + j]);
      if (on && valid) active.push(c * LOCAL + k);
    }
  }
  const n = active.length;
  const train = new Float32Array(n * DIM);
  active.forEach((r, i) => train.set(emb.subarray(r * DIM, (r + 1) * DIM), i * DIM));
  if (n === 0) return { hard: new Int8Array(chunks * LOCAL), centroids: new Float32Array(DIM), k: 1 };

  const minC = Math.max(1, Math.min(n, numSpeakers || 1));
  const maxC = Math.max(1, Math.min(n, numSpeakers || n));
  let target = minC === maxC ? minC : null;
  if (maxC < 2) {
    return { hard: new Int8Array(chunks * LOCAL), centroids: meanRows(train, [...Array(n).keys()], DIM), k: 1 };
  }
  const minSize = Math.min(MIN_CLUSTER_SIZE, Math.max(1, rint(0.1 * n)));
  let clusters;
  if (n === 1) clusters = new Int32Array(1);
  else {
    const normed = new Float32Array(n * DIM);
    const sq = new Float32Array(DIM);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < DIM; j++) { const v = train[i * DIM + j]; sq[j] = f32(v * v); }
      const nrm = f32(Math.sqrt(sum32(sq)));
      for (let j = 0; j < DIM; j++) normed[i * DIM + j] = train[i * DIM + j] / nrm;
    }
    const dendro = linkageCentroid(normed, n, DIM);
    clusters = fcluster(dendro, n, THRESHOLD).map((v) => v - 1);
    let [uniq, counts] = unique(clusters);
    let large = uniq.filter((u, i) => counts[i] >= minSize);
    if (large.length < minC) target = minC;
    else if (large.length > maxC) target = maxC;
    if (target !== null && large.length !== target) {
      const d2 = Float64Array.from(dendro);
      for (let i = 0; i < n - 1; i++) d2[4 * i + 2] = i;
      let bestIt = n - 1, bestN = 1;
      const gap = new Float64Array(n - 1);
      for (let i = 0; i < n - 1; i++) gap[i] = Math.abs(dendro[4 * i + 2] - THRESHOLD);
      for (const it of argsort(gap)) {
        if (d2[4 * it + 3] < minSize) continue;
        clusters = fcluster(d2, n, it).map((v) => v - 1);
        const [, cnt] = unique(clusters);
        const nl = cnt.filter((c) => c >= minSize).length;
        if (Math.abs(nl - target) < Math.abs(bestN - target)) { bestIt = it; bestN = nl; }
        if (nl === target) break;
      }
      if (bestN !== target) clusters = fcluster(d2, n, bestIt).map((v) => v - 1);
      [uniq, counts] = unique(clusters);
      large = uniq.filter((u, i) => counts[i] >= minSize);
    }
    if (large.length === 0) clusters.fill(0);
    else {
      const small = uniq.filter((u, i) => counts[i] < minSize);
      if (small.length) {
        const rowsOf = (lab) => { const r = []; clusters.forEach((v, i) => { if (v === lab) r.push(i); }); return r; };
        const lc = new Float32Array(large.length * DIM), sc = new Float32Array(small.length * DIM);
        large.forEach((lab, i) => lc.set(meanRows(normed, rowsOf(lab), DIM), i * DIM));
        small.forEach((lab, i) => sc.set(meanRows(normed, rowsOf(lab), DIM), i * DIM));
        const dist = cdistCosine(lc, large.length, sc, small.length, DIM);
        for (let j = 0; j < small.length; j++) {
          let li = 0;
          for (let i = 1; i < large.length; i++) if (dist[i * small.length + j] < dist[li * small.length + j]) li = i;
          for (let r = 0; r < n; r++) if (clusters[r] === small[j]) clusters[r] = large[li];
        }
      }
      const [u2] = unique(clusters);
      const inv = new Map(u2.map((v, i) => [v, i]));
      clusters = clusters.map((v) => inv.get(v));
    }
  }
  let k = 0;
  for (const v of clusters) if (v + 1 > k) k = v + 1;
  const centroids = new Float32Array(k * DIM);
  for (let j = 0; j < k; j++) {
    const rows = [];
    clusters.forEach((v, i) => { if (v === j) rows.push(i); });
    centroids.set(meanRows(train, rows, DIM), j * DIM);
  }
  const flat = new Float32Array(chunks * LOCAL * DIM);
  for (let i = 0; i < flat.length; i++) flat[i] = Number.isNaN(emb[i]) ? 0 : emb[i];
  const dist = cdistCosine(flat, chunks * LOCAL, centroids, k, DIM);
  const hard = new Int8Array(chunks * LOCAL);
  for (let r = 0; r < chunks * LOCAL; r++) {
    let best = 0, bv = -Infinity;
    for (let j = 0; j < k; j++) {
      let v = 2 - dist[r * k + j];
      if (Number.isNaN(v)) v = -Infinity;
      if (j === 0 || v > bv) { best = j; bv = v; }     // first max, as np.argmax
    }
    hard[r] = best;                        // int8, as NumPy's astype (wraps past 127)
  }
  return { hard, centroids, k };
}

/**
 * Map local speakers to clusters and keep the `count` most active per frame.
 * hard: Int8Array (chunks, 3), -2 for inactive. Returns { out: Float32Array
 * (frames, k), frames, k }.
 */
export function reconstruct(binary, hard, count, chunks) {
  let k = -Infinity;
  for (const v of hard) if (v > k) k = v;
  k += 1;
  const total = totalFrames(chunks);
  const vals = Float32Array.from(binary);
  const use = Uint8Array.from(hard, (v) => (v !== -2 ? 1 : 0));
  for (let j = 0; j < LOCAL; j++) {
    for (let i = 0; i < j; i++) {
      for (let c = 0; c < chunks; c++) {
        if (use[c * LOCAL + i] && use[c * LOCAL + j] && hard[c * LOCAL + i] === hard[c * LOCAL + j]) {
          for (let f = 0; f < NUM_FRAMES; f++) {
            const o = (c * NUM_FRAMES + f) * LOCAL;
            vals[o + i] = Math.max(vals[o + i], vals[o + j]);
          }
          use[c * LOCAL + j] = 0;
        }
      }
    }
  }
  let top = 0;
  for (const v of count) if (v > top) top = v;
  const width = Math.max(k, top);
  const act = new Float32Array(total * width);
  const starts = chunkFrameStarts(chunks);
  for (let c = 0; c < chunks; c++) {
    for (let j = 0; j < LOCAL; j++) {
      if (!use[c * LOCAL + j]) continue;
      let col = hard[c * LOCAL + j];
      if (col < 0) col += k;               // NumPy's negative index (only past 127 clusters)
      for (let f = 0; f < NUM_FRAMES; f++) {
        const at = (starts[c] + f) * width + col;
        act[at] = act[at] + vals[(c * NUM_FRAMES + f) * LOCAL + j];
      }
    }
  }
  const frames = Math.min(total, count.length);
  const out = new Float32Array(frames * width);
  const row = new Float32Array(width), tmp = new Float32Array(width);
  for (let t = 0; t < frames; t++) {
    const need = count[t];
    if (need <= 0) continue;
    const o = t * width;
    if (need >= width) { out.fill(1, o, o + width); continue; }
    // Only a tie across the cut needs NumPy's exact (unstable) sort order.
    tmp.set(act.subarray(o, o + width));
    tmp.sort();
    const cut = tmp[width - need];
    if (tmp[width - need - 1] !== cut) {
      for (let j = 0; j < width; j++) if (act[o + j] >= cut) out[o + j] = 1;
      continue;
    }
    for (let j = 0; j < width; j++) row[j] = -act[o + j];
    const order = argsort(row);
    for (let r = 0; r < need; r++) out[o + order[r]] = 1;
  }
  return { out, frames, k: width };
}

/** Binarize (onset = offset = 0.5, no padding): [start, end, column] turns. */
export function toTurns(discrete, frames, k) {
  const stamp = (i) => FRAME_START + i * FRAME_STEP + FRAME_DUR / 2;
  const turns = [];
  const state = new Int8Array(frames);
  for (let c = 0; c < k; c++) {
    for (let t = 0; t < frames; t++) {
      const v = discrete[t * k + c];
      state[t] = t === 0 ? (v > 0.5 ? 1 : 0) : (v > 0.5 ? 1 : v < 0.5 ? 0 : state[t - 1]);
    }
    let on = state[0] ? 0 : -1;
    for (let t = 1; t < frames; t++) {
      if (state[t] && !state[t - 1]) on = t;
      else if (!state[t] && state[t - 1]) { turns.push([stamp(on), stamp(t), c]); on = -1; }
    }
    if (frames && state[frames - 1]) turns.push([stamp(on), stamp(frames - 1), c]);
  }
  return turns;
}

function cosine32(a, ao, b, bo) {
  const den = f32(f32(norm32(a, ao, DIM) * norm32(b, bo, DIM)) + F32_1E12);
  return f32(sdot(a, ao, b, bo, DIM) / den);
}

const tupleLess = (x, y) => {
  for (let i = 0; i < 3; i++) { if (x[i] < y[i]) return -1; if (x[i] > y[i]) return 1; }
  return 0;
};

/** The laptop pipeline's merge_similar_speakers + merge_small_speakers. */
function cleanup(turns, centroids, nCent) {
  let labels = [...new Set(turns.map((t) => t[2]))].sort((a, b) => a - b);
  const cent = new Map();
  for (const k of labels) {
    if (k >= nCent) continue;
    let any = false;
    for (let j = 0; j < DIM && !any; j++) any = centroids[k * DIM + j] !== 0;
    if (any) cent.set(k, k * DIM);
  }
  const durOf = (ts, k) => pySum(ts.filter((t) => t[2] === k).map(([a, b]) => b - a));
  const dur = new Map(labels.map((k) => [k, durOf(turns, k)]));
  const order = [...labels].sort((a, b) => dur.get(b) - dur.get(a));      // stable, like sorted(reverse=True)
  const root = new Map();
  order.forEach((k, i) => {
    if (!cent.has(k)) return;
    for (const bigger of order.slice(0, i)) {
      if (cent.has(bigger) && cosine32(centroids, cent.get(k), centroids, cent.get(bigger)) >= MERGE_SIMILAR) {
        let r = bigger;
        while (root.has(r)) r = root.get(r);
        if (r !== k) root.set(k, r);
        break;
      }
    }
  });
  const resolve = (k) => { while (root.has(k)) k = root.get(k); return k; };
  turns = turns.map(([a, b, k]) => [a, b, resolve(k)]);

  labels = [...new Set(turns.map((t) => t[2]))].sort((a, b) => a - b);
  const total = new Map(labels.map((k) => [k, durOf(turns, k)]));
  const longest = new Map(labels.map((k) => {
    let m = -Infinity;
    for (const [a, b, kk] of turns) if (kk === k && b - a > m) m = b - a;
    return [k, m];
  }));
  const keep = labels.filter((k) => longest.get(k) >= MIN_TURN);
  const drop = labels.filter((k) => longest.get(k) < MIN_TURN);
  if (keep.length && drop.length) {
    const mapping = new Map();
    for (const k of drop) {
      const cands = keep.filter((o) => cent.has(o) && cent.has(k));
      mapping.set(k, cands.length
        ? maxBy(cands, (o) => cosine32(centroids, cent.get(k), centroids, cent.get(o)))
        : maxBy(keep, (o) => total.get(o)));
    }
    turns = turns.map(([a, b, k]) => [a, b, mapping.has(k) ? mapping.get(k) : k]);
  }
  return turns;
}

// Python's max(items, key=...) / min(...): the first item with the extreme key.
function maxBy(items, key) {
  let best = items[0], bv = key(best);
  for (let i = 1; i < items.length; i++) { const v = key(items[i]); if (v > bv) { best = items[i]; bv = v; } }
  return best;
}
function minBy(items, key) {
  let best = items[0], bv = key(best);
  for (let i = 1; i < items.length; i++) { const v = key(items[i]); if (v < bv) { best = items[i]; bv = v; } }
  return best;
}

/** Join a speaker's turns across short gaps; speaker 0 talks most. */
function finish(turns) {
  const by = new Map();
  for (const [a, b, k] of [...turns].sort(tupleLess)) {
    if (!by.has(k)) by.set(k, []);
    by.get(k).push([a, b]);
  }
  const joined = [];
  for (const [k, ts] of by) {
    let cur = ts[0];
    for (const [a, b] of ts.slice(1)) {
      if (a <= cur[1] + JOIN_GAP) cur[1] = Math.max(cur[1], b);
      else { joined.push([cur[0], cur[1], k]); cur = [a, b]; }
    }
    joined.push([cur[0], cur[1], k]);
  }
  const talk = new Map();
  for (const [a, b, k] of joined) talk.set(k, (talk.has(k) ? talk.get(k) : 0.0) + b - a);
  const ranked = [...talk.keys()].sort((x, y) => talk.get(y) - talk.get(x));
  const rank = new Map(ranked.map((k, i) => [k, i]));
  return joined.map(([a, b, k]) => ({ start: a, end: b, speaker: rank.get(k) }))
    .sort((x, y) => x.start - y.start);
}

/** Merge speakers until there are n: the one who talks least goes into whoever they sound most like. */
function fold(turns, centroids, nCent, n) {
  const talk = new Map();
  for (const [a, b, k] of turns) talk.set(k, (talk.has(k) ? talk.get(k) : 0.0) + b - a);
  const vec = new Map();
  for (const k of talk.keys()) {
    if (k >= nCent) { vec.set(k, null); continue; }
    const den = f32(norm32(centroids, k * DIM, DIM) + F32_1E12);
    const tk = f32(talk.get(k));
    const v = new Float32Array(DIM);
    for (let j = 0; j < DIM; j++) v[j] = f32(f32(centroids[k * DIM + j] / den) * tk);
    vec.set(k, v);
  }
  const into = new Map();
  let live = pySetOrder([...talk.keys()]);
  while (live.length > n) {
    const small = minBy(live, (k) => talk.get(k));
    const others = live.filter((o) => o !== small);
    const cands = others.filter((o) => vec.get(o) !== null && vec.get(small) !== null);
    const target = cands.length
      ? maxBy(cands, (o) => cosine32(vec.get(small), 0, vec.get(o), 0))
      : maxBy(others, (o) => talk.get(o));
    into.set(small, target);
    talk.set(target, talk.get(target) + talk.get(small));
    if (vec.get(target) !== null && vec.get(small) !== null) {
      const a = vec.get(target), b = vec.get(small);
      vec.set(target, Float32Array.from(a, (v, j) => v + b[j]));
    }
    live = live.filter((o) => o !== small);
  }
  const resolve = (k) => { while (into.has(k)) k = into.get(k); return k; };
  return turns.map(([a, b, k]) => [a, b, resolve(k)]);
}

function shapeOf(prep) {
  return prep.chunks || prep.binary.length / (NUM_FRAMES * LOCAL);
}

function inactiveToMinus2(hard, binary, chunks) {
  for (let c = 0; c < chunks; c++) {
    for (let k = 0; k < LOCAL; k++) {
      let on = 0;
      for (let f = 0; f < NUM_FRAMES; f++) on += binary[(c * NUM_FRAMES + f) * LOCAL + k];
      if (on === 0) hard[c * LOCAL + k] = -2;
    }
  }
}

/**
 * Speaker turns from prepare()'s output, largest talker first (speaker 0):
 * [{ start, end, speaker }] in seconds of the analysed audio, by start.
 */
export function assign(prep, numSpeakers = null) {
  if (!prep) return [];
  const chunks = shapeOf(prep);
  const binary = prep.binary, count = prep.count;
  const capped = (m) => Int16Array.from(count, (v) => Math.min(v, m));
  const turnsOf = (hard, cnt) => {
    const { out, frames, k } = reconstruct(binary, hard, cnt, chunks);
    return toTurns(out, frames, k);
  };
  if (numSpeakers === 1) {
    const hard = new Int8Array(chunks * LOCAL);
    inactiveToMinus2(hard, binary, chunks);
    return finish(turnsOf(hard, capped(1)));
  }
  let { hard, centroids, k } = cluster(prep.embeddings, binary, chunks, null);
  inactiveToMinus2(hard, binary, chunks);
  let turns = cleanup(turnsOf(hard, count), centroids, k);
  const found = new Set(turns.map((t) => t[2])).size;
  if (numSpeakers && found > numSpeakers) turns = fold(turns, centroids, k, numSpeakers);
  else if (numSpeakers && found < numSpeakers) {
    ({ hard } = cluster(prep.embeddings, binary, chunks, numSpeakers));
    inactiveToMinus2(hard, binary, chunks);
    turns = turnsOf(hard, capped(numSpeakers));
  }
  return finish(turns);
}

/** prepare() then assign(). */
export async function diarize(x16k, models, numSpeakers = null, progress) {
  return assign(await prepare(x16k, models, progress), numSpeakers);
}
