// AudioWorklet: a microphone's sound, straight to the backend worker. Runs on
// the browser's audio thread; the page connects it to a microphone and gives
// it a port to the worker. It sends the samples as they come, about every
// 20 ms, interleaved float32 at the context's rate (48 kHz), with the audio
// clock's time of the first sample, so the worker can keep inputs in step.
class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.id = options.processorOptions.id;
    this.channels = options.processorOptions.channels || 1;
    this.chunk = Math.round(sampleRate * 0.02);
    this.buf = new Float32Array(this.chunk * this.channels);
    this.n = 0;
    this.t0 = null;
    this.out = null;
    this.port.onmessage = (e) => { if (e.data?.port) this.out = e.data.port; if (e.data?.stop) this.stopped = true; };
  }

  process(inputs) {
    if (this.stopped) return false;
    const inp = inputs[0];
    if (!inp || !inp.length || !this.out) return true;
    const frames = inp[0].length, ch = this.channels;
    for (let i = 0; i < frames; i++) {
      if (this.n === 0) this.t0 = currentTime + i / sampleRate;
      for (let c = 0; c < ch; c++) this.buf[this.n * ch + c] = (inp[c] || inp[0])[i];
      if (++this.n === this.chunk) {
        const data = this.buf;
        this.out.postMessage({ kind: 'pcm', id: this.id, t: this.t0, rate: sampleRate, channels: ch, data }, [data.buffer]);
        this.buf = new Float32Array(this.chunk * ch);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('vocalgraph-capture', Capture);
