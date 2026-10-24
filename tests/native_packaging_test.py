"""Regression checks for standalone playback dependencies and portable helpers."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_cli', Path(__file__).parents[1] / 'scripts/native-cli.py')
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


class MediaPackagingTest(unittest.TestCase):
    def test_arch_helper_directory_does_not_duplicate_plugins(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            for name in ('gst-plugin-scanner', 'gst-ptp-helper', 'libgstapp.so', 'gst-doc-helper'):
                (source / name).write_bytes(b'runtime fixture')
            with patch.object(packaging, 'pkg_variable', return_value=str(source)):
                original = {'CUSTOM': 'kept'}
                with packaging.media_environment(original) as environment:
                    staged = Path(environment['GSTREAMER_HELPERS_DIR'])
                    self.assertEqual({p.name for p in staged.iterdir()}, {'gst-plugin-scanner', 'gst-ptp-helper'})
                    self.assertEqual(environment['GSTREAMER_PLUGINS_DIR'], str(source))
                    self.assertEqual(environment['CUSTOM'], 'kept')
                self.assertFalse(staged.exists())
                self.assertEqual(original, {'CUSTOM': 'kept'})

    def test_missing_scanner_fails_before_build(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(packaging, 'pkg_variable', return_value=temporary):
                with self.assertRaisesRegex(RuntimeError, 'runtime helper is missing'):
                    with packaging.media_environment({}):
                        self.fail('Should not build without a scanner')

    def test_explicit_helper_override_is_preserved(self):
        with patch.object(packaging, 'pkg_variable', return_value='/unused'):
            with packaging.media_environment({'GSTREAMER_PLUGINS_DIR': '/plugins', 'GSTREAMER_HELPERS_DIR': '/helpers'}) as env:
                self.assertEqual(env['GSTREAMER_PLUGINS_DIR'], '/plugins')
                self.assertEqual(env['GSTREAMER_HELPERS_DIR'], '/helpers')

    def test_incomplete_appdir_cannot_be_published(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(RuntimeError, 'playback dependencies are missing'):
                packaging.verify_media_bundle(Path(temporary))


if __name__ == '__main__':
    unittest.main()
