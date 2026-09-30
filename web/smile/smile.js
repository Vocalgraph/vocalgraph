// openSMILE in the browser (WebAssembly build of openSMILE 3.0.2; audEERING
// Research License, non-commercial use only). Runs eGeMAPSv02 low-level
// descriptors exactly as the opensmile Python package's
// Smile(feature_set=eGeMAPSv02, feature_level=LowLevelDescriptors).process_signal.
import createSmile from './smile.mjs';

const ROOT = '/config';
const OPTIONS = (rate) => ({
  source: `${ROOT}/shared/standard_external_wave_input.conf.inc`,
  sampleRate: String(rate),
  nBits: '16',
  sink: `${ROOT}/shared/standard_external_data_output_single.conf.inc`,
  sinkLevel: 'lld',
  bufferModeRbConf: `${ROOT}/shared/BufferModeRb.conf.inc`,
  frameModeFunctionalsConf: `${ROOT}/shared/FrameModeFunctionals.conf.inc`,
});

export async function loadSmile(moduleOptions = {}) {
  const M = await createSmile(moduleOptions);
  const str = (s) => { const n = M.lengthBytesUTF8(s) + 1, p = M._malloc(n); M.stringToUTF8(s, p, n); return p; };

  // pcm: Int16Array of mono audio at `rate` Hz. Returns {names, starts, ends, values, width, frames}.
  function process(pcm, rate = 16000) {
    const opts = Object.entries(OPTIONS(rate));
    const keep = [];
    const names = M._malloc(4 * opts.length), vals = M._malloc(4 * opts.length);
    opts.forEach(([k, v], i) => { const a = str(k), b = str(v); keep.push(a, b); M.HEAP32[(names >> 2) + i] = a; M.HEAP32[(vals >> 2) + i] = b; });
    const config = str(`${ROOT}/egemaps/v02/eGeMAPSv02.conf`); keep.push(config, names, vals);
    const p = M._malloc(pcm.length * 2); keep.push(p);
    M.HEAP16.set(pcm, p >> 1);
    try {
      const frames = M._st_process(config, opts.length, names, vals, p, pcm.length, 0);
      if (frames < 0) throw new Error('openSMILE: ' + M.UTF8ToString(M._st_error()));
      const width = M._st_width();
      const cols = Array.from({ length: M._st_num_names() }, (_, i) => M.UTF8ToString(M._st_name(i)));
      return {
        frames, width, names: cols,
        values: M.HEAPF32.slice(M._st_values() >> 2, (M._st_values() >> 2) + frames * width),
        starts: M.HEAPF64.slice(M._st_starts() >> 3, (M._st_starts() >> 3) + frames),
        ends: M.HEAPF64.slice(M._st_ends() >> 3, (M._st_ends() >> 3) + frames),
      };
    } finally { for (const q of keep) M._free(q); }
  }
  return { process };
}
