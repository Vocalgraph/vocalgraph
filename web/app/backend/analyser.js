// The backend's side of Live's analysis worker (analysis-worker.js): one
// worker per page, made when the Live page first lists its inputs so that
// openSMILE and the speaker models load while the user chooses, and kept for
// the next session. Calls are answered in order, as the worker gets to them.
export class Analyser {
  constructor() {
    this.worker = new Worker(new URL('analysis-worker.js', import.meta.url), { type: 'module', name: 'vocalgraph-live-analysis' });
    this.calls = 0; this.waiting = new Map(); this.n = 0; this.failed = null;
    const loaded = {}, settle = {};
    for (const what of ['smile', 'models']) loaded[what] = new Promise((resolve, reject) => { settle[what] = { resolve, reject }; });
    for (const p of Object.values(loaded)) p.catch(() => {});
    // ready: both loaded (or why one didn't).
    this.ready = Promise.all([loaded.smile, loaded.models]).then(() => {});
    this.ready.catch(() => {});
    this.worker.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m?.kind === 'loaded') settle[m.what].resolve();
      else if (m?.kind === 'failed') { this.failed = m.error; settle[m.what].reject(new Error(m.error)); }
      else if (m?.kind === 'reply' && this.waiting.has(m.call)) {
        const w = this.waiting.get(m.call); this.waiting.delete(m.call);
        m.error ? w.reject(new Error(m.error)) : w.resolve(m.result);
      }
    });
    // The worker failing to start, or dying: everything waiting gets the reason.
    this.worker.addEventListener('error', (e) => {
      const why = new Error(`the live analysis stopped (${e.message || 'its worker failed'})`);
      this.failed = why.message;
      for (const s of Object.values(settle)) s.reject(why);
      for (const w of this.waiting.values()) w.reject(why);
      this.waiting.clear();
    });
  }

  call(op, args = {}) {
    const call = ++this.calls;
    return new Promise((resolve, reject) => {
      this.waiting.set(call, { resolve, reject });
      this.worker.postMessage({ kind: 'call', op, args, call });
    });
  }

  // A new session (replacing the last one). n counts the 16 kHz samples fed.
  start(tracks, names, numSpeakers) { this.n = 0; return this.call('start', { tracks, names, numSpeakers }); }
  // 16 kHz blocks: the mix, and each input when several. Copied, so a view
  // into a larger buffer (a replay's) doesn't send all of it.
  feed(mix, inputs) {
    const m = mix.slice(), ins = inputs ? inputs.map(t => t.slice()) : null;
    this.n += m.length;
    this.worker.postMessage({ kind: 'feed', mix: m, inputs: ins }, [m.buffer, ...(ins || []).map(t => t.buffer)]);
  }
}
