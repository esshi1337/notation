#!/usr/bin/env python3
"""Parse generated desktop entries with GIO and verify literal argv delivery."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location('notation_installer', Path(__file__).resolve().parents[2] / 'scripts/install-desktop.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class DesktopExecRoundtrip(unittest.TestCase):
    def test_gio_preserves_reserved_characters_in_executable_and_file_arguments(self):
        with tempfile.TemporaryDirectory(prefix='nt-exec-') as temporary:
            root = Path(temporary)
            directory = root / 'space $cash \\back "quote" %pct `tick` ü'
            directory.mkdir()
            output = root / 'received.json'
            launcher = directory / 'launcher'
            launcher.write_text('#!' + sys.executable + '\nimport sys,json\nfrom pathlib import Path\nPath(' + repr(str(output)) + ').write_text(json.dumps(sys.argv[1:]))\n')
            launcher.chmod(0o755)
            entry = root / 'test.desktop'
            entry.write_text(installer.desktop_entry(launcher))
            arguments = [root / 'literal $(touch NOPE) & ü.txt', root / 'file %F with spaces.txt']
            for argument in arguments: argument.write_text('fixture')
            result = subprocess.run(['gio', 'launch', str(entry), *map(str, arguments)], capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            deadline = time.monotonic() + 3
            while not output.exists() and time.monotonic() < deadline: time.sleep(.02)
            self.assertTrue(output.exists(), 'GIO did not execute the exact generated launcher path')
            self.assertEqual(json.loads(output.read_text()), list(map(str, arguments)))
            self.assertFalse((root / 'NOPE').exists())


if __name__ == '__main__':
    unittest.main()
