// Kaldi-compatible log-mel filterbank (vocalgraph/fbank.py): what pyannote's
// WeSpeaker model computes before the network. 16-bit-range input, 80 mel
// bins, 25 ms Hamming frames every 10 ms, no dither, DC offset removed, 0.97
// pre-emphasis, 512-point power spectrum, log floored at float32 eps, then the
// mean over time subtracted.
//
// Computed in float64 (the Python version runs in float32 through NumPy's FFT
// and a BLAS matmul): the two agree to within 1e-3 (7e-4 on the test recording), far inside
// what the embedding model notices.

export const RATE = 16000;
export const WIN = 400, HOP = 160, NFFT = 512, BINS = 80;
const EPS = 1.1920928955078125e-7;          // np.finfo(np.float32).eps
const HALF = NFFT / 2;                       // 256-point complex FFT of the packed real frame

const mel = (f) => 1127.0 * Math.log(1.0 + f / 700.0);

// Mel filters as sparse rows: bank b covers FFT bins lo[b] .. lo[b] + w[b].length - 1.
const BANK_LO = new Int32Array(BINS);
const BANK_W = [];
{
  const melLow = mel(20.0), melHigh = mel(RATE / 2), delta = (melHigh - melLow) / (BINS + 1);
  for (let b = 0; b < BINS; b++) {
    const left = melLow + b * delta, center = melLow + (b + 1) * delta, right = melLow + (b + 2) * delta;
    const w = [];
    let lo = -1;
    for (let i = 0; i < HALF; i++) {                 // the Nyquist bin gets no weight
      const m = mel((RATE / NFFT) * i);
      const v = Math.max(0, Math.min((m - left) / (center - left), (right - m) / (right - center)));
      if (v > 0) { if (lo < 0) lo = i; w[i - lo] = Math.fround(v); }
      else if (lo >= 0) break;
    }
    BANK_LO[b] = lo < 0 ? 0 : lo;
    BANK_W.push(Float64Array.from(w, (v) => v || 0));
  }
}

const WINDOW = new Float64Array(WIN);
for (let j = 0; j < WIN; j++) WINDOW[j] = Math.fround(0.54 - 0.46 * Math.cos((2 * Math.PI * j) / (WIN - 1)));

// Twiddles for the 256-point complex FFT and for splitting it into the
// 512-point real spectrum.
const BITREV = new Uint16Array(HALF);
for (let i = 0, bits = Math.log2(HALF); i < HALF; i++) {
  let r = 0;
  for (let k = 0; k < bits; k++) r |= ((i >> k) & 1) << (bits - 1 - k);
  BITREV[i] = r;
}
const TW_RE = new Float64Array(HALF / 2), TW_IM = new Float64Array(HALF / 2);
for (let k = 0; k < HALF / 2; k++) { TW_RE[k] = Math.cos((-2 * Math.PI * k) / HALF); TW_IM[k] = Math.sin((-2 * Math.PI * k) / HALF); }
const SP_RE = new Float64Array(HALF + 1), SP_IM = new Float64Array(HALF + 1);
for (let k = 0; k <= HALF; k++) { SP_RE[k] = Math.cos((-2 * Math.PI * k) / NFFT); SP_IM[k] = Math.sin((-2 * Math.PI * k) / NFFT); }

/**
 * (frames, 80) centred log-mel features, row-major Float32Array, for 16 kHz
 * mono float audio in [-1, 1]. frames = 1 + (len - 400) / 160 (998 for 10 s).
 */
export function fbank(x) {
  const n = 1 + Math.floor((x.length - WIN) / HOP);
  if (n < 1) return new Float32Array(0);
  const logs = new Float64Array(n * BINS);
  const frame = new Float64Array(WIN);
  const re = new Float64Array(HALF), im = new Float64Array(HALF);
  const power = new Float64Array(HALF);
  const colSum = new Float64Array(BINS);
  for (let t = 0; t < n; t++) {
    const o = t * HOP;
    let mean = 0;
    for (let j = 0; j < WIN; j++) { const v = x[o + j] * 32768.0; frame[j] = v; mean += v; }
    mean /= WIN;
    // pre-emphasis (replicate-padded) and window, packed as z[m] = s[2m] + i s[2m+1]
    re.fill(0); im.fill(0);
    let prev = frame[0] - mean;
    for (let j = 0; j < WIN; j++) {
      const cur = frame[j] - mean;
      const s = (cur - 0.97 * prev) * WINDOW[j];
      prev = cur;
      const m = BITREV[j >> 1];
      if (j & 1) im[m] = s; else re[m] = s;
    }
    // in-place radix-2 FFT (inputs already in bit-reversed order)
    for (let size = 2; size <= HALF; size <<= 1) {
      const half = size >> 1, stride = HALF / size;
      for (let s0 = 0; s0 < HALF; s0 += size) {
        for (let k = 0; k < half; k++) {
          const wr = TW_RE[k * stride], wi = TW_IM[k * stride];
          const a = s0 + k, b = a + half;
          const tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    // X[k] = (Z[k] + conj Z[N/2-k]) / 2 + e^{-2 pi i k / N} (Z[k] - conj Z[N/2-k]) / 2i
    for (let k = 0; k < HALF; k++) {
      const k2 = k === 0 ? 0 : HALF - k;
      const zr = re[k], zi = im[k], cr = re[k2], ci = -im[k2];
      const er = 0.5 * (zr + cr), ei = 0.5 * (zi + ci);
      const orr = 0.5 * (zi - ci), oi = -0.5 * (zr - cr);        // (Z - conj) / 2i
      const xr = er + SP_RE[k] * orr - SP_IM[k] * oi;
      const xi = ei + SP_RE[k] * oi + SP_IM[k] * orr;
      power[k] = xr * xr + xi * xi;
    }
    const row = t * BINS;
    for (let b = 0; b < BINS; b++) {
      const w = BANK_W[b], lo = BANK_LO[b];
      let e = 0;
      for (let i = 0; i < w.length; i++) e += power[lo + i] * w[i];
      const v = Math.log(Math.max(e, EPS));
      logs[row + b] = v;
      colSum[b] += v;
    }
  }
  const out = new Float32Array(n * BINS);
  for (let b = 0; b < BINS; b++) {
    const m = colSum[b] / n;
    for (let t = 0; t < n; t++) out[t * BINS + b] = logs[t * BINS + b] - m;
  }
  return out;
}
