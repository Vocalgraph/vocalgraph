# The browser version

Vocalgraph's browser version, published at https://vocalgraph.github.io/vocalgraph/
by `.github/workflows/pages.yml`. It is the desktop app, running in the
browser: the same pages (`vocalgraph/static/`), with the server replaced by a
backend in the page, and every analysis step a port of the Python, checked
against it.

## How it fits together

- **`app/sw.js`** (service worker): the pages ask for `/api/...` as they do
  from the desktop app's server; the service worker hands those requests
  (fetches, audio players, downloads, uploads) to the backend. It also:
  - serves each published version's files from that version's cache, and
    holds a new version back until the page's **Update now**;
  - adds cross-origin isolation (for multi-threaded WebAssembly) and a content
    security policy: pages and workers load only the site's own files and talk
    only to the site and the helper on `127.0.0.1:8766`.
- **`app/static/boot.js`**: replaces the desktop's one-line `boot.js`; puts the
  page under the service worker and starts the backend.
- **`app/backend/`**: the backend, in a worker:
  - `worker.js`: the routes of `vocalgraph/server.py`;
  - `jobs.js`: its library and pipeline;
  - `store.js`: the library, in IndexedDB;
  - `models.js`: the speaker models in ONNX Runtime Web; segmentation on the
    processor, voiceprints batched on the graphics card (WebGPU) or on
    processor threads;
  - `live.js`, `session.js`, `inputs.js`: Live (`vocalgraph/live.py`):
    - microphones come in through an AudioWorklet (`page.js`,
      `capture-worklet.js`), and programs' sound from the helper;
    - the inputs are kept in step, and recorded to the browser's private
      file storage as they come.
- **`engine/`**: ports of the Python analysis (`analysis.js`, `timeline.js`,
  `speakers.js` + `linkage.js`, `sources.js`, `voice.js`, `measure.js`), tied
  together by `index.js`; `ffmpeg-ops.js` runs the desktop's FFmpeg commands.
- **`ffmpeg/`**: FFmpeg 7.1 (the desktop app's version), audio-only and LGPL,
  with LAME, compiled to multi-threaded WebAssembly.
- **`smile/`**: openSMILE 3.0.2 compiled to WebAssembly. Non-commercial use
  only.
- **`tools/assemble.mjs`**: puts the site together from the repository.
  Third-party files come from `package-lock.json` (`npm ci`), not from a CDN.

## Checked against the desktop app

Same file, same results, in Edge and Firefox:

- **Silence analysis, speaker grouping and per-input tracks:** identical on
  every recording tested. That includes a two-person call recorded from a
  microphone and Discord: identical turns, talk times and tracks.
- **Voice measures:** identical, apart from the last digits of a handful of
  pitch frames.
- **Decoding:** bit-identical for WAV; for MP3 and AAC it differs only in
  FFmpeg's last-digit rounding, which doesn't reach the results.

The parity tests are in `engine/test/`, `ffmpeg/test/` and `smile/`. They
need reference outputs made by the desktop app from your own recordings, and
those references stay outside the repository.

## Build and try it locally

```
npm ci --prefix web
node web/tools/assemble.mjs _site
```

Then serve `_site` on `http://127.0.0.1:<port>/` (any static server) and open
it. A service worker needs `localhost`/`127.0.0.1` or https.

## Other folders

- **`helper-prototype/`**: the first helper, used by the early test page; the
  real one is `vocalgraph/helper.py`, packaged in `helper/`.
- **`pages-test/`**: the early test page, published at `test/`.
