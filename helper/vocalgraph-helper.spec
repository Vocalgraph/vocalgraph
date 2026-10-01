# PyInstaller spec for "Vocalgraph Helper.exe" (Windows, one folder, no console).
# Build from the repo root (see helper/build.ps1):
#   uv run --group helper pyinstaller --noconfirm --distpath helper/dist --workpath helper/build helper/vocalgraph-helper.spec
# The version comes from VERSION in vocalgraph/helper.py and is written into
# the exe's file properties, where the installer script reads it back.
import os
import re

from PyInstaller.utils.win32.versioninfo import (FixedFileInfo, StringFileInfo, StringStruct, StringTable,
                                                 VarFileInfo, VarStruct, VSVersionInfo)

ROOT = os.path.dirname(SPECPATH)            # noqa: F821 (SPECPATH is given by PyInstaller)
SOURCE = os.path.join(ROOT, "vocalgraph", "helper.py")
with open(SOURCE, encoding="utf-8") as fh:
    VERSION = re.search(r'^VERSION = "(\d+)\.(\d+)\.(\d+)"', fh.read(), re.M)
NUMBERS = tuple(int(n) for n in VERSION.groups()) + (0,)
TEXT = ".".join(VERSION.groups())

version_info = VSVersionInfo(
    ffi=FixedFileInfo(filevers=NUMBERS, prodvers=NUMBERS),
    kids=[
        StringFileInfo([StringTable("040904B0", [
            StringStruct("CompanyName", "Vocalgraph"),
            StringStruct("FileDescription", "Vocalgraph Helper"),
            StringStruct("FileVersion", TEXT),
            StringStruct("InternalName", "Vocalgraph Helper"),
            StringStruct("LegalCopyright", "Vocalgraph"),
            StringStruct("OriginalFilename", "Vocalgraph Helper.exe"),
            StringStruct("ProductName", "Vocalgraph Helper"),
            StringStruct("ProductVersion", TEXT),
        ])]),
        VarFileInfo([VarStruct("Translation", [1033, 1200])]),
    ],
)

a = Analysis(                                # noqa: F821
    [SOURCE],
    pathex=[ROOT],
    hiddenimports=["vocalgraph.appaudio"],
    # The helper needs only the standard library and vocalgraph.appaudio
    # (ctypes). appaudio_mac (and numpy, which only it uses) are Mac only;
    # the rest of the app (opensmile, onnxruntime, scipy, flask) never loads.
    excludes=["vocalgraph.appaudio_mac", "numpy", "scipy", "onnxruntime", "opensmile", "flask", "waitress",
              "imageio_ffmpeg", "tkinter", "_tkinter", "unittest", "pydoc", "pydoc_data", "lib2to3",
              "sqlite3", "xmlrpc", "multiprocessing", "asyncio", "setuptools", "pkg_resources",
              # Nor TLS or OpenSSL (hashlib falls back to its built-in SHA-1), nor compression.
              "ssl", "_ssl", "_hashlib", "bz2", "_bz2", "lzma", "_lzma", "decimal", "_decimal"],
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
    console=False,                           # no window: it runs in the background, logging to a file
    upx=False,                               # packed exes look suspicious to antivirus software
    version=version_info,
)
coll = COLLECT(                              # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="Vocalgraph Helper",
)
