// Bit-for-bit reproductions of the NumPy / OpenBLAS / CPython behaviour the
// speaker grouping depends on, where "any correct implementation" would give
// a different answer on ties or in the last bit:
//
//   argsort     np.argsort's default (kind="quicksort") on x86-64 with AVX2:
//               NumPy hands it to x86-simd-sort (avx2_argsort, 4 keys per
//               register), which is not stable. Its tie order decides which
//               cluster a frame goes to when two are equally active.
//   sum32       np.add.reduce over a contiguous float32 axis (pairwise).
//   sdot        np.dot of two float32 vectors: OpenBLAS's sdot (SkylakeX kernel,
//               FMA accumulators then a fixed reduction tree).
//   pySum       Python's built-in sum() of floats (Neumaier-compensated since 3.12).
//   pySetOrder  the iteration order of set(d) for a dict d of small ints.
//
// Sources ported: numpy 2.5.3 (x86-simd-sort fa944efb), OpenBLAS 0.3.34
// kernel/x86_64/sdot.c + sdot_microk_skylakex-2.c, CPython 3.13
// Objects/setobject.c and Python/bltinmodule.c (builtin_sum_impl).

const f32 = Math.fround;

// ---------------------------------------------------------------- float32 ---

const _fb = new Float32Array(1), _ib = new Int32Array(_fb.buffer);

/** The float32 next to f32 value r, towards +inf (up) or -inf. */
function nextFloat32(r, up) {
  if (r === 0) return up ? 1.401298464324817e-45 : -1.401298464324817e-45;
  _fb[0] = r;
  _ib[0] += (r > 0) === up ? 1 : -1;
  return _fb[0];
}

/** fma(a, b, c) rounded once to float32 (a, b, c float32 values), as vfmadd231ps. */
export function fma32(a, b, c) {
  const p = a * b;                      // exact: 24 + 24 bits fit in a double
  const s = p + c;
  const bb = s - p;
  const err = (p - (s - bb)) + (c - bb); // s + err is exactly p + c
  const r = f32(s);
  if (err === 0 || r === s) return r;
  // s is not a float32; rounding s alone is right unless s sits exactly half
  // way between two float32s (then the sign of err breaks the tie).
  const q = nextFloat32(r, s > r);
  if (s - r !== q - s) return r;
  return err > 0 ? Math.max(r, q) : Math.min(r, q);
}

/** np.add.reduce of float32 values a[off .. off+n) (pairwise, 8 accumulators). */
export function sum32(a, off = 0, n = a.length - off) {
  if (n < 8) {
    let res = 0;
    for (let i = 0; i < n; i++) res = f32(res + a[off + i]);
    return res;
  }
  if (n <= 128) {
    let r0 = a[off], r1 = a[off + 1], r2 = a[off + 2], r3 = a[off + 3],
      r4 = a[off + 4], r5 = a[off + 5], r6 = a[off + 6], r7 = a[off + 7];
    let i = 8;
    const stop = n - (n % 8);
    for (; i < stop; i += 8) {
      const p = off + i;
      r0 = f32(r0 + a[p]); r1 = f32(r1 + a[p + 1]); r2 = f32(r2 + a[p + 2]); r3 = f32(r3 + a[p + 3]);
      r4 = f32(r4 + a[p + 4]); r5 = f32(r5 + a[p + 5]); r6 = f32(r6 + a[p + 6]); r7 = f32(r7 + a[p + 7]);
    }
    let res = f32(f32(f32(r0 + r1) + f32(r2 + r3)) + f32(f32(r4 + r5) + f32(r6 + r7)));
    for (; i < n; i++) res = f32(res + a[off + i]);
    return res;
  }
  let n2 = Math.trunc(n / 2);
  n2 -= n2 % 8;
  return f32(sum32(a, off, n2) + sum32(a, off + n2, n - n2));
}

/** np.dot(x, y) for float32 vectors of length n: OpenBLAS sdot with the
 * SkylakeX kernel (what OpenBLAS's DYNAMIC_ARCH picks on AVX-512 CPUs such as
 * Zen 4/5): 4 x 16-lane FMA accumulators over 64s, folded to 4 x 8 lanes,
 * then 32s, then a fixed reduction tree. */
export function sdot(x, xo, y, yo, n) {
  const n1 = n & -32;
  let mydot = 0;
  if (n1) {
    const n64 = n1 & ~63;
    const a = new Float64Array(64);
    let i = 0;
    for (; i < n64; i += 64) for (let j = 0; j < 64; j++) a[j] = fma32(x[xo + i + j], y[yo + i + j], a[j]);
    const acc = new Float64Array(32);    // accum_0..3, 8 lanes each
    for (let r = 0; r < 4; r++) for (let j = 0; j < 8; j++) acc[8 * r + j] = f32(a[16 * r + j] + a[16 * r + 8 + j]);
    for (; i < n1; i += 32) for (let j = 0; j < 32; j++) acc[j] = fma32(x[xo + i + j], y[yo + i + j], acc[j]);
    const s = new Float64Array(8);
    for (let j = 0; j < 8; j++) s[j] = f32(f32(f32(acc[j] + acc[8 + j]) + acc[16 + j]) + acc[24 + j]);
    const h = [0, 1, 2, 3].map((j) => f32(s[j] + s[4 + j]));
    mydot = f32(f32(h[0] + h[1]) + f32(h[2] + h[3]));   // _mm_hadd_ps twice
  }
  let dot = 0;                            // a double in sdot.c
  for (let i = n1; i < n; i++) dot += f32(y[yo + i] * x[xo + i]);
  dot += mydot;
  return f32(dot);
}

/** np.linalg.norm of a float32 vector (sqrt of its sdot with itself), float32. */
export function norm32(x, xo, n) {
  return f32(Math.sqrt(sdot(x, xo, x, xo, n)));
}

// ----------------------------------------------------------------- Python ---

/** Python's sum(values) for a list of floats (start 0). */
export function pySum(values) {
  const n = values.length;
  if (!n) return 0;
  let f = 0 + values[0], c = 0;
  for (let i = 1; i < n; i++) {
    const x = values[i], t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x;
    else c += (x - t) + f;
    f = t;
  }
  if (c && Number.isFinite(c)) f += c;
  return f;
}

/**
 * The order CPython iterates set(d) in, for a dict d whose keys (small
 * non-negative ints, hash = value) are given in d's insertion order.
 * Discarding from the set later keeps the order of the rest.
 */
export function pySetOrder(keys) {
  const LINEAR_PROBES = 9, PERTURB_SHIFT = 5;
  let size = 8;
  // set_update_dict_lock_held: one resize up front when the dict is big
  if (keys.length * 5 >= (size - 1) * 3) {
    const minused = keys.length * 2;
    size = 8;
    while (size <= minused) size <<= 1;
  }
  let table = new Array(size).fill(null);
  let fill = 0;
  const insertInto = (tab, key) => {
    const mask = tab.length - 1;
    let i = key & mask;
    let perturb = key;
    for (;;) {
      const probes = (i + LINEAR_PROBES <= mask) ? LINEAR_PROBES : 0;
      for (let p = 0; p <= probes; p++) {
        const e = i + p;
        if (tab[e] === null) { tab[e] = key; return; }
        if (tab[e] === key) return;
      }
      perturb = Math.floor(perturb / 32);  // >>= PERTURB_SHIFT (non-negative)
      i = (i * 5 + 1 + perturb) & mask;
    }
  };
  for (const k of keys) {
    insertInto(table, k);                   // dict keys are distinct
    fill++;
    const mask = table.length - 1;
    if (fill * 5 >= mask * 3) {
      const used = fill;
      let ns = 8;
      const minused = used > 50000 ? used * 2 : used * 4;
      while (ns <= minused) ns <<= 1;
      const nt = new Array(ns).fill(null);
      for (const e of table) if (e !== null) insertInto(nt, e);  // set_insert_clean
      table = nt;
    }
  }
  void PERTURB_SHIFT;
  return table.filter((e) => e !== null);
}

// ------------------------------------------------ np.argsort (x86-simd-sort) ---

const L = 4;                                // keys per AVX2 register (float32 half / float64)
const REV2 = [1, 0, 3, 2], REV4 = [3, 2, 1, 0], SWAP4 = [2, 3, 0, 1];
const IDX_PAD = -1;                         // index lanes loaded past the end (never stored)

// A register is 4 keys + 4 indices. cmp_merge(reg, perm(reg), mask): lanes
// with their mask bit set take the max of the pair, others the min; a lane
// keeps its own index when its key didn't change (so ties never swap).
function cmpMerge(k, v, o, perm, mask) {
  const nk = [0, 0, 0, 0], nv = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const a = k[o + perm[i]], b = k[o + i];         // in2, in1
    const t = (mask >> i) & 1 ? (a > b ? a : b) : (a < b ? a : b);
    nk[i] = t;
    nv[i] = t === b ? v[o + i] : v[o + perm[i]];
  }
  for (let i = 0; i < 4; i++) { k[o + i] = nk[i]; v[o + i] = nv[i]; }
}

function sortReg(k, v, o) {                  // sort_reg_4lanes
  cmpMerge(k, v, o, REV2, 0xA);
  cmpMerge(k, v, o, REV4, 0xC);
  cmpMerge(k, v, o, REV2, 0xA);
}

function mergeReg(k, v, o) {                 // bitonic_merge_reg_4lanes
  cmpMerge(k, v, o, SWAP4, 0xC);
  cmpMerge(k, v, o, REV2, 0xA);
}

// COEX of registers p and q (q's lanes optionally read reversed).
function coex(k, v, p, q, reversed) {
  for (let i = 0; i < 4; i++) {
    const a = p + i, b = q + (reversed ? 3 - i : i);
    const k1 = k[a], k2 = k[b];
    const lo = k1 < k2 ? k1 : k2, hi = k1 > k2 ? k1 : k2;
    if (lo === k1) { k[a] = lo; k[b] = hi; } else {
      k[a] = lo; k[b] = hi;
      const t = v[a]; v[a] = v[b]; v[b] = t;
    }
  }
}

function bitonicMergeNVec(k, v, base, m) {
  if (m === 2) coex(k, v, base, base + L, true);
  else for (let i = 0; i < m / 2; i++) coex(k, v, base + i * L, base + (m - i - 1) * L, true);
  for (let num = m / 2; num >= 2; num /= 2) {
    for (let j = 0; j < m; j += num) {
      for (let i = 0; i < num / 2; i++) coex(k, v, base + (i + j) * L, base + (i + j + num / 2) * L, false);
    }
  }
  for (let i = 0; i < m; i++) mergeReg(k, v, base + i * L);
}

function argsortN(arr, arg, off, N) {         // argsort_n<.., 256>
  let numVecs = 256 / L;
  while (numVecs > 1 && N * 2 <= numVecs * L) numVecs /= 2;
  const k = new Float64Array(numVecs * L), v = new Float64Array(numVecs * L);
  for (let i = 0; i < numVecs; i++) {
    const full = i < numVecs / 2;
    const take = full ? L : Math.min(Math.max(0, N - i * L), L);
    for (let j = 0; j < L; j++) {
      const at = i * L + j;
      if (j < take) { v[at] = arg[off + at]; k[at] = arr[v[at]]; } else { v[at] = IDX_PAD; k[at] = Infinity; }
    }
  }
  for (let i = 0; i < numVecs; i++) sortReg(k, v, i * L);
  for (let per = 2; per <= numVecs; per *= 2) {
    for (let i = 0; i < numVecs / per; i++) bitonicMergeNVec(k, v, i * per * L, per);
  }
  for (let at = 0; at < N; at++) arg[off + at] = v[at];
}

// partition_vec_avx2: lanes below the pivot are compressed to the left (in
// order), the rest to the right end in reverse; the whole register is stored
// at both `left` and `right - 4` (in that order) and the count >= pivot returned.
function partitionVec(arg, left, right, idx, keys, pivot, mm) {
  const temp = [0, 0, 0, 0];
  let lo = 0, hi = 3, ge = 0;
  for (let j = 0; j < 4; j++) {
    if (keys[j] >= pivot) { temp[hi--] = idx[j]; ge++; } else temp[lo++] = idx[j];
    if (keys[j] < mm[0]) mm[0] = keys[j];
    if (keys[j] > mm[1]) mm[1] = keys[j];
  }
  for (let j = 0; j < 4; j++) arg[left + j] = temp[j];
  for (let j = 0; j < 4; j++) arg[right - 4 + j] = temp[j];
  return ge;
}

function load(arr, arg, at) {
  const idx = [arg[at], arg[at + 1], arg[at + 2], arg[at + 3]];
  return [idx, idx.map((i) => arr[i])];
}

function argpartition(arr, arg, left, right, pivot, mm) {
  for (let i = (right - left) % L; i > 0; --i) {
    const x = arr[arg[left]];
    if (x < mm[0]) mm[0] = x;
    if (mm[1] < x) mm[1] = x;
    if (!(x < pivot)) { --right; const t = arg[left]; arg[left] = arg[right]; arg[right] = t; } else ++left;
  }
  if (left === right) return left;
  const vm = [mm[0], mm[1]];
  if (right - left === L) {
    const [iv, kv] = load(arr, arg, left);
    const g = partitionVec(arg, left, left + L, iv, kv, pivot, vm);
    mm[0] = vm[0]; mm[1] = vm[1];
    return left + (L - g);
  }
  const [ivl, kvl] = load(arr, arg, left);
  const [ivr, kvr] = load(arr, arg, right - L);
  let rStore = right - L, lStore = left;
  left += L; right -= L;
  while (right - left !== 0) {
    let iv, kv;
    if ((rStore + L) - right < left - lStore) { right -= L; [iv, kv] = load(arr, arg, right); } else { [iv, kv] = load(arr, arg, left); left += L; }
    const g = partitionVec(arg, lStore, rStore + L, iv, kv, pivot, vm);
    rStore -= g; lStore += L - g;
  }
  let g = partitionVec(arg, lStore, rStore + L, ivl, kvl, pivot, vm);
  lStore += L - g;
  g = partitionVec(arg, lStore, lStore + L, ivr, kvr, pivot, vm);
  lStore += L - g;
  mm[0] = vm[0]; mm[1] = vm[1];
  return lStore;
}

function argpartitionUnrolled(arr, arg, left, right, pivot, mm) {
  const U = 4;
  if (right - left <= 8 * U * L) return argpartition(arr, arg, left, right, pivot, mm);
  for (let i = (right - left) % (U * L); i > 0; --i) {
    const x = arr[arg[left]];
    if (x < mm[0]) mm[0] = x;
    if (mm[1] < x) mm[1] = x;
    if (!(x < pivot)) { --right; const t = arg[left]; arg[left] = arg[right]; arg[right] = t; } else ++left;
  }
  if (left === right) return left;
  const vm = [mm[0], mm[1]];
  const vl = [], vr = [];
  for (let ii = 0; ii < U; ii++) {
    vl.push(load(arr, arg, left + L * ii));
    vr.push(load(arr, arg, right - L * (U - ii)));
  }
  let rStore = right - L, lStore = left;
  left += U * L; right -= U * L;
  while (right - left !== 0) {
    const cur = [];
    if ((rStore + L) - right < left - lStore) {
      right -= U * L;
      for (let ii = 0; ii < U; ii++) cur.push(load(arr, arg, right + ii * L));
    } else {
      for (let ii = 0; ii < U; ii++) cur.push(load(arr, arg, left + ii * L));
      left += U * L;
    }
    for (let ii = 0; ii < U; ii++) {
      const g = partitionVec(arg, lStore, rStore + L, cur[ii][0], cur[ii][1], pivot, vm);
      lStore += L - g; rStore -= g;
    }
  }
  for (const set of [vl, vr]) {
    for (let ii = 0; ii < U; ii++) {
      const g = partitionVec(arg, lStore, rStore + L, set[ii][0], set[ii][1], pivot, vm);
      lStore += L - g; rStore -= g;
    }
  }
  mm[0] = vm[0]; mm[1] = vm[1];
  return lStore;
}

function getPivot(arr, arg, left, right) {
  if (right - left >= L) {
    const size = Math.floor((right - left) / 4);
    const vals = [arr[arg[left + size]], arr[arg[left + 2 * size]], arr[arg[left + 3 * size]], arr[arg[left + 4 * size]]];
    vals.sort((a, b) => a - b);
    return vals[2];
  }
  return arr[arg[right]];
}

let fallbacks = 0;
/** How often argsort had to fall back to std::sort (not reproduced exactly). */
export const argsortFallbacks = () => fallbacks;

function argsortRec(arr, arg, left, right, maxIters) {
  if (maxIters <= 0) {
    // std::sort (MSVC's introsort) is not reproduced; a stable sort stands in.
    fallbacks++;
    const part = Array.from(arg.subarray(left, right + 1)).sort((a, b) => arr[a] - arr[b]);
    arg.set(part, left);
    return;
  }
  if (right + 1 - left <= 256) { argsortN(arr, arg, left, right + 1 - left); return; }
  const pivot = getPivot(arr, arg, left, right);
  const mm = [Infinity, -Infinity];
  const p = argpartitionUnrolled(arr, arg, left, right + 1, pivot, mm);
  if (pivot !== mm[0]) argsortRec(arr, arg, left, p - 1, maxIters - 1);
  if (pivot !== mm[1]) argsortRec(arr, arg, p, right, maxIters - 1);
}

/**
 * np.argsort(values) (default kind) as NumPy 2.5 computes it on an AVX2
 * machine, for finite float32 or float64 values (no NaN). Returns Int32Array.
 */
export function argsort(values) {
  const n = values.length;
  const arg = new Int32Array(n);
  for (let i = 0; i < n; i++) arg[i] = i;
  if (n <= 1) return arg;
  let sorted = true;
  for (let i = 1; i < n; i++) if (values[i] < values[i - 1]) { sorted = false; break; }
  if (sorted) return arg;
  argsortRec(values, arg, 0, n - 1, 2 * Math.trunc(Math.log2(n)));
  return arg;
}
