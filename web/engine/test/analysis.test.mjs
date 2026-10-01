// analysis.js against core.analyze: a fresh Python run on the same decoded
// samples, and the analysis.json saved in the library.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyze, Analysis } from '../analysis.js';
import { REFS, LIBRARY, skip, json, f32, compare, describeResult } from './common.mjs';

const recordings = skip ? [] : fs.readdirSync(REFS).filter((d) => fs.existsSync(path.join(REFS, d, 'analysis_fresh.json')));

for (const rid of recordings) {
  test(`analysis ${rid}`, { skip }, () => {
    const x = f32(REFS, rid, 'samples.f32');
    const t0 = performance.now();
    const a = analyze(x);
    const ms = performance.now() - t0;
    const got = a.toDict();
    const fresh = json(REFS, rid, 'analysis_fresh.json');
    const pySeconds = fresh.python_seconds; delete fresh.python_seconds;
    const r = compare(got, fresh);
    console.log(describeResult(`${rid} vs fresh Python (${(x.length / 16000 / 60).toFixed(1)} min, JS ${ms.toFixed(0)} ms, Python incl. decode ${pySeconds.toFixed(2)} s)`, r),
      `chosen ${got.chosen}, ${got.trials.length} trials`);
    assert.ok(r.ok, r.mismatches.join('\n'));
    assert.equal(got.chosen, fresh.chosen);
    assert.equal(got.note, fresh.note);

    const saved = json(LIBRARY, rid, 'analysis.json');
    const s = compare(got, saved);
    console.log(describeResult(`${rid} vs saved analysis.json`, s));
    assert.ok(s.ok, s.mismatches.join('\n'));

    // from_dict/to_dict round trip
    assert.deepEqual(Analysis.fromDict(saved).toDict(), saved);
    assert.deepEqual(a.trial(a.chosen).segments, fresh.trials.find((t) => t.threshold === fresh.chosen).segments);
  });
}
