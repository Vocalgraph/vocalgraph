# PyInstaller spec for "Vocalgraph Helper.app" (macOS 13 or later, one chip
# type per build: Apple Silicon or Intel, whichever Python builds it).
# Build from the repo root (see helper/build-mac.sh):
#   uv run --locked --no-sync pyinstaller --noconfirm --distpath helper/dist --workpath helper/build helper/vocalgraph-helper-mac.spec
# The version comes from VERSION in vocalgraph/helper.py and goes into the
# bundle's Info.plist.
#
# The app isn't signed with a developer certificate: PyInstaller signs it
# ad hoc (as Apple Silicon requires of all code), which macOS's Gatekeeper
# treats as unsigned. See helper/README.md for opening it the first time.
import os
import re

ROOT = os.path.dirname(SPECPATH)            # noqa: F821 (SPECPATH is given by PyInstaller)
SOURCE = os.path.join(ROOT, "vocalgraph", "helper.py")
with open(SOURCE, encoding="utf-8") as fh:
    VERSION = re.search(r'^VERSION = "(\d+\.\d+\.\d+)"', fh.read(), re.M).group(1)

a = Analysis(                                # noqa: F821
    [SOURCE],
    pathex=[ROOT],
    # appaudio loads appaudio_mac on a Mac, which loads these when first used.
    hiddenimports=["vocalgraph.appaudio", "vocalgraph.appaudio_mac", "objc", "Foundation",
                   "ScreenCaptureKit", "CoreMedia", "dispatch"],
    # The rest of the app (opensmile, onnxruntime, scipy, flask) never loads.
    excludes=["scipy", "onnxruntime", "opensmile", "flask", "waitress", "imageio_ffmpeg",
              "tkinter", "_tkinter", "unittest", "pydoc", "pydoc_data", "lib2to3",
              "sqlite3", "xmlrpc", "multiprocessing", "asyncio", "setuptools", "pkg_resources",
              "ssl", "_ssl", "bz2", "_bz2", "lzma", "_lzma", "decimal", "_decimal"],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)                            # noqa: F821

exe = EXE(                                   # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Vocalgraph Helper",
    console=False,
    upx=False,
    # The link's text arrives as an Apple event, which the helper ignores
    # anyway (a link can only start it), so it isn't turned into arguments.
    argv_emulation=False,
)
coll = COLLECT(                              # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="Vocalgraph Helper",
)
app = BUNDLE(                                # noqa: F821
    coll,
    name="Vocalgraph Helper.app",
    bundle_identifier="io.github.vocalgraph.helper",
    version=VERSION,
    info_plist={
        "CFBundleName": "Vocalgraph Helper",
        "CFBundleDisplayName": "Vocalgraph Helper",
        "CFBundleShortVersionString": VERSION,
        "CFBundleVersion": VERSION,
        "NSHumanReadableCopyright": "Vocalgraph",
        # ScreenCaptureKit records apps' sound from macOS 13 on.
        "LSMinimumSystemVersion": "13.0",
        # It has no windows: no Dock icon, no menu bar, never "not responding".
        "LSBackgroundOnly": True,
        # The vocalgraph:// link, registered by macOS when the app is first
        # opened (or copied into Applications).
        "CFBundleURLTypes": [{
            "CFBundleURLName": "io.github.vocalgraph.helper",
            "CFBundleURLSchemes": ["vocalgraph"],
        }],
    },
)
