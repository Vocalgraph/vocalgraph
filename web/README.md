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

  To let the page start it for you, register its `vocalgraph://` link type
  once, for your Windows user only:

  ```
  uv run python web/helper-prototype/helper.py --register
  ```

  Then the page's **Start the helper** button opens it, with no window. Your
  browser asks first. Started that way, the helper quits after 10 minutes
  unused, and writes its log to `helper.log` beside it. `--unregister`
  removes the link type again.

  The page also asks the helper for its version. It offers the download if
  the helper is missing, suggests updating if a newer one exists, and stops
  only if the helper is too old to work with the page.

The workflow in `.github/workflows/pages.yml` publishes the test page whenever
these files change.
