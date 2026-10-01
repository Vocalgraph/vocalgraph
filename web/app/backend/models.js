// The two speaker models in the browser, with ONNX Runtime Web (vendored in
// vendor/onnxruntime-web). Runs in the engine worker. Tested in Chrome, Edge
// and Firefox against the desktop app (identical outputs):
//   * segmentation (who talks when, per 10 s window): on the processor; it
//     is mostly an LSTM, which the graphics-card backend runs no faster, and
//     Firefox's graphics path costs ~100 ms a call;
//   * voiceprints: on the graphics card (WebGPU) in batches of up to 8, which
//     costs Firefox the same as one; on the processor where there's no
//     usable graphics card (with threads when the page is cross-origin isolated).
// The interface is what engine/speakers.js's prepare() takes as `models`.

const ORT = new URL('../vendor/onnxruntime-web/ort.all.bundle.min.mjs', import.meta.url).href;
const MODELS = new URL('../models/', import.meta.url);
const GPU_BATCH = 8;

let loaded = null;

export function loadModels(progress = () => {}) {
  if (loaded) return loaded;
  loaded = (async () => {
    const ort = await import(ORT);
    ort.env.wasm.wasmPaths = new URL('../vendor/onnxruntime-web/', import.meta.url).href;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
    progress('Loading the speaker models');
    const seg = await ort.InferenceSession.create(new URL('segmentation-3.0.onnx', MODELS).href, { executionProviders: ['wasm'] });
    let emb = null, gpu = false;
    if (self.navigator?.gpu) {
      try {
        emb = await ort.InferenceSession.create(new URL('wespeaker-resnet34-LM-masked.onnx', MODELS).href,
                                                { executionProviders: ['webgpu'] });
        gpu = true;
      } catch { emb = null; }
    }
    if (!emb) emb = await ort.InferenceSession.create(new URL('wespeaker-resnet34-LM-masked.onnx', MODELS).href,
                                                      { executionProviders: ['wasm'] });
    const segIn = seg.inputNames[0];

    // crops: Float32Array[] of 160000 samples -> logits (b, 589, 7), one Float32Array.
    async function segment(crops) {
      const b = crops.length, x = new Float32Array(b * 160000);
      crops.forEach((c, i) => x.set(c, i * 160000));
      const out = await seg.run({ [segIn]: new ort.Tensor('float32', x, [b, 1, 160000]) });
      return out[seg.outputNames[0]].data;
    }

    // fbanks: Float32Array[] (frames x 80, all the same frames), weights: Float32Array[] (pooled) -> (b, 256).
    async function embed(fbanks, weights) {
      const n = fbanks.length, out = new Float32Array(n * 256);
      if (!n) return out;
      const frames = fbanks[0].length / 80, pooled = weights[0].length;
      const step = gpu ? GPU_BATCH : 1;
      for (let i = 0; i < n; i += step) {
        const b = Math.min(step, n - i), f = new Float32Array(b * frames * 80), w = new Float32Array(b * pooled);
        for (let k = 0; k < b; k++) { f.set(fbanks[i + k], k * frames * 80); w.set(weights[i + k], k * pooled); }
        const r = await emb.run({ fbank: new ort.Tensor('float32', f, [b, frames, 80]),
                                  weights: new ort.Tensor('float32', w, [b, pooled]) });
        out.set(r.embedding.data, i * 256);
      }
      return out;
    }
    return { segment, embed, backend: gpu ? 'webgpu' : 'wasm', threads: ort.env.wasm.numThreads };
  })();
  return loaded;
}
