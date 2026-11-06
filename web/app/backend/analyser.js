// The backend's side of Live's analysis: two workers (analysis-worker.js),
// one for the voice and one for the speakers, made when the Live page first
// lists its inputs so that openSMILE and the speaker models load while the
// user chooses, and kept for the next session. Each gets every block; the
// answers that need both (the state, the voice measures of one speaker, what
// is filed with the recording) are put together here.

// One worker, with calls answered in order as it gets to them.
class Part {
  constructor(as) {
    this.worker = new Worker(new URL('analysis-worker.js', import.meta.url), { type: 'module', name: `vocalgraph-live-${as}` });
    this.calls = 0; this.waiting = new Map(); this.failed = null;
    let settle;
    this.loaded = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    this.loaded.catch(() => {});
    this.worker.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m?.kind === 'loaded') settle.resolve();
      else if (m?.kind === 'failed') { this.failed = m.error; settle.reject(new Error(m.error)); }
      else if (m?.kind === 'reply' && this.waiting.has(m.call)) {
        const w = this.waiting.get(m.call); this.waiting.delete(m.call);
        m.error ? w.reject(new Error(m.error)) : w.resolve(m.result);
      }
    });
    // The worker failing to start, or dying: everything waiting gets the reason.
    this.worker.addEventListener('error', (e) => {
      const why = new Error(`the live analysis stopped (${e.message || 'its worker failed'})`);
      this.failed = why.message;
      settle.reject(why);
      for (const w of this.waiting.values()) w.reject(why);
      this.waiting.clear();
    });
    this.call('init', { as }).catch(() => {});
  }
  call(op, args = {}) {
    const call = ++this.calls;
    return new Promise((resolve, reject) => {
      this.waiting.set(call, { resolve, reject });
      this.worker.postMessage({ kind: 'call', op, args, call });
    });
  }
  feed(mix, inputs) {
    const m = mix.slice(), ins = inputs ? inputs.map(t => t.slice()) : null;
    this.worker.postMessage({ kind: 'feed', mix: m, inputs: ins }, [m.buffer, ...(ins || []).map(t => t.buffer)]);
  }
}

const STATE_WAIT = 300;          // ms the state waits for the speakers before using their last answer

export class Analyser {
  constructor() {
    this.voice = new Part('voice'); this.speakers = new Part('speakers'); this.n = 0;
    // ready: openSMILE and the speaker models loaded (or why one didn't).
    this.ready = Promise.all([this.voice.loaded, this.speakers.loaded]).then(() => {});
    this.ready.catch(() => {});
  }
  get failed() { return this.voice.failed || this.speakers.failed; }
  terminate() { this.voice.worker.terminate(); this.speakers.worker.terminate(); }
  both(op, args) { return Promise.all([this.voice.call(op, args), this.speakers.call(op, args)]); }

  // A new session (replacing the last one). n counts the 16 kHz samples fed.
  start(tracks, names, numSpeakers) { this.n = 0; this.last = null; return this.both('start', { tracks, names, numSpeakers }); }
  // 16 kHz blocks: the mix, and each input when several (copied for each
  // worker, so a view into a larger buffer, a replay's, doesn't send it all).
  feed(mix, inputs) { this.n += mix.length; this.voice.feed(mix, inputs); this.speakers.feed(mix, inputs); }
  end() { return this.both('end'); }
  close() { return this.both('close'); }

  // The speakers' state, with the voice's own lag and readiness. The voice
  // answers quickly; the speakers when they're free, so if they're busy (a
  // batch of voiceprints) their last answer is used, moved on to now.
  async state(extra) {
    const asked = this.speakers.call('state', { extra }).then((s) => (this.last = s));
    const late = new Promise((r) => setTimeout(r, STATE_WAIT, null));
    const [v, fresh] = await Promise.all([this.voice.call('state', { extra }), this.last ? Promise.race([asked, late]) : asked]);
    const duration = this.n / 16000;
    const s = fresh || { ...this.last, ...extra, error: extra.error || this.last.error || null, duration,
      speakers_behind: extra.status === 'live' ? this.last.speakers_behind + Math.max(0, duration - this.last.duration) : 0 };
    return { ...s, voice_behind: v.voice_behind, level: v.level ?? s.level, preparing: v.preparing,
             error: s.error || v.error || null };
  }
  frames(from) { return this.voice.call('frames', { from }); }
  // One speaker's (or everyone's) voice measures: their turns from the
  // speakers, measured over the voice's frames.
  async voiceOf(spk, points, gate) {
    const spans = await this.speakers.call('spans', { spk });
    return this.voice.call('voice', { spk, points, gate, spans });
  }
  setSpeakers(n) { return this.speakers.call('speakers', { n }); }
  names(names) { return this.speakers.call('names', { names }); }
  // Stopped: both catch up; the speakers' anchors and count.
  async settle() { return (await this.both('settle'))[1]; }
  // What to file with the recording: {offset, analysis: {prep, frames} or null}.
  async save(saved) {
    const { offset, prep } = await this.speakers.call('save', { saved });
    if (!prep) return { offset, analysis: null };
    return { offset, analysis: { prep, frames: await this.voice.call('frames_to_save', { offset }) } };
  }
}
