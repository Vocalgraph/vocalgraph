// Small pieces of NumPy and Python numerics, reproduced bit for bit, so the
// engine's numbers match the desktop app's exactly rather than approximately.

// numpy's pairwise summation (np.sum / np.mean over a contiguous axis):
// fewer than 8 values summed in order from 0; up to 128 with 8 running sums;
// longer runs split in two at a multiple of 8.
export function pairwiseSum(a, off = 0, n = a.length - off) {
  if (n < 8) {
    let res = 0;
    for (let i = 0; i < n; i++) res += a[off + i];
    return res;
  }
  if (n <= 128) {
    let r0 = a[off], r1 = a[off + 1], r2 = a[off + 2], r3 = a[off + 3],
      r4 = a[off + 4], r5 = a[off + 5], r6 = a[off + 6], r7 = a[off + 7];
    let i = 8;
    const stop = n - (n % 8);
    for (; i < stop; i += 8) {
      const p = off + i;
      r0 += a[p]; r1 += a[p + 1]; r2 += a[p + 2]; r3 += a[p + 3];
      r4 += a[p + 4]; r5 += a[p + 5]; r6 += a[p + 6]; r7 += a[p + 7];
    }
    let res = ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7));
    for (; i < n; i++) res += a[off + i];
    return res;
  }
  let n2 = Math.trunc(n / 2);
  n2 -= n2 % 8;
  return pairwiseSum(a, off, n2) + pairwiseSum(a, off + n2, n - n2);
}


// np.median of a list of numbers (no NaN): the middle value, or the mean of
// the two middle ones, computed as numpy does ((0 + a + b) / 2).
export function median(values) {
  const n = values.length;
  if (!n) return NaN;
  const s = Float64Array.from(values).sort();
  const h = n >> 1;
  return n % 2 ? s[h] : (0 + s[h - 1] + s[h]) / 2;
}

// np.percentile(values, p), the default 'linear' method.
export function percentile(values, p) {
  const s = Float64Array.from(values).sort();
  const n = s.length;
  const q = p / 100;
  const virtual = (n - 1) * q;
  let prev = Math.floor(virtual), next = prev + 1;
  if (virtual >= n - 1) { prev = n - 1; next = n - 1; }
  if (virtual < 0) { prev = 0; next = 0; }
  const gamma = virtual - Math.floor(virtual);
  const a = s[prev], b = s[next], diff = b - a;
  return gamma >= 0.5 ? b - diff * (1 - gamma) : a + diff * gamma;
}

// Python's round(x) to an integer: halves go to the even neighbour.
export function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// np.round(x) on an array element: the same rule (round half to even).
export const npRound = pyRound;

// Python's float x // y and x % y (both operands finite, y != 0).
export function pyDivmod(x, y) {
  let mod = x % y;            // C fmod
  let div = (x - mod) / y;
  if (mod) {
    if ((y < 0) !== (mod < 0)) { mod += y; div -= 1; }
  } else {
    mod = Math.sign(y) * 0;
  }
  let floordiv;
  if (div) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1;
  } else {
    floordiv = (x / y < 0 || Object.is(x / y, -0)) ? -0 : 0;
  }
  return [floordiv, mod];
}

// Python's f"{x:.{digits}f}": correctly rounded, ties to even on the exact
// binary value (JavaScript's toFixed breaks exact ties upward instead).
export function pyFixed(x, digits) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : (x > 0 ? 'inf' : '-inf');
  const neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  let out = ax.toFixed(digits);
  if (ax < 1e21) {
    const long = ax.toFixed(Math.min(100, digits + 30));
    const tail = long.slice(long.length - 30);
    if (tail[0] === '5' && /^50*$/.test(tail)) {
      // An exact tie: keep the truncated value if its last digit is even.
      const trunc = long.slice(0, long.length - 30).replace(/\.$/, '');
      const last = trunc.replace('.', '').slice(-1);
      if (Number(last) % 2 === 0) out = trunc;
    }
  }
  return (neg ? '-' : '') + out;
}

// bisect.bisect_right / np.searchsorted(side="right") on a sorted array.
export function searchRight(arr, v) {
  let lo = 0, hi = arr.length;
  if (Number.isNaN(v)) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (v < arr[mid]) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// Python's sorted() order for tuples of numbers.
export function tupleCompare(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}


// Python's built-in sum() of floats (3.12+): Neumaier-compensated, from 0.
export function pySum(values) {
  let f = 0.0, c = 0.0;
  for (const x of values) {
    const t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x;
    else c += (x - t) + f;
    f = t;
  }
  if (c && Number.isFinite(c)) f += c;
  return f;
}

// sum() over a mix of Python floats and numpy float64s, as CPython runs it:
// compensated while the items are exact Python floats, then (from the first
// numpy scalar on) plain addition. items: [value, isPythonFloat] pairs.
export function pySumMixed(items) {
  let state = 'int', f = 0.0, c = 0.0, r = 0;
  for (const [x, py] of items) {
    if (state === 'int') {
      if (py) state = 'float';
      else { r = 0 + x; state = 'generic'; continue; }
    }
    if (state === 'float') {
      if (py) {
        const t = f + x;
        if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x;
        else c += (x - t) + f;
        f = t;
        continue;
      }
      if (c && Number.isFinite(c)) f += c;
      r = f + x; state = 'generic';
      continue;
    }
    r += x;
  }
  if (state === 'float') { if (c && Number.isFinite(c)) f += c; return f; }
  return r;
}
