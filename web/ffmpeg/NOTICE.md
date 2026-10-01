# FFmpeg 7.1 for the browser version

`ffmpeg.mjs` + `ffmpeg.wasm` are the FFmpeg 7.1 `ffmpeg` command-line program
compiled to WebAssembly with Emscripten 6.0.10, audio only, LGPL only, with
LAME 3.100 for MP3. `ffmpeg.js` runs it with ffmpeg-style arguments on
in-memory files; `decode16k()` is the desktop app's decode command
(`vocalgraph/core.py` `decode`). Licence and source: `LICENSE-FFmpeg.md`.
Rebuild: `bash web/ffmpeg/src/build.sh` (Git Bash; paths and versions at its
top).

## Multi-threaded: needs cross-origin isolation

The build uses wasm threads (`-pthread`, SharedArrayBuffer). It only loads on
a cross-origin isolated page (COOP `same-origin` + COEP `require-corp`, which
the site's service worker adds) and is meant to run inside a dedicated module
worker; FFmpeg's threads are nested workers. In Node it uses worker_threads.

- One instance serves every command. `main()` runs on its own pthread
  (`src/wasm_entry.c`), so the calling worker is never blocked, and resets the
  CLI's globals and the library settings that options change at the start of
  each run (`src/ffmpeg-7.1-wasm.patch`). Each run gets its own directory in
  the in-memory file system, deleted afterwards. Runs are queued.
- Each FFmpeg 7 pipeline stage is a thread: a plain decode uses 6 (main,
  demuxer, decoder, filtergraph, encoder, muxer). The pool starts with 8
  workers; before a run `ffmpeg.js` grows it to 4 + 3 per input, and workers
  are kept for later commands. A concat of N inputs needs about 2N + 4
  workers. Codec/filter-internal threads are off (`av_cpu_force_count(1)`):
  they would each take a worker and do not change the output.
- If a run aborts the module, the next run starts a fresh instance.

## Parity with the desktop app (FFmpeg 7.1, imageio-ffmpeg 0.6.0)

Measured on 2026-09-30 by `test/parity.mjs` against references from
`test/make_refs.py` (the desktop's own `core.decode` / `core.render`), on three
recordings from the library (16 kHz mono f32 output unless noted):

| Input | Same length | Bit-identical | Max abs diff | RMS diff re signal |
|---|---|---|---|---|
| WAV (s16, 74.5 s) | yes | 100% | 0 | — |
| MP3 (48 kHz stereo, 48 min) | yes | 7.6% | 6.0e-7 | −124 dB |
| M4A AAC stream 0 (44.1 kHz) | yes | 32.7% | 4.8e-7 | −140 dB |
| M4A AAC stream 2 (48 kHz) | yes | 22.9% | 2.4e-7 | −140 dB |

The differences are float rounding, a few units in the last place: the
desktop binary uses x86 SIMD (SSE/AVX/FMA) for the MDCT/FFT, float DSP and the
resampler, which adds in a different order than FFmpeg's C code used here
(wasm has no x86 assembly). Integer paths (the WAV decode) match exactly. The
largest difference, 6e-7, is about −124 dBFS, far below anything the analysis
can see.

Cutting (core.render's atrim/asetpts/concat into FLAC, 4 segments, 66.6 s, on
the M4A): the FLAC part has the same length and is 98.5% bit-identical at its
own rate (max diff 2.4e-7, from the AAC decode above). The finished files
differ more, from the encoders: fed the *same* FLAC part, desktop and wasm
LAME give 98% identical decoded samples (max 4e-3), and FFmpeg's AAC encoder
makes different quantisation choices (SIMD on desktop; max 0.12, −32 dB).
Both outputs play: the desktop FFmpeg decodes the wasm MP3, M4A and FLAC with
no errors, and they have the same duration as the desktop's.

20 commands in a row on one instance (decodes, an MP3 encode with `-y -v
warning -ss -t`, an AAC encode with `-af volume`, interleaved) gave identical
output every time. Per-command overhead (a command with 10 ms of audio):
median 1.7 ms. Loading the module: 33 ms in Node (pool of 8 included).

Speed in Node 24 (one machine, 24 cores): decode to 16 kHz 560–1600x
real time (48-min MP3 in 3.2 s); MP3 encode (libmp3lame, 192k) 95 s of audio
per second; M4A encode (aac, 192k) 34 s/s.

Size: `ffmpeg.wasm` 2,653,984 bytes (1,204,914 gzip -9), `ffmpeg.mjs` 90,836
bytes.

Not supported: `-stream_loop` is untested, and there is no network, no video
(no swscale), no stdin/stdout piping (use files).
