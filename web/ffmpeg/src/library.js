// --js-library for ffmpeg.mjs: wasm_entry.c's completion callback. Proxied
// asynchronously, so it runs on the main runtime thread (where ffmpeg.js
// waits for it) without blocking the thread that calls it.
addToLibrary({
  vg_done__proxy: 'async',
  vg_done: (id, code) => { Module['vgDone']?.(id, code); },
});
