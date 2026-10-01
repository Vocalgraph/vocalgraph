// Live inputs in the backend worker: microphones (from the page's AudioWorklet)
// and programs' sound (from the local helper, over a WebSocket), kept in step
// the way the desktop app's FFmpeg does it (aresample=async: each input is
// placed on the session clock by its timestamps; short gaps are filled with
// silence, and an input running ahead is trimmed). Each input is saved as it
// comes, at 48 kHz 16-bit, in the browser's private file storage (OPFS), so a
// long session doesn't fill memory; at the end FFmpeg makes the recording
// from those files, with the mix as the first track and each input after it.
// For the analysis: the mix and each input, 16 kHz mono, in blocks.

export const RATE = 48000, OUT_RATE = 16000, FACTOR = 3;
const BLOCK = RATE / 20;              // 50 ms: how often analysis blocks are produced
const SLACK = RATE / 50;              // 20 ms: drift allowed before padding or trimming
const STALL = RATE / 2;               // an input this far behind the clock is padded with silence

// 48 kHz -> 16 kHz: windowed-sinc low-pass (Kaiser, beta 8.6, 0.95 of the new
// Nyquist), then every third sample. Streaming; one per stream.
function kaiser(n, beta) {
  const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
  const w = new Float64Array(n), d = i0(beta);
  for (let k = 0; k < n; k++) { const r = 2 * k / (n - 1) - 1; w[k] = i0(beta * Math.sqrt(1 - r * r)) / d; }
  return w;
}
const TAPS = (() => {
  const n = 127, fc = 0.95 * (OUT_RATE / 2) / RATE, w = kaiser(n, 8.6), h = new Float32Array(n), m = (n - 1) / 2;
  let sum = 0;
  for (let k = 0; k < n; k++) { const x = k - m; h[k] = (x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)) * w[k]; sum += h[k]; }
  for (let k = 0; k < n; k++) h[k] /= sum;
  return h;
})();

export class Decimator {
  constructor() { this.hist = new Float32Array(TAPS.length - 1); this.phase = 0; }
  // mono 48 kHz -> 16 kHz
  push(x) {
    const H = TAPS, L = H.length, buf = new Float32Array(this.hist.length + x.length);
    buf.set(this.hist); buf.set(x, this.hist.length);
    const out = [];
    for (let i = this.phase; i + L <= buf.length; i += FACTOR) {
      let s = 0; for (let k = 0; k < L; k++) s += H[k] * buf[i + k];
      out.push(s);
    }
    const consumed = this.phase + out.length * FACTOR;
    this.phase = consumed - (buf.length - (L - 1));
    this.hist = buf.slice(buf.length - (L - 1));
    if (this.phase < 0) this.phase = 0;
    return Float32Array.from(out);
  }
}

const mono = (data, ch) => {
  if (ch === 1) return data;
  const n = data.length / ch, out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += data[i * ch + c]; out[i] = s / ch; }
  return out;
};

// One input: its samples on the session clock, written to its own file.
class Input {
  constructor(id, name, channels, file) {
    Object.assign(this, { id, name, channels, file, written: 0, pending: [], pendingFrames: 0, error: null, ended: false });
  }
  // Frames of `data` (interleaved float32 at 48 kHz) whose first sample is at
  // `at` frames on the session clock.
  place(data, at) {
    const ch = this.channels, frames = data.length / ch;
    // For the session's diagnostics: what arrives and where it lands.
    this.stats ??= { chunks: 0, peak: 0, padded: 0, trimmed: 0, lastAt: 0, lastHave: 0 };
    this.stats.chunks++; this.stats.lastAt = Math.round(at); this.stats.lastHave = Math.round(this.written + this.pendingFrames);
    for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i]); if (v > this.stats.peak) this.stats.peak = v; }
    const ahead = this.written + this.pendingFrames - at;   // > 0: we already have audio past `at`
    if (-ahead > SLACK) { this.stats.padded += Math.round(-ahead); this.add(new Float32Array(Math.round(-ahead) * ch)); }  // a gap: silence
    if (ahead > SLACK) { const cut = Math.min(frames, Math.round(ahead)); this.stats.trimmed += cut; data = data.subarray(cut * ch); }
    if (data.length) this.add(data);
  }
  add(data) { this.pending.push(data); this.pendingFrames += data.length / this.channels; }
  // Up to `frames` frames, as float32 interleaved; padded with silence if short.
  take(frames) {
    const ch = this.channels, out = new Float32Array(frames * ch);
    let o = 0;
    while (o < frames && this.pending.length) {
      const head = this.pending[0], n = Math.min(frames - o, head.length / ch);
      out.set(head.subarray(0, n * ch), o * ch);
      o += n;
      if (n * ch === head.length) this.pending.shift(); else this.pending[0] = head.subarray(n * ch);
    }
    this.pendingFrames -= o;
    this.written += frames;
    return out;
  }
}

// The live session's inputs. onBlock(mix16, inputs16[]) gets each 50 ms of
// in-step audio, 16 kHz mono. `dir` is an OPFS directory for the recordings.
export class Inputs {
  constructor(dir, onBlock) {
    this.dir = dir; this.onBlock = onBlock;
    this.list = []; this.start = null;
    this.mixDec = new Decimator(); this.decs = [];
    this.sockets = [];
  }

  async add(id, name, channels) {
    const fh = await this.dir.getFileHandle(`input${this.list.length}.s16`, { create: true });
    const file = await fh.createSyncAccessHandle();
    file.truncate(0);
    const inp = new Input(id, name, channels, file);
    this.list.push(inp); this.decs.push(new Decimator());
    return inp;
  }

  now() { return performance.timeOrigin + performance.now(); }
  begin() { this.start = this.now(); this.timer = setInterval(() => this.pump(), 25); }

  // From the page's AudioWorklet: {id, t (audio clock s), data, channels}, with
  // the clock's mapping to epoch ms given when the microphone opened.
  pcmFromPage(msg, clock) {
    const inp = this.list.find(i => i.id === msg.id);
    if (!inp || this.start == null) return;
    const epoch = clock.epoch + (msg.t - clock.contextTime) * 1000;
    inp.place(msg.data, (epoch - this.start) / 1000 * RATE);
  }

  // A program's sound from the helper: s16 stereo 48 kHz, each message
  // prefixed with the helper's send time (epoch ms, float64).
  connectHelper(inp, url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      let opened = false;
      ws.onopen = () => { opened = true; resolve(); };
      ws.onerror = () => { if (!opened) reject(new Error(`Couldn't get ${inp.name}'s sound from the helper.`)); };
      ws.onclose = () => { inp.ended = true; if (opened && !this.stopping) inp.error = `${inp.name}: the helper stopped sending sound.`; };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string' || this.start == null) return;
        const sent = new DataView(ev.data).getFloat64(0, true);
        const s16 = new Int16Array(ev.data, 8), f = new Float32Array(s16.length);
        for (let i = 0; i < s16.length; i++) f[i] = s16[i] / 32768;
        const frames = f.length / inp.channels;
        inp.place(f, (sent - this.start) / 1000 * RATE - frames);   // sent once captured: it started that long before
      };
      this.sockets.push(ws);
    });
  }

  // Every 25 ms: hand on whatever all inputs have, in 50 ms blocks; an input
  // stalled well behind the clock is padded so the others don't wait for it.
  pump() {
    if (this.start == null || !this.list.length) return;
    const clock = (this.now() - this.start) / 1000 * RATE;
    for (const inp of this.list) {
      const have = inp.written + inp.pendingFrames;
      if (clock - have > STALL) inp.add(new Float32Array(Math.round(clock - have - SLACK) * inp.channels));
    }
    while (this.list.every(i => i.pendingFrames >= BLOCK)) this.block(BLOCK);
  }

  block(frames) {
    const mix48 = new Float32Array(frames), inputs16 = [];
    this.list.forEach((inp, k) => {
      const data = inp.take(frames), m = mono(data, inp.channels);
      for (let i = 0; i < frames; i++) mix48[i] += m[i];          // summed, as amix normalize=0
      const s16 = new Int16Array(data.length);
      for (let i = 0; i < data.length; i++) s16[i] = Math.max(-32768, Math.min(32767, Math.round(data[i] * 32768)));
      inp.file.write(s16, { at: inp.file.getSize() });
      inputs16.push(this.decs[k].push(m));
    });
    this.onBlock(this.mixDec.push(mix48), this.list.length > 1 ? inputs16 : null);
  }

  // Stop: send what's left, close the files.
  stop() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const ws of this.sockets) { try { ws.close(); } catch {} }
    const rest = Math.max(0, ...this.list.map(i => i.pendingFrames));
    if (rest) this.block(Math.round(rest));
    for (const inp of this.list) { inp.file.flush(); inp.file.close(); }
  }
}
