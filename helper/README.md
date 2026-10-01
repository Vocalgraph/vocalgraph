# Vocalgraph Helper

A small program for Windows and macOS that lets the Vocalgraph web page
(<https://vocalgraph.github.io/vocalgraph/>) record one desktop program's
sound: a call, a game, a browser tab's player. A web page can't reach another
program's audio, so the helper does it and streams the sound to the page, on
this computer only.

The code is [`vocalgraph/helper.py`](../vocalgraph/helper.py); it captures
through [`vocalgraph/appaudio.py`](../vocalgraph/appaudio.py) (Windows 10
version 2004 or later: process loopback). This folder packages it:

| File | What it is |
|---|---|
| `vocalgraph-helper.spec` | PyInstaller: `Vocalgraph Helper.exe`, one folder, no console window |
| `installer.iss` | Inno Setup: the per-user installer |
| `build.ps1` | builds both, with a SHA-256 file for the installer |
| `innosetup.version` | the Inno Setup version builds are tested with |
| `vocalgraph-helper-mac.spec` | PyInstaller: `Vocalgraph Helper.app` for macOS (see [Mac](#mac)) |
| `build-mac.sh` | builds the app and its disk image, with a SHA-256 file |
| `smoke-mac.sh` | the Mac build's test in the workflow |

## Install and uninstall

Run `VocalgraphHelperSetup-<version>.exe` from the
[releases](https://github.com/Vocalgraph/vocalgraph/releases). It installs
for your Windows user only, with no administrator rights, to
`%LOCALAPPDATA%\Programs\Vocalgraph Helper`, and registers the `vocalgraph://`
link so the page's **Start the helper** button can open it (your browser asks
first). A Start menu entry is optional. When it finishes, the installer
starts the helper, so the page that offered the download finds it.

**It isn't code-signed**, so Windows SmartScreen warns before it runs:
"Windows protected your PC ... Unknown publisher". Choose **More info**, check
the file is `VocalgraphHelperSetup-<version>.exe`, then **Run anyway**. Your
browser may also call it "not commonly downloaded" and ask you to keep it.
You can check the download against the `.sha256` file published beside it:

```
certutil -hashfile VocalgraphHelperSetup-<version>.exe SHA256
```

To uninstall: Settings > Apps > Installed apps > **Vocalgraph Helper** >
Uninstall. That stops the helper if it's running, removes the program, the
`vocalgraph://` link and its log. Installing a newer version stops the running
one and replaces it.

## Running it

Nothing to do: the page starts it through the link. It runs without a
window, and:

- quits after 10 minutes unused (never while recording);
- writes its log to `%LOCALAPPDATA%\Vocalgraph Helper\helper.log` (at most
  about 1 MB, plus one older file);
- `"Vocalgraph Helper.exe" --quit` stops it, `--version` prints its version.

From the repo, for development (with a console and the log on screen):

```
uv run python -m vocalgraph.helper --origin http://localhost:8790
```

`--origin` allows another page address (a local test page); `--idle-minutes`
changes the idle time (0: never). `--install-link` / `--uninstall-link` point
`vocalgraph://` at this copy (the exe when packaged, otherwise `pythonw` and
this file) or remove it. The installer writes the same registry key itself.

## Security model

The helper opens a local port that web pages can reach, so it only does what
the Vocalgraph page needs, and only for that page:

- **Origin allowlist.** Every request (including the WebSocket and CORS
  preflights) must carry `Origin: https://vocalgraph.github.io`;
  anything else, or none, gets `403`. Browsers set `Origin` themselves, so
  another site can't pretend to be the page. `--origin` adds addresses for
  development only; the installed link never passes it.
- **Loopback only.** It listens on `127.0.0.1:8766`, never on the network, so
  other computers can't reach it.
- **Exclusive port.** It holds the port with `SO_EXCLUSIVEADDRUSE`, so no
  other program can listen on the same port beside it and receive the page's
  requests, and a second copy of the helper can't start.
- **The link's text is ignored.** `vocalgraph://anything` only starts the
  helper; nothing after `vocalgraph://` is read or acted on, so a link on any
  site can do no more than start it, and the origin check still decides who
  may use it.
- **Idle quit.** It isn't left listening all day: it quits after 10 minutes
  without a request, unless a recording is running.
- **Small surface.** Three read-only endpoints (`/version`, `/apps`, and the
  `/capture` WebSocket for one named program); nothing is written or saved
  except the log. `--quit` uses a Windows named event in your own logon
  session, which web pages and other users can't reach.
- **Per-user.** No administrator rights, no service, nothing for other users
  of the computer; the link is registered under `HKEY_CURRENT_USER` only.

## Building

Windows, with [uv](https://docs.astral.sh/uv/) on PATH (or in `$env:UV`). From
the repo root:

```
powershell -ExecutionPolicy Bypass -File helper\build.ps1
```

This adds PyInstaller (the `helper` dependency group, pinned in `uv.lock`) to
`.venv` and builds `helper\dist\Vocalgraph Helper\`. A normal `uv sync` never
installs the group (only `dev` is installed by default) and removes it again.
If Inno Setup (the version in `innosetup.version`) is installed, it also builds
`helper\Output\VocalgraphHelperSetup-<version>.exe` and its `.sha256`;
`-RequireInstaller` makes a missing Inno Setup an error.

The bundle has only the standard library and `vocalgraph.appaudio` (ctypes);
numpy, scipy, onnxruntime, opensmile and flask are excluded, as are TLS and
compression modules the helper never uses. The version is set once, as
`VERSION` in `vocalgraph/helper.py`: the spec writes it into the exe's file
properties and the installer reads it from there.

Releases are built by [`.github/workflows/helper.yml`](../.github/workflows/helper.yml):
push a tag `helper-v<VERSION>` (it must match `VERSION`) and it builds,
smoke-tests the exe (`/version` from the page's origin and from another, then
`--quit`) and publishes the installer and its SHA-256 file as a GitHub
Release. Running it by hand (workflow_dispatch) builds and uploads them as
workflow artifacts only.

## Mac

macOS 13 (Ventura) or later. It records through Apple's ScreenCaptureKit
([`vocalgraph/appaudio_mac.py`](../vocalgraph/appaudio_mac.py)). There are two
downloads: `VocalgraphHelper-<version>-mac-apple-silicon.dmg` for M1 and later,
and `-mac-intel.dmg` for Intel Macs. The page picks the right one where the
browser says which chip the Mac has, and offers the other beside it.

### Install

1. Open the `.dmg` and drag **Vocalgraph Helper** into **Applications**.
2. **It isn't signed by Apple**, so macOS refuses to open it the first time.
   Open it from Applications and choose **Done**. Then go to System Settings >
   Privacy & Security, scroll down to "Vocalgraph Helper was blocked" and
   choose **Open Anyway**, then **Open Anyway** again. macOS remembers this
   for that copy. Opening it also registers the `vocalgraph://` link.
3. The first time the page lists apps, macOS asks to let Vocalgraph Helper
   record the screen and audio. ScreenCaptureKit records an app's sound as
   part of a screen recording, so this is the permission it needs, but only
   the sound is used: the video it has to take along is 2×2 pixels, once a
   second, and is thrown away. Allow it in System Settings > Privacy &
   Security > Screen & System Audio Recording.
   - macOS gives a permission only to programs started after it's given, so
     the helper quits when it finds it's missing. Reload the page and press
     **Start the helper** once it's allowed.
4. Each new version is a new unsigned program to macOS. After an update,
   steps 2 and 3 may be needed again.

Recent macOS versions also ask again now and then whether to keep allowing
apps that record the screen.

### Running it

The app has no window, Dock icon or menu. Like the Windows version it quits
after 10 minutes unused. Its log is `~/Library/Logs/Vocalgraph Helper/helper.log`.
To stop it:

```
"/Applications/Vocalgraph Helper.app/Contents/MacOS/Vocalgraph Helper" --quit
```

Or use Activity Monitor. To uninstall, move the app to the Bin and delete the
log folder. The link is declared in the app's `Info.plist`, so it goes with
the app. `--quit` uses a pid file in the log folder, readable only by you,
and `SIGTERM`.

### Building

On a Mac with [uv](https://docs.astral.sh/uv/) on PATH (or in `$UV`), from the
repo root:

```
bash helper/build-mac.sh
```

This builds `helper/dist/Vocalgraph Helper.app` with PyInstaller
(`vocalgraph-helper-mac.spec`). The bundle contains the standard library,
numpy and PyObjC's ScreenCaptureKit, CoreMedia and libdispatch bindings, all
from the `helper` dependency group in `uv.lock`. It then builds
`helper/Output/VocalgraphHelper-<version>-mac-<chip>.dmg` and its `.sha256`.
The chip is that of the Python running the build; the workflow builds one on
an Apple Silicon runner and one on an Intel runner. `smoke-mac.sh` is the
workflow's test: it copies the app out of the disk image, starts it by its
link, checks `/version`, the origin checks, `/apps` and `--quit`.
