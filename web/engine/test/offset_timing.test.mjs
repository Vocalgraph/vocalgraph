// live.offset_of against Python, and timings on the 48-minute recording.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadSmile } from '../../smile/smile.js';
import { analyze } from '../analysis.js';
import { metrics } from '../voice.js';
import { offsetOf } from '../measure.js';
import { Timeline, concat } from '../timeline.js';
import { REFS, LIBRARY, skip, json, f32 } from './common.mjs';

test('offset_of', { skip }, () => {
  for (const c of json(REFS, 'offset_cases.json')) {
    const saved = f32(REFS, `offset-${c.i}-saved.f32`), live = f32(REFS, `offset-${c.i}-live.f32`);
    const t0 = performance.now();
    const got = offsetOf(saved, live, c.seconds);
    console.log(`offset case ${c.i} (lead-in ${c.lead} samples, ${c.seconds} s): JS ${got}, Python ${c.expected}, ${(performance.now() - t0).toFixed(0)} ms`);
    assert.equal(got, c.expected);
  }
});

const LONG = '1c0172b58117';
test(`timing on ${LONG}`, { skip: skip || !fs.existsSync(path.join(REFS, LONG, 'samples.f32')) }, async () => {
  const x = f32(REFS, LONG, 'samples.f32');
  let t0 = performance.now();
  const a = analyze(x);
  const analysisMs = performance.now() - t0;
  const job = json(LIBRARY, LONG, 'job.json');
  const segsOut = json(LIBRARY, LONG, job.output.segments_file).map((s) => [s.start, s.end]);
  const spk = 0;
  const turns = job.turns.filter((t) => t[2] === spk).map((t) => [t[0], t[1]]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  t0 = performance.now();
  const smile = await loadSmile();
  const loadMs = performance.now() - t0;
  const own = new Timeline(turns), trimmed = new Timeline(segsOut);
  t0 = performance.now();
  const speech = concat(x, turns);
  const m = metrics(smile, speech, { place: (t) => trimmed.pointsFromSource(own.pointsToSource(t)), timelineDuration: job.output.duration, points: 1400 });
  const metricsMs = performance.now() - t0;
  console.log(`${LONG}: ${(x.length / 16000 / 60).toFixed(1)} min; analysis ${analysisMs.toFixed(0)} ms (${a.trials.length} trials, chosen ${a.chosen});` +
    ` speaker ${spk} metrics on ${(speech.length / 16000 / 60).toFixed(1)} min of speech ${metricsMs.toFixed(0)} ms (+ ${loadMs.toFixed(0)} ms loading openSMILE); stats ${JSON.stringify(m.stats)}`);
});
