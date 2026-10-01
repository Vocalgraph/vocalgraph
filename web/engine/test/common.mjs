// Shared helpers for the engine's parity tests. Reference data comes from
// make_refs.py and lives outside the repo (VOCALGRAPH_REFS, default below).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..', '..');
export const LIBRARY = process.env.VOCALGRAPH_LIBRARY || path.join(ROOT, 'library');
export const REFS = process.env.VOCALGRAPH_REFS ||
  path.join(process.env.LOCALAPPDATA || '', 'Temp', 'vstage', 'engine-refs-analysis');

export const hasRefs = fs.existsSync(path.join(REFS, 'timeline_cases.json'));
export const skip = hasRefs ? false : `no reference data in ${REFS}: run make_refs.py`;

export const json = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8').replace(/^﻿/, ''));
function bin(Type, file) {
  const b = fs.readFileSync(file);
  return new Type(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
export const f32 = (...p) => bin(Float32Array, path.join(...p));
export const f64 = (...p) => bin(Float64Array, path.join(...p));

/** Compare JSON-like values: numbers to `tol` (relative above 1), null/NaN
 * positions exactly, strings and structure exactly. Returns counts and the
 * first few mismatches. */
export function compare(actual, expected, tol = 1e-9) {
  const r = { floats: 0, identical: 0, maxDiff: 0, mismatches: [] };
  const miss = (p, a, e) => { if (r.mismatches.length < 10) r.mismatches.push(`${p}: got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`); else r.mismatches.push(null); };
  const isNum = (v) => typeof v === 'number';
  (function walk(a, e, p) {
    if (ArrayBuffer.isView(a)) a = Array.from(a);
    const aNull = a === null || a === undefined || (isNum(a) && Number.isNaN(a));
    const eNull = e === null || e === undefined || (isNum(e) && Number.isNaN(e));
    if (aNull || eNull) { if (aNull !== eNull) miss(p, a, e); return; }
    if (isNum(e)) {
      if (!isNum(a)) return miss(p, a, e);
      r.floats++;
      const d = Math.abs(a - e);
      if (d === 0) r.identical++;
      r.maxDiff = Math.max(r.maxDiff, d);
      if (d > tol * Math.max(1, Math.abs(e))) miss(p, a, e);
      return;
    }
    if (Array.isArray(e)) {
      if (!Array.isArray(a) || a.length !== e.length) return miss(p, a?.length, e.length);
      e.forEach((v, i) => walk(a[i], v, `${p}[${i}]`));
      return;
    }
    if (typeof e === 'object') {
      const ka = Object.keys(a).join(), ke = Object.keys(e).join();
      if (ka !== ke) return miss(`${p} keys`, ka, ke);
      for (const k of Object.keys(e)) walk(a[k], e[k], `${p}.${k}`);
      return;
    }
    if (a !== e) miss(p, a, e);
  })(actual, expected, '');
  r.count = r.mismatches.length;
  r.mismatches = r.mismatches.filter(Boolean);
  r.ok = r.count === 0;
  return r;
}

export function describeResult(label, r) {
  return `${label}: ${r.ok ? 'match' : `${r.count} mismatches`}; ${r.identical}/${r.floats} floats bit-identical, max diff ${r.maxDiff.toExponential(2)}`;
}

export const pairs = (a) => a.map((s) => [...s]);
