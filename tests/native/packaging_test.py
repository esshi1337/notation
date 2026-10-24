"""Regression checks for standalone playback dependencies and portable helpers."""
import importlib.util
from pathlib import Path
import tempfile
import os
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_cli', Path(__file__).parents[2] / 'scripts/native-cli.py')
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)

install_spec = importlib.util.spec_from_file_location('install_desktop', Path(__file__).parents[2] / 'scripts/install-desktop.py')
installer = importlib.util.module_from_spec(install_spec)
install_spec.loader.exec_module(installer)


class DesktopInstallerTest(unittest.TestCase):
    def test_ordinary_launcher_is_unquoted_and_accepts_multiple_files(self):
        entry = installer.desktop_entry('/home/user/.local/bin/notation')
        self.assertIn('Exec=/home/user/.local/bin/notation %F\n', entry)
        self.assertNotIn('Exec="', entry)
        self.assertIn('MimeType=text/plain;text/markdown;text/x-markdown;\n', entry)
        self.assertNotIn('offic', entry.lower())
        self.assertNotIn('pdf', entry.lower())

    def test_special_launcher_paths_use_desktop_escaping_not_shell_expansion(self):
        path = '/opt/Notation App/100% $HOME `tick` "quoted" \\notation'
        argument = installer.desktop_exec_argument(path)
        exec_quoted = r'"/opt/Notation App/100%% \$HOME \`tick\` \"quoted\" \\notation"'
        self.assertEqual(argument, exec_quoted.replace('\\', '\\\\'))
        entry = installer.desktop_entry(path)
        self.assertIn(f'Exec=/usr/bin/env {argument} %F\n', entry)
        self.assertNotIn('sh -c', entry)


class MediaPackagingTest(unittest.TestCase):
    def test_launcher_preserves_caller_directory_before_changing_cwd(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            appdir = root / 'bundle'; appdir.mkdir()
            caller = root / 'caller with spaces'; caller.mkdir()
            launcher = appdir / 'AppRun'
            launcher.write_text('#!/bin/sh\ncd /\nprintf "%s" "$OWD"\n')
            packaging.preserve_launch_directory(appdir)
            first = launcher.read_text()
            packaging.preserve_launch_directory(appdir)
            self.assertEqual(launcher.read_text(), first)
            env = dict(os.environ); env.pop('OWD', None)
            result = subprocess.check_output(['sh', str(launcher)], cwd=caller, env=env, text=True)
            self.assertEqual(result, str(caller.resolve()))

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
