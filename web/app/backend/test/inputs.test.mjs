// inputs.js: sound that arrives late is kept, not swapped for silence.
// A simulated clock and microphone; no browser needed:
//   node --test web/app/backend/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Inputs, RATE } from '../inputs.js';

const CHUNK = RATE / 50;                 // the worklet's 20 ms chunks

// A file in memory, in place of OPFS.
function fakeDir() {
  const files = [];
  return {
    files,
    async getFileHandle() {
      const parts = [];
      const f = { parts, size: 0, getSize: () => f.size, write(a) { parts.push(a.slice()); f.size += a.byteLength; },
        truncate() {}, flush() {}, close() {} };
      files.push(f);
      return { createSyncAccessHandle: async () => f };
    },
  };
}
const samples = (f) => { const n = f.parts.reduce((s, p) => s + p.length, 0), out = new Int16Array(n); let o = 0; for (const p of f.parts) { out.set(p, o); o += p.length; } return out; };

// Runs of exact zeros at least `min` samples long, in seconds.
function zeroRuns(x, min = RATE / 100) {
  let run = 0, total = 0, count = 0;
  for (let i = 0; i <= x.length; i++) {
    if (i < x.length && x[i] === 0) { run++; continue; }
    if (run >= min) { total += run; count++; }
    run = 0;
  }
  return { count, secs: total / RATE };
}

// A session of `secs` on a simulated clock, in 5 ms steps. The microphone
// makes a 20 ms chunk every 20 ms (never exact zeros); `delivered(t)` says
// whether the worker can take messages and run its timer at time t (s), and
// `mic(t)` whether the microphone is sending at all. Messages that wait are
// handed on when the worker is free again; `timerFirst` runs the timer before
// them, the worst case, which is what lost the sound before.
async function run({ secs, delivered = () => true, mic = () => true, timerFirst = true }) {
  let now = 0;
  const dir = fakeDir(), blocks = [];
  const inputs = new Inputs(dir, (mix) => blocks.push(mix.length));
  inputs.now = () => now;
  const inp = await inputs.add('mic:test', 'Test mic', 1);
  inputs.start = 0;
  const queue = [];
  let made = 0, k = 0;
  for (let ms = 0; ms <= secs * 1000; ms += 5) {
    now = ms;
    const t = ms / 1000;
    while ((made + 1) * CHUNK <= t * RATE) {
      if (mic(made * CHUNK / RATE)) {
        const data = new Float32Array(CHUNK);
        for (let i = 0; i < CHUNK; i++) data[i] = 0.1 * Math.sin(2 * Math.PI * 220 * (made * CHUNK + i) / RATE) + (((k++ * 7919) % 13) - 6) * 1e-4 + 1e-3;
        queue.push({ data, at: made * CHUNK });
      }
      made++;
    }
    if (!delivered(t)) continue;
    if (timerFirst) inputs.pump();
    while (queue.length) { const m = queue.shift(); inp.place(m.data, m.at); }
    inputs.pump();
  }
  inputs.stop();
  return { inp, x: samples(dir.files[0]), summary: inputs.summary(), blocks };
}

test('a worker busy for 0.8 s of every 1.25 s loses nothing', async () => {
  const r = await run({ secs: 60, delivered: (t) => (t % 1.25) >= 0.8 });
  const z = zeroRuns(r.x);
  console.log(r.summary, `| silent runs: ${z.count}, ${z.secs.toFixed(2)} s`);
  assert.ok(r.inp.stats.padded / RATE < 0.05, `padded ${r.inp.stats.padded / RATE} s`);
  assert.equal(r.inp.stats.late, 0);
  assert.equal(z.count, 0);
  assert.ok(Math.abs(r.x.length / RATE - 60) < 0.1, `length ${r.x.length / RATE}`);
});

test('a worker busy for 4 s at a time loses nothing', async () => {
  const r = await run({ secs: 40, delivered: (t) => (t % 10) >= 4 });
  const z = zeroRuns(r.x);
  console.log(r.summary, `| silent runs: ${z.count}`);
  assert.equal(z.count, 0);
  assert.equal(r.inp.stats.late, 0);
});

test('a microphone that really stops: its gap is silence, in the right place', async () => {
  const r = await run({ secs: 20, mic: (t) => t < 5 || t >= 7 });
  const z = zeroRuns(r.x);
  console.log(r.summary, `| silent runs: ${z.count}, ${z.secs.toFixed(2)} s`);
  assert.equal(z.count, 1);
  assert.ok(Math.abs(z.secs - 2) < 0.03, `gap ${z.secs}`);
  // the gap starts at 5 s
  assert.equal(r.x[Math.round(5.01 * RATE)], 0);
  assert.notEqual(r.x[Math.round(4.99 * RATE)], 0);
  assert.notEqual(r.x[Math.round(7.01 * RATE)], 0);
});

test('sound held up longer than HOLD: written as silence, then counted as late', async () => {
  const r = await run({ secs: 20, delivered: (t) => t < 3 || t >= 10 });
  console.log(r.summary);
  assert.ok(r.inp.stats.late > 0);
  assert.match(r.summary, /arrived too late/);
  assert.ok(Math.abs(r.x.length / RATE - 20) < 0.1);
});

test('nothing held up: blocks go on at once', async () => {
  let now = 0;
  const inputs = new Inputs(fakeDir(), () => {});
  inputs.now = () => now;
  const inp = await inputs.add('mic:test', 'Test mic', 1);
  inputs.start = 0;
  now = 100;
  inp.place(new Float32Array(RATE / 10).fill(0.01), 0);
  inputs.pump();
  assert.equal(inp.written, RATE / 10);
});
