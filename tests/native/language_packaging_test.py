#!/usr/bin/env python3
"""Local packaging-path regression tests; never download or touch a user profile."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]

def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

installer = module('language_installer', 'bundle-language-servers.py')
packager = module('native_packager', 'native-cli.py')

def pack(path, text='working'):
    path.mkdir(parents=True)
    manifest = {'packKind': 'notation-language-servers', 'manifestVersion': installer.MANIFEST_VERSION,
                'notationPatches': [installer.REQUIRED_PATCH], 'node': installer.NODE_VERSION,
                'nodeArchiveSha256': installer.NODE_SHA256,
                'packages': {'node_modules/' + name: version for name, version in
                             json.loads((installer.TOOLING / 'package.json').read_text())['dependencies'].items()}}
    (path / 'manifest.json').write_text(json.dumps(manifest))
    (path / 'payload').write_text(text)

class PackagingPaths(unittest.TestCase):
    def test_installer_rejects_final_symlink_before_downloading(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); pack(root / 'outside')
            (root / 'link').symlink_to(root / 'outside', target_is_directory=True)
            with patch.object(installer.subprocess, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'regular directory'):
                    installer.install(root / 'link')
                run.assert_not_called()
            self.assertEqual((root / 'outside/payload').read_text(), 'working')

    def test_lookalike_manifest_is_not_an_owned_pack(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); destination = root / 'notes'; destination.mkdir()
            (destination / 'manifest.json').write_text('{}')
            (destination / 'precious').write_text('preserve')
            pack(root / 'stage', 'new')
            with self.assertRaisesRegex(RuntimeError, 'unrecognized'):
                installer.publish(root / 'stage', destination)
            self.assertEqual((destination / 'precious').read_text(), 'preserve')
            self.assertTrue((root / 'stage/payload').exists())

    def test_successful_publication_and_rollback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); pack(root / 'pack'); pack(root / 'stage', 'new')
            original = installer.os.rename
            def fail_stage(source, destination, **kwargs):
                if source == 'stage':
                    raise OSError('injected publication failure')
                return original(source, destination, **kwargs)
            with patch.object(installer.os, 'rename', side_effect=fail_stage):
                with self.assertRaisesRegex(OSError, 'injected'):
                    installer.publish(root / 'stage', root / 'pack')
            self.assertEqual((root / 'pack/payload').read_text(), 'working')
            self.assertEqual((root / 'stage/payload').read_text(), 'new')
            installer.publish(root / 'stage', root / 'pack')
            self.assertEqual((root / 'pack/payload').read_text(), 'new')
            self.assertFalse(list(root.glob('.language-servers-backup-*')))

    def test_changed_destination_is_restored_without_deletion(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); pack(root / 'pack'); pack(root / 'stage', 'new')
            original = installer.os.rename
            def race(source, destination, **kwargs):
                if source == 'pack' and destination == 'previous':
                    original('pack', 'original', src_dir_fd=kwargs['src_dir_fd'], dst_dir_fd=kwargs['src_dir_fd'])
                    (root / 'pack').mkdir()
                    (root / 'pack/unrelated').write_text('preserve')
                return original(source, destination, **kwargs)
            with patch.object(installer.os, 'rename', side_effect=race):
                with self.assertRaisesRegex(RuntimeError, 'unrecognized'):
                    installer.publish(root / 'stage', root / 'pack')
            self.assertEqual((root / 'pack/unrelated').read_text(), 'preserve')
            self.assertEqual((root / 'original/payload').read_text(), 'working')

    def test_appdir_cleanup_pins_intermediate_directories(self):
        for link in ['usr', 'usr/lib', 'usr/lib/Notation']:
            with self.subTest(link=link), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); app = root / 'app'; app.mkdir()
                outside = root / 'outside'; (outside / 'language-servers').mkdir(parents=True)
                (outside / 'language-servers/precious').write_text('preserve')
                target = app / link; target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(outside, target_is_directory=True)
                if link == 'usr/lib/Notation':
                    packager.remove_stale_language_servers(app)
                else:
                    with self.assertRaises(OSError):
                        packager.remove_stale_language_servers(app)
                self.assertEqual((outside / 'language-servers/precious').read_text(), 'preserve')

    def test_appdir_cleanup_unlinks_leaf_symlinks_and_removes_real_pack(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); app = root / 'app'; outside = root / 'outside'; outside.mkdir()
            (outside / 'precious').write_text('preserve')
            library = app / 'usr/lib'; (library / 'Notation').mkdir(parents=True)
            (library / 'Notation/language-servers').symlink_to(outside, target_is_directory=True)
            packager.remove_stale_language_servers(app)
            self.assertEqual((outside / 'precious').read_text(), 'preserve')
            self.assertFalse((library / 'Notation/language-servers').exists())
            pack(library / 'Notation/language-servers')
            packager.remove_stale_language_servers(app)
            self.assertFalse((library / 'Notation/language-servers').exists())

if __name__ == '__main__':
    unittest.main(verbosity=2)
