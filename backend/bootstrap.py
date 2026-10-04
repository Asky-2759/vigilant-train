r"""Locate the native dependencies OpenPronounce needs, before anything imports it.

``phonemizer`` loads ``libespeak-ng`` through ctypes and, on Windows, has no way to
find it on its own: the espeak-ng installer puts the DLL in ``C:\Program Files\eSpeak NG``
and adds nothing to ``PATH``. :func:`configure` finds the library, exports the
variables phonemizer reads, and reports what is missing -- it must run *before* the
first ``import openpronounce`` (see :mod:`backend.app`).
"""

import os
import shutil
import sys
from pathlib import Path

#: Where the espeak-ng installers put the shared library, most-specific first.
_ESPEAK_LIBRARY_CANDIDATES = (
    # Windows (winget / MSI installer)
    r"C:\Program Files\eSpeak NG\libespeak-ng.dll",
    r"C:\Program Files (x86)\eSpeak NG\libespeak-ng.dll",
    # macOS (homebrew)
    "/opt/homebrew/lib/libespeak-ng.dylib",
    "/usr/local/lib/libespeak-ng.dylib",
    # Linux (apt/dnf)
    "/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1",
    "/usr/lib/aarch64-linux-gnu/libespeak-ng.so.1",
    "/usr/lib64/libespeak-ng.so.1",
    "/usr/lib/libespeak-ng.so.1",
)


def find_espeak_library():
    """Return the path of ``libespeak-ng`` or ``None``.

    ``PHONEMIZER_ESPEAK_LIBRARY`` wins when it points at a real file, then the
    per-platform install locations, then the directory of the ``espeak-ng``
    executable (a portable install or a non-default prefix).
    """
    configured = os.environ.get("PHONEMIZER_ESPEAK_LIBRARY")
    if configured and Path(configured).is_file():
        return Path(configured)

    for candidate in _ESPEAK_LIBRARY_CANDIDATES:
        path = Path(candidate)
        if path.is_file():
            return path

    executable = shutil.which("espeak-ng") or shutil.which("espeak")
    if executable:
        folder = Path(executable).resolve().parent
        suffixes = (".dll",) if sys.platform == "win32" else (".dylib", ".so.1", ".so")
        # The library sits next to the binary (Windows) or one level up in lib/ (unix).
        for parent in (folder, folder.parent / "lib", folder.parent):
            for suffix in suffixes:
                match = parent / f"libespeak-ng{suffix}"
                if match.is_file():
                    return match
    return None


def configure():
    """Export the espeak variables phonemizer needs and return a report of the native deps.

    The returned dict has an ``ok`` flag plus, for each dependency, either its
    resolved path or the command that installs it -- :mod:`backend.app` serves it
    from ``/api/health`` so the UI can tell the user exactly what to install
    instead of failing with a ctypes error on the first analysis.
    """
    report = {"espeak": None, "ffmpeg": None, "missing": [], "hints": {}}

    library = find_espeak_library()
    if library is not None:
        os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = str(library)
        # espeak looks for its dictionaries next to the library; the Windows
        # installer keeps them in espeak-ng-data/ inside the install folder.
        data = library.parent / "espeak-ng-data"
        if data.is_dir():
            os.environ.setdefault("ESPEAK_DATA_PATH", str(library.parent))
        if sys.platform == "win32":
            # Let the loader resolve the DLL's own dependencies from its folder.
            os.add_dll_directory(str(library.parent))
            os.environ["PATH"] = f"{library.parent}{os.pathsep}{os.environ.get('PATH', '')}"
        report["espeak"] = str(library)
    else:
        report["missing"].append("espeak-ng")
        report["hints"]["espeak-ng"] = _install_hint("espeak-ng")

    ffmpeg = find_ffmpeg()
    if ffmpeg:
        report["ffmpeg"] = ffmpeg
        os.environ["PATH"] = f"{Path(ffmpeg).parent}{os.pathsep}{os.environ.get('PATH', '')}"
    else:
        report["missing"].append("ffmpeg")
        report["hints"]["ffmpeg"] = _install_hint("ffmpeg")

    report["ok"] = not report["missing"]
    return report


def find_ffmpeg():
    """Find an existing winget install even when this terminal has a stale PATH."""
    configured = os.environ.get("FFMPEG_BINARY")
    if configured and Path(configured).is_file():
        return str(Path(configured).resolve())
    found = shutil.which("ffmpeg")
    if found:
        return found
    local = os.environ.get("LOCALAPPDATA")
    if sys.platform == "win32" and local:
        packages = Path(local) / "Microsoft" / "WinGet" / "Packages"
        matches = sorted(packages.glob("Gyan.FFmpeg_*/ffmpeg-*/bin/ffmpeg.exe"))
        if matches:
            return str(matches[-1])
    return None


def _install_hint(package):
    if sys.platform == "win32":
        ids = {"espeak-ng": "eSpeak-NG.eSpeak-NG", "ffmpeg": "Gyan.FFmpeg"}
        return f"winget install --id {ids[package]} --exact"
    if sys.platform == "darwin":
        return f"brew install {package}"
    return f"sudo apt install {package}"
