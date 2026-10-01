// ffmpeg.js - run the FFmpeg 7.1 CLI (WebAssembly build, see NOTICE.md) on
// in-memory files, with ffmpeg-style arguments.
//
//   import { loadFFmpeg } from './ffmpeg/ffmpeg.js';
//   const ff = await loadFFmpeg();
//   const { code, stderr, files } = await ff.run(
//       ['-i', 'in.m4a', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'out.f32'],
//       { inputs: { 'in.m4a': bytes }, outputs: ['out.f32'] });
//   const pcm = await ff.decode16k(bytes, 'in.m4a', 0);   // Float32Array
//
// The build is multi-threaded: it needs SharedArrayBuffer, i.e. a
// cross-origin isolated page (COOP same-origin + COEP require-corp), and is
// meant to be loaded in a dedicated (module) worker; FFmpeg's threads are
// nested workers. In Node it uses worker_threads.
//
// One module instance serves every command: ffmpeg's main() runs on a
// pthread (so this thread is never blocked) and resets its globals at the
// start of each run; each run gets its own directory in the in-memory file
// system, deleted afterwards. Runs are queued, one at a time. If a run
// crashes the module (abort), the next run starts a new instance.

import createFFmpeg from './ffmpeg.mjs';

const RATE = 16000;
const MIN_POOL = 8;

function rmTree(FS, path) {
  for (const name of FS.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const p = `${path}/${name}`;
    if (FS.isDir(FS.stat(p).mode)) rmTree(FS, p); else FS.unlink(p);
  }
  FS.rmdir(path);
}

/** Threads a command needs: main + per input (demuxer, decoders) + filters, encoders, muxers. */
function threadsFor(args) {
  const nIn = args.filter((a) => a === '-i').length;
  return 4 + 3 * Math.max(1, nIn);
}

/**
 * Load the module. Options: wasmUrl (default: ffmpeg.wasm beside ffmpeg.mjs),
 * wasmBinary (bytes, instead of fetching), onStderr (line callback, all runs).
 */
export async function loadFFmpeg(options = {}) {
  let mod = null;
  let sink = null;              // collects the current run's output
  let pending = null;           // { id, resolve, reject } of the current run
  let nextId = 1;
  let queue = Promise.resolve();

  async function instantiate() {
    const m = await createFFmpeg({
      ...(options.wasmUrl && {
        locateFile: (p, prefix) => (p.endsWith('.wasm') ? String(options.wasmUrl) : prefix + p),
      }),
      ...(options.wasmBinary && { wasmBinary: options.wasmBinary }),
      print: (line) => sink?.stdout.push(line),
      printErr: (line) => {
        sink?.stderr.push(line);
        (sink?.onStderr ?? options.onStderr)?.(line);
      },
      onAbort: (what) => {
        mod = null;
        pending?.reject(new Error(`ffmpeg.wasm aborted: ${what}`));
      },
    });
    m.vgDone = (id, code) => { if (pending?.id === id) pending.resolve(code); };
    m.FS.mkdir('/work');
    return m;
  }
  mod = await instantiate();

  async function runNow(args, { inputs = {}, outputs = [], onStderr } = {}) {
    if (!mod) mod = await instantiate();
    const m = mod;
    const { FS } = m;
    const id = nextId++;
    const dir = `/work/r${id}`;
    sink = { stdout: [], stderr: [], onStderr };
    const ptrs = [];
    try {
      FS.mkdir(dir);
      FS.chdir(dir);
      for (const [name, data] of Object.entries(inputs)) {
        const sub = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
        if (sub) FS.mkdirTree(sub);
        FS.writeFile(name, data instanceof Uint8Array ? data : new Uint8Array(data));
      }
      await m.vgGrowPool(Math.max(MIN_POOL, threadsFor(args)) - m.vgPool().running);

      // -nostdin: there is no terminal; reading stdin would block (or prompt).
      const argv = ['ffmpeg', '-nostdin', ...args.map(String)];
      for (const a of argv) ptrs.push(m.stringToNewUTF8(a));
      const argvPtr = m._malloc(4 * (argv.length + 1));
      ptrs.push(argvPtr);
      ptrs.forEach((p, i) => i < argv.length && m.setValue(argvPtr + 4 * i, p, '*'));
      m.setValue(argvPtr + 4 * argv.length, 0, '*');

      let code;
      // Node unrefs idle pool workers; keep the event loop alive until the
      // run reports back (harmless in browsers).
      const keepAlive = setInterval(() => {}, 1000);
      try {
        code = await new Promise((resolve, reject) => {
          pending = { id, resolve, reject };
          const err = m._vg_run_async(argv.length, argvPtr, id);
          if (err) reject(new Error(`could not start ffmpeg (errno ${err})`));
        });
      } catch (e) {
        code = -1;
        sink.stderr.push(String(e && e.message ? e.message : e));
      } finally {
        pending = null;
        clearInterval(keepAlive);
      }

      const files = {};
      if (mod === m) {
        for (const name of outputs) {
          try { files[name] = FS.readFile(name); } catch { /* not written */ }
        }
      }
      return { code, stderr: sink.stderr.join('\n'), stdout: sink.stdout.join('\n'), files };
    } finally {
      sink = null;
      if (mod === m) {
        for (const p of ptrs) m._free(p);
        FS.chdir('/work');
        try { rmTree(FS, dir); } catch { /* already gone */ }
      }
    }
  }

  const ff = {
    /**
     * Run one ffmpeg command (args as for the ffmpeg CLI, without "ffmpeg").
     * inputs: { name: Uint8Array } written before the run; outputs: names
     * read back after it. Resolves to { code, stderr, stdout, files };
     * code is main()'s return value (0 = success, negative AVERROR or 1 on
     * failure).
     */
    run(args, opts) {
      const p = queue.then(() => runNow(args, opts));
      queue = p.catch(() => {});
      return p;
    },

    /**
     * The desktop app's decode (vocalgraph/core.py `decode`): audio stream
     * `stream` as 16 kHz mono float32, channels averaged
     * (-rematrix_maxval 1). `duration` (seconds) limits it like core.decode.
     */
    async decode16k(bytes, name = 'input', stream = 0, duration = null) {
      const inName = 'in_' + String(name).split(/[\\/]/).pop().replace(/[^\w.-]/g, '_');
      const limit = duration ? ['-t', Number(duration).toFixed(3)] : [];
      const { code, stderr, files } = await ff.run(
        ['-v', 'error', '-i', inName, '-map', `0:a:${stream}`, ...limit,
         '-ac', '1', '-rematrix_maxval', '1', '-ar', String(RATE), '-f', 'f32le', 'out.f32'],
        { inputs: { [inName]: bytes }, outputs: ['out.f32'] });
      const out = files['out.f32'];
      if (code !== 0 || !out || !out.length) {
        throw new Error('Could not read audio from this file. ' + stderr.trim().slice(-300));
      }
      return new Float32Array(out.buffer, out.byteOffset, out.byteLength >> 2);
    },

    /** Worker pool size: { unused, running }. */
    pool: () => (mod ? mod.vgPool() : { unused: 0, running: 0 }),
  };
  return ff;
}

let shared;
/** decode16k on a shared, lazily loaded instance. */
export async function decode16k(bytes, name, stream = 0, duration = null) {
  shared ??= loadFFmpeg();
  return (await shared).decode16k(bytes, name, stream, duration);
}

export default loadFFmpeg;
