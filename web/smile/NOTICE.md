# openSMILE for the browser

`smile.wasm` and `smile.mjs` are a WebAssembly build of **openSMILE 3.0.2** by
audEERING GmbH (https://github.com/audeering/opensmile, tag `v3.0.2`), made so
Vocalgraph's browser version measures voices exactly as the desktop app does.

**Licence: non-commercial use only.** openSMILE is licensed under the
audEERING Research License Agreement, included here as
`LICENSE-openSMILE.txt`. This build is distributed under those same terms. It
may not be used for commercial purposes; that needs a licence from audEERING.

## What was changed

Stated as the licence requires:

- **openSMILE's own source is unmodified.** It was compiled with Emscripten
  6.0.10 (`-DSTATIC_LINK=ON`, no PortAudio, FFmpeg, OpenSL ES or OpenCV).
- **New file:** `src/smile_shim.cpp`, a small C interface that runs one config
  on a buffer of 16-bit audio and keeps every output frame, making the same
  SMILEapi calls, in the same order, as the `opensmile` Python package's
  `Smile.process_signal`.
- **Embedded config files:** those of the `opensmile` Python package 2.6.0
  (its `core/config` folder), at `/config` inside the module.
- **Changes made:** 2026-09-30, by Vocalgraph
  (https://github.com/Vocalgraph).

`smile.js` is Vocalgraph's JavaScript wrapper around the module.

## Checked

The desktop app and this build were run on the same 60 s of speech:

- **Frames and timestamps:** the same 5,996 frames, with the same timestamps.
- **Resonance, loudness and breathiness:** identical in every frame.
- **Pitch:** identical in 5,994 frames; the other 2 differ by 0.000004 semitones.

The results were the same in Chrome, Edge and Firefox.

## Rebuilding

`src/build.ps1` links the module. It expects:

- openSMILE built with `emcmake cmake` and `ninja opensmile`;
- the Emscripten SDK;
- the Python package's config folder.

Its paths are those of the machine it was first built on; adjust them before
running it.

Please cite openSMILE as it asks: Florian Eyben, Martin Wöllmer, Björn
Schuller: "openSMILE - The Munich Versatile and Fast Open-Source Audio Feature
Extractor", Proc. ACM Multimedia (MM), ACM, Florence, Italy, pp. 1459-1462,
2010.
