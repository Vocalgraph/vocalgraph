// sources.js against vocalgraph.sources on a recording with a track per input
// (server._track_activity + sources.refine), from make_speaker_refs.py data.
//
//   node --test web/engine/test/sources.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { levels, lag, shift, threshold, activity, homes, refine } from '../sources.js';

const REFS = process.env.VOCALGRAPH_SPEAKER_REFS ||
  path.join(process.env.LOCALAPPDATA || '', 'Temp', 'vstage', 'engine-refs');
const D = path.join(REFS, 'sources');
const skip = fs.existsSync(path.join(D, 'result.json')) ? false : `no reference data in ${D}: run make_speaker_refs.py`;
const read = (Type, f) => {
  const b = fs.readFileSync(path.join(D, f));
  return new Type(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const turnsEqual = (a, b) => a.length === b.length && a.every((t, i) => t.length === 3 && t.every((v, j) => Math.abs(v - b[i][j]) <= 1e-9));
const exactTurns = (a, b) => a.length === b.length && a.every((t, i) => t.every((v, j) => v === b[i][j]));
const mapList = (m) => [...m].map(([k, v]) => [k, v]);

test('levels, lag, shift, threshold, activity', { skip }, () => {
  const ref = JSON.parse(fs.readFileSync(path.join(D, 'result.json'), 'utf8'));
  const streams = ref.names.map((_, i) => read(Float32Array, `stream${i}.f32`));
  const t0 = performance.now();
  const lv = streams.map((s) => levels(s, 16000));
  const msLevels = performance.now() - t0;
  const diffs = lv.map((l, i) => maxDiff(l, read(Float64Array, `levels${i}.f64`)));
  const [mix, ...tracks] = lv;
  const n = Math.min(mix.length, ...tracks.map((t) => t.length));
  const lags = tracks.map((t) => lag(mix, t));
  const shifted = tracks.map((t, i) => shift(t.subarray(0, n), lags[i]));
  const thr = shifted.map((t) => threshold(t));
  const act = activity(shifted);
  const refLev = read(Float64Array, 'lev.f64');
  const levDiff = Math.max(...shifted.map((t, i) => maxDiff(t, refLev.subarray(i * n, (i + 1) * n))));
  const refAct = read(Uint8Array, 'act.u8');
  let actDiff = 0;
  for (let i = 0; i < refAct.length; i++) actDiff += act.data[i] !== refAct[i];
  console.log(`${streams.length} streams, ${(streams[0].length / 16000).toFixed(1)} s: levels max diff ${diffs.map((d) => d.toExponential(1)).join(', ')} (${msLevels.toFixed(0)} ms); ` +
    `lags ${lags} (Python ${ref.lags}); thresholds diff ${maxDiff(thr, ref.thresholds).toExponential(1)}; shifted levels max diff ${levDiff.toExponential(1)}; ` +
    `activity ${act.frames}x${act.inputs}, ${actDiff} frames differ`);
  diffs.forEach((d) => assert.ok(d < 1e-9));
  assert.deepEqual(lags, ref.lags);
  assert.equal(act.frames, ref.frames);
  assert.equal(actDiff, 0);
});

test('homes and refine', { skip }, () => {
  const ref = JSON.parse(fs.readFileSync(path.join(D, 'result.json'), 'utf8'));
  const refAct = read(Uint8Array, 'act.u8');
  const act = { frames: ref.frames, inputs: refAct.length / ref.frames, data: refAct };
  for (const [ns, c] of Object.entries(ref.cases)) {
    const [home, own] = homes(c.input, act);
    const [turns, hm] = refine(c.input, act);
    const [turnsU, hmU] = refine(c.input, act, 120.0);
    const ok = {
      home: JSON.stringify(mapList(home)) === JSON.stringify(c.home),
      own: JSON.stringify(mapList(own)) === JSON.stringify(c.own),
      refined: exactTurns(turns, c.refined), homes: JSON.stringify(mapList(hm)) === JSON.stringify(c.homes),
      until120: exactTurns(turnsU, c.until120), until120Homes: JSON.stringify(mapList(hmU)) === JSON.stringify(c.until120_homes),
    };
    console.log(`num_speakers=${ns}: ${c.input.length} turns in -> ${turns.length} out, homes ${JSON.stringify(mapList(hm))}; identical: ${JSON.stringify(ok)}`);
    assert.ok(turnsEqual(turns, c.refined));
    assert.deepEqual(ok, { home: true, own: true, refined: true, homes: true, until120: true, until120Homes: true });
  }
});
