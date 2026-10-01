// voice.metrics (with openSMILE's WebAssembly build) and live.measure against
// Python, on the library's recordings (voice_cases.json, measure_cases.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadSmile } from '../../smile/smile.js';
import { metrics, COLUMNS } from '../voice.js';
import { measure, framesOf } from '../measure.js';
import { Timeline, concat } from '../timeline.js';
import { REFS, skip, json, f32, f64, compare, describeResult } from './common.mjs';

const VOICE = ['f8e05fee4d26', 'f1c23ba0b1b4'];
const MEASURE = ['f1c23ba0b1b4', '4ebeb43b0794'];
const smile = skip ? null : await loadSmile();

// A stand-in for the WebAssembly openSMILE that hands back Python openSMILE's
// own frames for this speech: checks the port on exactly the same frames.
function replay(rid, spk) {
  const values = f32(REFS, rid, `pyframes-${spk}.f32`), times = f64(REFS, rid, `pyframes-${spk}-times.f64`);
  const frames = times.length / 2;
  return { process: () => ({ names: Object.keys(COLUMNS), width: 6, frames, values,
    starts: times.subarray(0, frames), ends: times.subarray(frames) }) };
}

function run(engine, x, c, own, trimmed) {
  return c.variant.startsWith('place')
    ? metrics(engine, x, { gate: c.gate, place: (t) => trimmed.pointsFromSource(own.pointsToSource(t)), timelineDuration: c.timeline_duration, points: c.points })
    : metrics(engine, x, { gate: c.gate });
}

for (const rid of VOICE) {
  test(`voice.metrics ${rid}`, { skip }, () => {
    const cases = json(REFS, rid, 'voice_cases.json');
    const streams = {};
    let bad = 0, badReplay = 0;
    for (const c of cases) {
      const file = c.stream === 0 ? 'samples.f32' : `samples-s${c.stream}.f32`;
      streams[c.stream] ??= f32(REFS, rid, file);
      const x = concat(streams[c.stream], c.mine);
      const own = new Timeline(c.own), trimmed = new Timeline(c.trimmed);
      const t0 = performance.now();
      const got = run(smile, x, c, own, trimmed);
      const ms = performance.now() - t0;
      const label = `${rid} speaker ${c.speaker} ${c.variant} (${(x.length / 16000).toFixed(0)} s of speech, JS ${ms.toFixed(0)} ms, Python ${(c.python_seconds * 1000).toFixed(0)} ms)`;
      // With the WebAssembly openSMILE: identical, except where its F0 differs
      // from the native build by a float32 rounding (relative 1e-6 allowed there).
      const r = compare(got, c.expected);
      const loose = compare(got, c.expected, 1e-6);
      console.log(describeResult(`${label} [wasm openSMILE]`, r));
      if (!r.ok) console.log('  ', r.mismatches.slice(0, 4).join('\n   '));
      bad += loose.count;
      // With Python's own frames: must be identical.
      const p = compare(run(replay(rid, c.speaker), x, c, own, trimmed), c.expected);
      console.log(describeResult(`${label} [Python's frames]`, p));
      if (!p.ok) console.log(p.mismatches);
      badReplay += p.count;
    }
    assert.equal(badReplay, 0, 'engine differs from Python on identical frames');
    assert.equal(bad, 0, 'differs from Python beyond float32 openSMILE rounding');
  });
}

for (const rid of MEASURE) {
  test(`live.measure ${rid}`, { skip }, () => {
    const { files, cases } = json(REFS, rid, 'measure_cases.json');
    const arr = Object.fromEntries(files.map((k) => [k, f64(REFS, rid, `vframes-${k}.f64`)]));
    const raw = Object.fromEntries(files.filter((k) => !['t', 'src', 'prim'].includes(k)).map((k) => [k, arr[k]]));
    const src = arr.src ? { input: Int8Array.from(arr.src), prim: Uint8Array.from(arr.prim) } : null;
    let bad = 0;
    for (const c of cases) {
      const { t, raw: r0 } = framesOf({ t: arr.t, raw, src }, c.home);
      const trimmed = new Timeline(c.trimmed);
      const got = measure(t, r0, c.turns, c.gate, (x) => trimmed.pointsFromSource(x), c.duration, c.points);
      const r = compare(got, c.expected);
      console.log(describeResult(`${rid} speaker ${c.speaker} gate=${c.gate} points=${c.points}`, r));
      if (!r.ok) console.log(r.mismatches);
      bad += r.count;
    }
    assert.equal(bad, 0);
  });
}
