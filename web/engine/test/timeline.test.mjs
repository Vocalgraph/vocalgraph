// timeline.js and measure.js's span helpers against Python on random cases
// (timeline_cases.json, span_cases.json from make_refs.py).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline, concat, intersect, union } from '../timeline.js';
import { join, overlap, inside } from '../measure.js';
import { REFS, skip, json, compare, describeResult } from './common.mjs';

const nan = (v) => v.map((x) => (x === null ? NaN : x));

function check(label, got, want) {
  const r = compare(got, want);
  if (!r.ok) console.log(describeResult(label, r), r.mismatches);
  return r;
}

test('Timeline, intersect, union', { skip }, () => {
  const { cases } = json(REFS, 'timeline_cases.json');
  const totals = { floats: 0, identical: 0, bad: 0 };
  const add = (r) => { totals.floats += r.floats; totals.identical += r.identical; totals.bad += r.count; };
  cases.forEach((c, i) => {
    const tl = new Timeline(c.segs);
    add(check(`case ${i} offsets`, [tl.offsets, tl.total], [c.offsets, c.total]));
    add(check(`case ${i} to_source`, c.queries.map(([a, b]) => tl.toSource(a, b)), c.to_source));
    add(check(`case ${i} from_source`, c.src_queries.map(([a, b]) => tl.fromSource(a, b)), c.from_source));
    add(check(`case ${i} points_to_source`, Array.from(tl.pointsToSource(nan(c.points))), c.points_to_source));
    add(check(`case ${i} points_from_source`, Array.from(tl.pointsFromSource(nan(c.src_points))), c.points_from_source));
    add(check(`case ${i} intersect`, intersect(c.segs, c.other), c.intersect));
    add(check(`case ${i} union`, union(c.spans, c.pad, c.limit), c.union));
  });
  console.log(`timeline: ${cases.length} cases, ${totals.bad} mismatches, ${totals.identical}/${totals.floats} floats bit-identical`);
  assert.equal(totals.bad, 0);
});

test('concat', { skip }, () => {
  const { concat: cases, ramp_length } = json(REFS, 'timeline_cases.json');
  const ramp = Float32Array.from({ length: ramp_length }, (_, i) => i);
  for (const c of cases) {
    const out = concat(ramp, c.segs);
    assert.equal(out.length, c.length);
    const runs = [];
    for (const v of out) { const last = runs[runs.length - 1]; if (last && last[1] === v) last[1] = v + 1; else runs.push([v, v + 1]); }
    assert.deepEqual(runs, c.runs);
  }
  console.log(`concat: ${cases.length} cases identical`);
});

test('_join, _overlap, _inside', { skip }, () => {
  const cases = json(REFS, 'span_cases.json');
  let bad = 0;
  for (const c of cases) {
    bad += check('join', join(c.turns, c.gap), c.join).count;
    bad += check('overlap', overlap(c.a, c.b), c.overlap).count;
    bad += check('inside', Array.from(inside(c.t, c.a)), c.inside).count;
  }
  console.log(`spans: ${cases.length} cases, ${bad} mismatches`);
  assert.equal(bad, 0);
});
