// speakers.js / linkage.js / fbank.js against vocalgraph.speakers, on the
// reference data make_speaker_refs.py writes (outside the repo: the
// recordings are personal).
//
//   node --test web/engine/test/speakers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assign, prepare, cluster, NUM_FRAMES, LOCAL, DIM, THRESHOLD } from '../speakers.js';
import { linkageCentroid, fcluster } from '../linkage.js';
import { fbank } from '../fbank.js';
import { sum32, argsortFallbacks } from '../pycompat.js';

export const REFS = process.env.VOCALGRAPH_SPEAKER_REFS ||
  path.join(process.env.LOCALAPPDATA || '', 'Temp', 'vstage', 'engine-refs');
const have = fs.existsSync(path.join(REFS, 'index.json'));
const skip = have ? false : `no reference data in ${REFS}: run make_speaker_refs.py`;
const index = have ? JSON.parse(fs.readFileSync(path.join(REFS, 'index.json'), 'utf8')) : { recordings: [] };

const read = (Type, ...p) => {
  const b = fs.readFileSync(path.join(REFS, ...p));
  return new Type(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const json = (...p) => JSON.parse(fs.readFileSync(path.join(REFS, ...p), 'utf8'));
const sameBits = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]) || (Number.isNaN(v) && Number.isNaN(b[i])));

function loadPrep(rid) {
  return { binary: read(Uint8Array, rid, 'binary.u8'), count: read(Int16Array, rid, 'count.i16'),
    embeddings: read(Float32Array, rid, 'emb.f32'), chunks: json(rid, 'meta.json').chunks };
}

function compareTurns(got, want) {
  const g = got.map((t) => [t.start, t.end, t.speaker]);
  if (g.length !== want.length) return { ok: false, maxDiff: Infinity, why: `${g.length} turns, want ${want.length}` };
  let maxDiff = 0;
  for (let i = 0; i < g.length; i++) {
    if (g[i][2] !== want[i][2]) return { ok: false, maxDiff, why: `turn ${i}: speaker ${g[i][2]}, want ${want[i][2]}` };
    maxDiff = Math.max(maxDiff, Math.abs(g[i][0] - want[i][0]), Math.abs(g[i][1] - want[i][1]));
  }
  return { ok: maxDiff <= 1e-9, maxDiff };
}

for (const rid of index.recordings) {
  test(`linkage + clustering ${rid}`, { skip }, () => {
    const prep = loadPrep(rid);
    const { chunks } = prep;
    // the training voiceprints, as _cluster picks them
    const rows = [];
    for (let c = 0; c < chunks; c++) {
      for (let k = 0; k < LOCAL; k++) {
        let on = false;
        for (let f = 0; f < NUM_FRAMES && !on; f++) on = prep.binary[(c * NUM_FRAMES + f) * LOCAL + k] > 0;
        const v = prep.embeddings.subarray((c * LOCAL + k) * DIM, (c * LOCAL + k + 1) * DIM);
        if (on && !v.some(Number.isNaN)) rows.push(v);
      }
    }
    const n = rows.length;
    const normed = new Float32Array(n * DIM);
    rows.forEach((v, i) => {
      const nrm = Math.fround(Math.sqrt(sum32(v.map((x) => Math.fround(x * x)))));
      for (let j = 0; j < DIM; j++) normed[i * DIM + j] = v[j] / nrm;
    });
    const t0 = performance.now();
    const Z = linkageCentroid(normed, n, DIM);
    const ms = performance.now() - t0;
    const want = read(Float64Array, rid, 'dendro.f64');
    let maxDiff = 0, rowsSame = 0;
    for (let i = 0; i < n - 1; i++) {
      let same = true;
      for (let j = 0; j < 4; j++) { const d = Math.abs(Z[4 * i + j] - want[4 * i + j]); maxDiff = Math.max(maxDiff, d); if (d) same = false; }
      rowsSame += same;
    }
    const fc = fcluster(Z, n, THRESHOLD);
    const fcWant = read(Int32Array, rid, 'fcluster.i32');
    const { hard, centroids } = cluster(prep.embeddings, prep.binary, chunks, null);
    console.log(`${rid}: linkage of ${n} voiceprints in ${ms.toFixed(1)} ms; ${rowsSame}/${n - 1} rows bit-identical (max diff ${maxDiff}); ` +
      `fcluster ${sameBits(fc, fcWant) ? 'identical' : 'DIFFERENT'}; centroids ${sameBits(centroids, read(Float32Array, rid, 'centroids.f32')) ? 'bit-identical' : 'DIFFERENT'}; ` +
      `hard ${sameBits(hard, read(Int8Array, rid, 'hard.i8')) ? 'identical' : 'DIFFERENT'}`);
    assert.equal(rowsSame, n - 1);
    assert.ok(sameBits(fc, fcWant));
    assert.ok(sameBits(centroids, read(Float32Array, rid, 'centroids.f32')));
    assert.ok(sameBits(hard, read(Int8Array, rid, 'hard.i8')));
  });

  test(`assign ${rid}`, { skip }, () => {
    const prep = loadPrep(rid);
    const want = json(rid, 'assign.json');
    const lines = [];
    for (const n of [null, 1, 2, 3, 4]) {
      const t0 = performance.now();
      const got = assign(prep, n);
      const ms = performance.now() - t0;
      const r = compareTurns(got, want[n === null ? 'None' : String(n)]);
      lines.push(`n=${n}: ${got.length} turns ${r.ok ? (r.maxDiff === 0 ? 'identical' : `match (max diff ${r.maxDiff})`) : `MISMATCH ${r.why ?? r.maxDiff}`} in ${ms.toFixed(0)} ms`);
      assert.ok(r.ok, `${rid} n=${n}: ${r.why ?? r.maxDiff}`);
    }
    console.log(`${rid} (${prep.chunks} windows): ${lines.join('; ')}`);
  });
}

test('assign timing on the longest recording', { skip }, () => {
  const rid = index.recordings.reduce((a, b) => (json(a, 'meta.json').chunks >= json(b, 'meta.json').chunks ? a : b));
  const prep = loadPrep(rid);
  assign(prep, null);                                  // warm up the JIT
  const times = {};
  for (const n of [null, 1, 2, 3, 4]) {
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) assign(prep, n);
    times[n] = +((performance.now() - t0) / 3).toFixed(0);
  }
  console.log(`assign on ${rid} (${prep.chunks} windows), ms per call:`, times, `argsort std::sort fallbacks: ${argsortFallbacks()}`);
});

test('prepare glue on recorded model outputs', { skip }, async () => {
  const d = 'prepare';
  const meta = json(d, 'meta.json');
  const x = read(Float32Array, d, 'x.f32');
  const segIn = read(Float32Array, d, 'seg_in.f32'), segOut = read(Float32Array, d, 'seg_out.f32');
  const fbIn = read(Float32Array, d, 'emb_fbank.f32'), wIn = read(Float32Array, d, 'emb_weights.f32');
  const embOut = read(Float32Array, d, 'emb_out.f32');
  const W = 160000, FB = meta.fbank_frames * 80;
  let window = 0, job = 0, cropMismatch = 0, weightMismatch = 0, fbMax = 0, fbMs = 0;
  const models = {
    segmentBatch: 8, embedBatch: 8,
    async segment(batch) {
      const out = new Float32Array(batch.length * NUM_FRAMES * 7);
      batch.forEach((crop, b) => {
        const ref = segIn.subarray((window + b) * W, (window + b + 1) * W);
        if (!sameBits(crop, ref)) cropMismatch++;
        out.set(segOut.subarray((window + b) * NUM_FRAMES * 7, (window + b + 1) * NUM_FRAMES * 7), b * NUM_FRAMES * 7);
      });
      window += batch.length;
      return out;
    },
    async embed(fbanks, weights) {
      const out = new Float32Array(fbanks.length * DIM);
      fbanks.forEach((fb, b) => {
        const ref = fbIn.subarray((job + b) * FB, (job + b + 1) * FB);
        for (let i = 0; i < fb.length; i++) fbMax = Math.max(fbMax, Math.abs(fb[i] - ref[i]));
        if (!sameBits(weights[b], wIn.subarray((job + b) * 125, (job + b + 1) * 125))) weightMismatch++;
        out.set(embOut.subarray((job + b) * DIM, (job + b + 1) * DIM), b * DIM);
      });
      job += fbanks.length;
      return out;
    },
  };
  const t0 = performance.now();
  const prep = await prepare(x, models);
  const ms = performance.now() - t0;
  // fbank speed on its own
  const t1 = performance.now();
  for (let i = 0; i < 10; i++) fbank(segIn.subarray(0, W));
  fbMs = (performance.now() - t1) / 10;
  const same = {
    binary: sameBits(prep.binary, read(Uint8Array, d, 'binary.u8')),
    count: sameBits(prep.count, read(Int16Array, d, 'count.i16')),
    embeddings: sameBits(prep.embeddings, read(Float32Array, d, 'emb.f32')),
  };
  console.log(`prepare on ${(x.length / 16000).toFixed(1)} s: ${window}/${meta.windows} windows (crop mismatches ${cropMismatch}), ` +
    `${job}/${meta.jobs} voiceprints (weight mismatches ${weightMismatch}), fbank max diff ${fbMax.toExponential(2)} ` +
    `(${fbMs.toFixed(1)} ms per 10 s window); outputs identical: ${JSON.stringify(same)}; glue ${ms.toFixed(0)} ms`);
  assert.equal(window, meta.windows);
  assert.equal(job, meta.jobs);
  assert.equal(cropMismatch, 0);
  assert.equal(weightMismatch, 0);
  assert.ok(fbMax < 1e-3);
  assert.deepEqual(same, { binary: true, count: true, embeddings: true });
});
