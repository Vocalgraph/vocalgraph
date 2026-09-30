# Browser version: groundwork

Vocalgraph is getting a version that runs in the browser, hosted on GitHub
Pages, with a small helper program on your computer for recording one
program's sound. This folder holds the pieces tested so far.

- **`smile/`**: openSMILE 3.0.2 compiled to WebAssembly, giving the same voice
  measurements as the desktop app. Non-commercial use only; see
  `smile/NOTICE.md` and `smile/LICENSE-openSMILE.txt`.
- **`pages-test/`**: a test page, published at
  https://vocalgraph.github.io/vocalgraph/. It checks three things: that
  the page can reach the local helper, that openSMILE matches the desktop app,
  and that the speaker models do too.
- **`helper-prototype/helper.py`**: the helper prototype (Windows). Run it
  before opening the test page:

  ```
  uv run python web/helper-prototype/helper.py
  ```

  It only answers the test page's address. Results the page sends it are
  saved beside it in `results.jsonl`, which isn't committed.

The workflow in `.github/workflows/pages.yml` publishes the test page whenever
these files change.
