import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from backend import bootstrap


class BootstrapTests(unittest.TestCase):
    def test_ffmpeg_winget_install_found_with_stale_path(self):
        with tempfile.TemporaryDirectory() as folder:
            executable = Path(folder) / 'Microsoft/WinGet/Packages/Gyan.FFmpeg_test/ffmpeg-9/bin/ffmpeg.exe'
            executable.parent.mkdir(parents=True)
            executable.touch()
            with patch.dict(bootstrap.os.environ, {'LOCALAPPDATA': folder, 'FFMPEG_BINARY': ''}), patch.object(bootstrap.sys, 'platform', 'win32'), patch.object(bootstrap.shutil, 'which', return_value=None):
                self.assertEqual(bootstrap.find_ffmpeg(), str(executable))
