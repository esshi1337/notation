#!/usr/bin/env python3
"""Host routing/resource regressions using disposable paths and mocked tools."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


setup = module('macos_setup', 'setup-macos.py')
cli = module('macos_cli', 'native-cli.py')
engines = module('macos_engines', 'bundle-engines.py')
languages = module('macos_languages', 'bundle-language-servers.py')
installer = module('macos_installer', 'install-desktop.py')


class MacosPlatformTest(unittest.TestCase):
    def setUp(self):
        self.system = patch.object(setup.platform, 'system', return_value='Darwin')
        self.machine = patch.object(setup.platform, 'machine', return_value='arm64')
        self.system.start()
        self.machine.start()
        self.addCleanup(self.system.stop)
        self.addCleanup(self.machine.stop)

    def test_host_architectures_and_unsupported_hosts(self):
        for machine, expected in [('arm64', 'macos-aarch64'), ('x86_64', 'macos-x86_64')]:
            with self.subTest(machine=machine), patch.object(setup.platform, 'machine', return_value=machine):
                self.assertEqual(setup.host_platform(), expected)
        with patch.object(setup.platform, 'system', return_value='Linux'), patch.object(
                setup.platform, 'machine', return_value='x86_64'):
            self.assertEqual(setup.host_platform(), 'linux-x86_64')
        with patch.object(setup.platform, 'system', return_value='Windows'):
            with self.assertRaisesRegex(RuntimeError, 'Unsupported desktop host'):
                setup.host_platform()

    def test_stub_is_repeatable_and_does_not_contain_payloads(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / 'engines'
            setup.prepare_macos_resources(destination)
            before = (destination / 'manifest.json').read_bytes()
            setup.prepare_macos_resources(destination)
            self.assertEqual((destination / 'manifest.json').read_bytes(), before)
            self.assertEqual(json.loads(before)['artifacts'], [])
            self.assertEqual([p.name for p in destination.iterdir()], ['manifest.json'])
            (destination / 'extra-executable').write_text('payload')
            with self.assertRaisesRegex(RuntimeError, 'incompatible'):
                setup.validate_macos_resources(destination)
            self.assertEqual((destination / 'extra-executable').read_text(), 'payload')

    def test_foreign_malformed_and_other_arch_resources_are_preserved(self):
        for manifest in ['{}', 'broken json', '{"platform":"linux-x86_64"}',
                         json.dumps(setup.stub_manifest('macos-x86_64'))]:
            with self.subTest(manifest=manifest), tempfile.TemporaryDirectory() as temporary:
                destination = Path(temporary) / 'engines'; destination.mkdir()
                (destination / 'manifest.json').write_text(manifest)
                with self.assertRaisesRegex(RuntimeError, 'incompatible'):
                    setup.prepare_macos_resources(destination)
                self.assertEqual((destination / 'manifest.json').read_text(), manifest)

    def test_missing_resources_and_symlinks_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(RuntimeError, 'missing or incompatible'):
                setup.validate_macos_resources(root / 'missing')
            setup.prepare_macos_resources(root / 'outside')
            (root / 'engines').symlink_to(root / 'outside', target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, 'symlink'):
                setup.prepare_macos_resources(root / 'engines')
            (root / 'parent').symlink_to(root / 'outside', target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, 'symlink'):
                setup.prepare_macos_resources(root / 'parent/new')
            manifest = root / 'outside/manifest.json'
            manifest.rename(root / 'manifest')
            manifest.symlink_to(root / 'manifest')
            with self.assertRaisesRegex(RuntimeError, 'incompatible'):
                setup.validate_macos_resources(root / 'outside')
            self.assertTrue((root / 'manifest').is_file())

    def test_darwin_dev_build_and_bundle_skip_every_linux_helper(self):
        for command in ['dev', 'build', 'bundle']:
            with self.subTest(command=command), patch.object(sys, 'argv', ['native-cli.py', command, '--features', 'desktop']), patch.dict(
                    cli.PLATFORM, {'validate_macos_resources': lambda: None}), patch.object(
                    cli.subprocess, 'call', return_value=7) as call, patch.object(
                    cli, 'media_environment') as media, patch.object(cli.shutil, 'which') as which, patch.object(
                    cli, 'repackage') as repack, patch.object(cli, 'built_images') as images:
                self.assertEqual(cli.main(), 7)
                call.assert_called_once_with([str(cli.ROOT / 'node_modules/.bin/tauri'), command, '--features', 'desktop'], cwd=cli.ROOT)
                media.assert_not_called()
                which.assert_not_called()
                repack.assert_not_called()
                images.assert_not_called()

    def test_missing_local_cli_never_downloads_a_replacement(self):
        for system, machine in [('Darwin', 'arm64'), ('Linux', 'x86_64')]:
            for arguments in [['dev'], ['build', '--no-bundle'], ['bundle']]:
                with self.subTest(system=system, arguments=arguments), tempfile.TemporaryDirectory() as temporary, patch.object(
                        cli, 'ROOT', Path(temporary)), patch.object(setup.platform, 'system', return_value=system), patch.object(
                        setup.platform, 'machine', return_value=machine), patch.object(
                        sys, 'argv', ['native-cli.py', *arguments]), patch.object(cli.subprocess, 'call') as call:
                    with self.assertRaisesRegex(RuntimeError, 'run npm ci first'):
                        cli.main()
                    call.assert_not_called()
                    self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_appimage_installer_rejects_macos_before_any_installation(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            artifact = home / 'Notation.AppImage'; artifact.write_bytes(b'fixture')
            with patch.object(Path, 'home', return_value=home), patch.object(
                    sys, 'argv', ['install-desktop.py', str(artifact)]), patch.object(
                    installer.shutil, 'copyfile') as copy, patch.object(installer.subprocess, 'run') as run:
                with self.assertRaisesRegex(SystemExit, 'Linux x86-64'):
                    installer.main()
                copy.assert_not_called()
                run.assert_not_called()
                self.assertEqual(list(home.iterdir()), [artifact])

    def test_darwin_preflight_failure_and_repack_fail_before_tauri(self):
        with patch.object(sys, 'argv', ['native-cli.py', 'build']), patch.dict(
                cli.PLATFORM, {'validate_macos_resources': lambda: setup.validate_macos_resources(Path('/missing/engines'))}), patch.object(
                cli.subprocess, 'call') as call:
            with self.assertRaisesRegex(RuntimeError, 'missing or incompatible'):
                cli.main()
            call.assert_not_called()
        with patch.object(sys, 'argv', ['native-cli.py', '--repack-appdir', '/unused']), patch.object(
                cli.subprocess, 'call') as call:
            with self.assertRaisesRegex(RuntimeError, 'Linux-only'):
                cli.main()
            call.assert_not_called()

    def test_repack_rejects_mixed_commands_without_running_anything(self):
        for system in ['Linux', 'Darwin']:
            for command in ['dev', 'build', 'bundle']:
                with self.subTest(system=system, command=command), patch.object(
                        setup.platform, 'system', return_value=system), patch.object(
                        sys, 'argv', ['native-cli.py', command, '--repack-appdir', '/tmp/input', '--output', '/tmp/output']), patch.object(
                        cli.subprocess, 'call') as call, patch.object(cli, 'repackage') as repack:
                    with self.assertRaisesRegex(RuntimeError, 'cannot be combined'):
                        cli.main()
                    call.assert_not_called()
                    repack.assert_not_called()

    def test_linux_no_bundle_and_dev_keep_original_routing(self):
        for arguments in [['dev'], ['build', '--no-bundle']]:
            with patch.object(setup.platform, 'system', return_value='Linux'), patch.object(
                    setup.platform, 'machine', return_value='x86_64'), patch.object(
                    sys, 'argv', ['native-cli.py', *arguments]), patch.object(
                    cli.subprocess, 'call', return_value=0) as call, patch.object(cli, 'media_environment') as media:
                self.assertEqual(cli.main(), 0)
                self.assertEqual(call.call_args.args[0], [str(cli.ROOT / 'node_modules/.bin/tauri'), *arguments])
                media.assert_not_called()

    def test_installers_reject_darwin_before_network_or_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / 'language-servers'
            with patch.object(languages.subprocess, 'run') as run, patch.object(
                    languages, 'node_archive') as download:
                with self.assertRaisesRegex(RuntimeError, 'Linux x86-64'):
                    languages.install(destination)
                run.assert_not_called()
                download.assert_not_called()
            with patch.object(engines, 'fetch') as fetch, patch.object(sys, 'argv', ['bundle-engines.py']):
                with self.assertRaisesRegex(RuntimeError, 'Linux x86-64'):
                    engines.main()
                fetch.assert_not_called()
            with self.assertRaisesRegex(RuntimeError, 'Linux x86-64'):
                languages.node_archive()
            with self.assertRaisesRegex(RuntimeError, 'Linux x86-64'):
                languages.publish(Path(temporary) / 'stage', destination)
            self.assertFalse(destination.exists())

    def test_macos_language_pack_path_ignores_xdg(self):
        with patch.dict(languages.os.environ, {'XDG_DATA_HOME': '/irrelevant'}):
            self.assertEqual(languages.default_destination(),
                             Path.home() / 'Library/Application Support/local.notation.app/language-servers')

    def test_setup_checks_tools_and_runs_only_npm_ci_then_stub(self):
        for machine, node_arch, rust_arch in [('arm64', 'arm64', 'aarch64'), ('x86_64', 'x64', 'x86_64')]:
            with self.subTest(machine=machine), tempfile.TemporaryDirectory() as temporary, patch.object(
                    setup.platform, 'machine', return_value=machine), patch.object(
                    setup, 'ENGINES', Path(temporary) / 'engines'), patch.object(
                    setup.subprocess, 'check_output', side_effect=['v22.13.0', f'rustc 1.89.0\nhost: {rust_arch}-apple-darwin', node_arch]), patch.object(
                    setup.subprocess, 'run') as run:
                self.assertEqual(setup.main(), 0)
                self.assertEqual([call.args[0] for call in run.call_args_list],
                                 [['xcode-select', '-p'], ['xcrun', '--find', 'clang'], ['cargo', '--version'], ['npm', 'ci']])
                setup.validate_macos_resources()

    def test_setup_architecture_mismatch_or_old_tools_do_not_install(self):
        for outputs, error in [(['v22.12.0'], 'Node.js'),
                               (['v22.13.0', 'rustc 1.88.0'], 'Rust'),
                               (['v22.13.0', 'rustc 1.89.0\nhost: aarch64-apple-darwin', 'x64'], 'same host architecture')]:
            with self.subTest(outputs=outputs), patch.object(setup.subprocess, 'run') as run, patch.object(
                    setup.subprocess, 'check_output', side_effect=outputs):
                with self.assertRaisesRegex(RuntimeError, error):
                    setup.main()
                self.assertNotIn(['npm', 'ci'], [call.args[0] for call in run.call_args_list])

    def test_missing_xcode_or_old_python_fails_before_install(self):
        with patch.object(setup.subprocess, 'run', side_effect=FileNotFoundError('xcode-select')), patch.object(
                setup.subprocess, 'check_output') as output:
            with self.assertRaises(FileNotFoundError):
                setup.main()
            output.assert_not_called()
        with patch.object(setup.sys, 'version_info', (3, 10)), patch.object(setup.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'Python 3.11'):
                setup.main()
            run.assert_not_called()

    def test_linux_installer_preserves_macos_stub_and_rejects_wrong_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / 'engines'
            setup.prepare_macos_resources(destination)
            before = (destination / 'manifest.json').read_bytes()
            with patch.object(setup.platform, 'system', return_value='Linux'), patch.object(
                    setup.platform, 'machine', return_value='x86_64'), patch.object(engines, 'DEST', destination):
                with self.assertRaisesRegex(RuntimeError, 'incompatible engine resources'):
                    engines.preflight_destination({'platform': 'linux-x86_64'})
                with self.assertRaisesRegex(RuntimeError, 'does not match'):
                    engines.preflight_destination({'platform': 'macos-aarch64'})
            self.assertEqual((destination / 'manifest.json').read_bytes(), before)

    def test_setup_refuses_foreign_resources_before_npm_ci(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / 'engines'; destination.mkdir()
            (destination / 'manifest.json').write_text('{"platform":"linux-x86_64"}')
            with patch.object(setup, 'ENGINES', destination), patch.object(
                    setup.subprocess, 'run') as run, patch.object(setup.subprocess, 'check_output', side_effect=[
                        'v22.13.0', 'rustc 1.89.0\nhost: aarch64-apple-darwin', 'arm64']):
                with self.assertRaisesRegex(RuntimeError, 'incompatible'):
                    setup.main()
                self.assertNotIn(['npm', 'ci'], [call.args[0] for call in run.call_args_list])
                self.assertEqual((destination / 'manifest.json').read_text(), '{"platform":"linux-x86_64"}')

    def test_tauri_platform_config_and_npm_commands(self):
        base = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())
        macos = json.loads((ROOT / 'src-tauri/tauri.macos.conf.json').read_text())
        scripts = json.loads((ROOT / 'package.json').read_text())['scripts']
        self.assertEqual(base['bundle']['targets'], ['appimage'])
        self.assertEqual(macos['bundle']['targets'], ['app', 'dmg'])
        # Apple Silicon refuses unsigned code; the CSS needs Safari 16.2+ (macOS 13).
        self.assertEqual(macos['bundle']['macOS'], {'minimumSystemVersion': '13.0', 'signingIdentity': '-'})
        # Platform config replaces the windows array, so the macOS window must
        # restate every base setting and add only the overlay title bar.
        [base_window], [mac_window] = base['app']['windows'], macos['app']['windows']
        overlay = {'titleBarStyle': 'Overlay', 'hiddenTitle': True, 'trafficLightPosition': {'x': 14, 'y': 16}}
        self.assertEqual(mac_window, {**base_window, **overlay})
        # Both start hidden; the app presents the window once its theme is applied.
        self.assertIs(base_window['visible'], False)
        self.assertFalse(set(overlay) & set(base_window))
        capability = json.loads((ROOT / 'src-tauri/capabilities/macos.json').read_text())
        self.assertEqual((capability['platforms'], capability['windows']), (['macOS'], ['main']))
        self.assertEqual(capability['permissions'], ['core:window:allow-start-dragging', 'core:window:allow-internal-toggle-maximize'])
        default = json.loads((ROOT / 'src-tauri/capabilities/default.json').read_text())
        self.assertNotIn('core:window:allow-start-dragging', default['permissions'])
        self.assertEqual(base['bundle']['resources'], {'resources/engines/': 'engines/'})
        for name in ['desktop', 'desktop:build', 'desktop:bundle']:
            self.assertIn('scripts/native-cli.py', scripts[name])
            self.assertNotIn('--bundles appimage', scripts[name])


if __name__ == '__main__':
    unittest.main(verbosity=2)
