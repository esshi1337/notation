#!/usr/bin/env python3
"""Explicitly install Notation's optional, pinned language-server pack.

No package lifecycle scripts run here. Nothing is downloaded or installed unless
--install is present. --output selects a disposable/alternate pack directory and
never changes the default application profile.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import uuid
import runpy

ROOT = Path(__file__).resolve().parents[1]
TOOLING = ROOT / 'tooling/language-servers'
CACHE = TOOLING / '.cache'
NODE_VERSION = '22.23.3'
NODE_SHA256 = 'df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de'
MANIFEST_VERSION = 1
REQUIRED_PATCH = 'svelte-untrusted-prettier-config'
PLATFORM = runpy.run_path(str(ROOT / 'scripts/setup-macos.py'))


def default_destination():
    if PLATFORM['host_platform']().startswith('macos-'):
        return Path.home() / 'Library/Application Support/local.notation.app/language-servers'
    configured = os.environ.get('XDG_DATA_HOME')
    if configured:
        data_home = Path(configured).expanduser()
        if not data_home.is_absolute():
            raise RuntimeError('XDG_DATA_HOME must be an absolute path')
    else:
        data_home = Path.home() / '.local/share'
    return data_home / 'local.notation.app/language-servers'


def patch_untrusted_prettier(stage):
    # Keep these pinned safety patches: untrusted workspace Prettier config and
    # plugins must never be loaded by the optional Svelte server.
    server = stage / 'node_modules/svelte-language-server/dist/src'
    replacements = {
        'importPackage.js': [('paths.push(__dirname);', "paths.push(!isTrusted && packageName === 'svelte' ? (0, path_1.resolve)(__dirname, '../../../..') : __dirname);")],
        'ls-config.js': [('await (0, importPackage_1.importPrettier)(filePath).resolveConfig(filePath, this.getPrettierConfigLoadingOptions())', 'this.getIsTrusted() ? await (0, importPackage_1.importPrettier)(filePath).resolveConfig(filePath, this.getPrettierConfigLoadingOptions()) : null')],
        'plugins/html/HTMLPlugin.js': [('const prettierConfig = filePath &&', 'const prettierConfig = this.configManager.getIsTrusted() && filePath &&')],
        'plugins/svelte/SveltePlugin.js': [('const fileInfo = await prettier.getFileInfo(filePath, {', 'const fileInfo = await prettier.getFileInfo(filePath, { resolveConfig: this.configManager.getIsTrusted(),'), ('getMergedPrettierConfig(await p.resolveConfig(filePath, {', 'getMergedPrettierConfig(this.configManager.getIsTrusted() ? await p.resolveConfig(filePath, {'), ('                }), \n                // Be defensive', '                }) : null, \n                // Be defensive')],
    }
    for name, edits in replacements.items():
        file = server / name
        text = file.read_text()
        for before, after in edits:
            if text.count(before) != 1:
                raise RuntimeError('Svelte trust patch no longer matches pinned package: ' + name)
            text = text.replace(before, after)
        file.write_text(text)


def collect_packages(install_root):
    lock = json.loads((install_root / 'package-lock.json').read_text())['packages']
    packages = set()

    def collect(name, parent=install_root):
        cursor = parent
        while True:
            candidate = cursor / 'node_modules' / name
            if (candidate / 'package.json').is_file():
                break
            if cursor == install_root:
                raise RuntimeError('Missing locked dependency: ' + name)
            cursor = cursor.parent
        key = candidate.relative_to(install_root).as_posix()
        if key in packages:
            return
        data = json.loads((candidate / 'package.json').read_text())
        if data['version'] != lock[key]['version']:
            raise RuntimeError('Installed package differs from lock: ' + key)
        packages.add(key)
        for child in data.get('dependencies', {}):
            collect(child, candidate)
        for child in data.get('optionalDependencies', {}):
            try:
                collect(child, candidate)
            except RuntimeError:
                pass

    for name in ['typescript', 'typescript-language-server', 'svelte-language-server', 'svelte']:
        collect(name)
    return packages, lock


def node_archive():
    PLATFORM['require_linux_x64']('The optional language-server pack')
    CACHE.mkdir(parents=True, exist_ok=True)
    archive = CACHE / f'node-v{NODE_VERSION}-linux-x64.tar.xz'
    if archive.exists():
        if hashlib.sha256(archive.read_bytes()).hexdigest() != NODE_SHA256:
            raise RuntimeError(f'Cached Node archive checksum mismatch: {archive}')
        return archive
    descriptor, temporary_name = tempfile.mkstemp(prefix=archive.name + '.', dir=CACHE)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with urllib.request.urlopen(
                f'https://nodejs.org/dist/v{NODE_VERSION}/{archive.name}', timeout=60) as response:
            with temporary.open('wb') as output:
                shutil.copyfileobj(response, output)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != NODE_SHA256:
            raise RuntimeError('Downloaded Node archive checksum mismatch')
        temporary.replace(archive)
    finally:
        temporary.unlink(missing_ok=True)
    return archive


def stage_pack(install_root, archive, stage):
    packages, lock = collect_packages(install_root)
    stage.mkdir()
    with tarfile.open(archive) as tar:
        for member in ['bin/node', 'LICENSE']:
            source = tar.extractfile(f'node-v{NODE_VERSION}-linux-x64/{member}')
            if source is None:
                raise RuntimeError('Pinned Node archive is incomplete')
            (stage / ('node' if member == 'bin/node' else 'NODE-LICENSE')).write_bytes(source.read())
    (stage / 'node').chmod(0o755)
    for key in sorted(packages):
        shutil.copytree(install_root / key, stage / key,
                        ignore=shutil.ignore_patterns('node_modules', '.git'), dirs_exist_ok=True)
    patch_untrusted_prettier(stage)
    manifest = {
        'packKind': 'notation-language-servers',
        'manifestVersion': MANIFEST_VERSION,
        'notationPatches': [REQUIRED_PATCH],
        'node': NODE_VERSION,
        'nodeArchiveSha256': NODE_SHA256,
        'packages': {key: lock[key]['version'] for key in sorted(packages)},
    }
    (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    environment = os.environ.copy()
    environment.pop('NODE_OPTIONS', None)
    environment.pop('NODE_PATH', None)
    subprocess.run([str(stage / 'node'), '--version'], check=True, cwd=stage,
                   env=environment, timeout=15)
    subprocess.run([str(stage / 'node'),
                    str(stage / 'node_modules/typescript-language-server/lib/cli.mjs'),
                    '--version'], check=True, cwd=stage, env=environment, timeout=30)
    return len(packages)


def ensure_replaceable(destination):
    if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
        raise RuntimeError(f'Language-pack destination is not a regular directory: {destination}')
    if destination.is_dir() and any(destination.iterdir()):
        manifest = destination / 'manifest.json'
        try:
            if manifest.is_symlink() or manifest.stat().st_size > 65536:
                raise ValueError('Invalid manifest file')
            value = json.loads(manifest.read_text())
            expected = json.loads((TOOLING / 'package.json').read_text())['dependencies']
            valid = (value.get('packKind') == 'notation-language-servers'
                     and value.get('manifestVersion') == MANIFEST_VERSION
                     and REQUIRED_PATCH in value.get('notationPatches', [])
                     and value.get('node') == NODE_VERSION
                     and value.get('nodeArchiveSha256') == NODE_SHA256
                     and all(value.get('packages', {}).get('node_modules/' + name) == version
                             for name, version in expected.items()))
            if not valid:
                raise ValueError('Not an installer-owned compatible pack')
        except (OSError, ValueError, TypeError, AttributeError) as error:
            raise RuntimeError(f'Refusing to replace an unrecognized nonempty directory: {destination}') from error


def publish(stage, destination):
    """Pin parent directories and preserve the prior pack if publication fails."""
    PLATFORM['require_linux_x64']('The optional language-server pack')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent = os.open(destination.parent, flags)
    source = None
    backup_fd = None
    backup_name = '.language-servers-backup-' + uuid.uuid4().hex
    moved_previous = False
    try:
        source = os.open(stage.parent, flags)
        pinned = Path('/proc/self/fd') / str(parent) / destination.name
        ensure_replaceable(pinned)
        os.mkdir(backup_name, mode=0o700, dir_fd=parent)
        backup_fd = os.open(backup_name, flags, dir_fd=parent)
        try:
            if pinned.exists():
                os.rename(destination.name, 'previous', src_dir_fd=parent, dst_dir_fd=backup_fd)
                moved_previous = True
                # Recheck the actual moved directory, closing the validation/rename race.
                ensure_replaceable(Path('/proc/self/fd') / str(backup_fd) / 'previous')
            os.rename(stage.name, destination.name, src_dir_fd=source, dst_dir_fd=parent)
        except Exception as error:
            if moved_previous:
                try:
                    os.rename('previous', destination.name, src_dir_fd=backup_fd, dst_dir_fd=parent)
                except OSError as rollback:
                    raise RuntimeError(
                        f'Could not publish or restore the language pack; the previous pack is preserved at {destination.parent / backup_name / "previous"}: {rollback}'
                    ) from error
            shutil.rmtree(backup_name, dir_fd=parent)
            raise
        shutil.rmtree(backup_name, dir_fd=parent)
    finally:
        if backup_fd is not None:
            os.close(backup_fd)
        if source is not None:
            os.close(source)
        os.close(parent)


def install(destination):
    PLATFORM['require_linux_x64']('The optional language-server pack')
    destination = destination.expanduser().absolute()
    ensure_replaceable(destination)
    # Resolve the parent only; never erase the final-component symlink check.
    destination = destination.parent.resolve() / destination.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.language-servers-stage-', dir=destination.parent) as temporary:
        work = Path(temporary)
        install_root = work / 'npm'
        install_root.mkdir()
        for name in ['package.json', 'package-lock.json']:
            shutil.copy2(TOOLING / name, install_root / name)
        # The isolated manifest plus --ignore-scripts prevents repository,
        # workspace, and dependency lifecycle configuration from executing.
        subprocess.run(['npm', 'ci', '--ignore-scripts', '--workspaces=false',
                        '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'],
                       cwd=install_root, check=True, timeout=300)
        package_count = stage_pack(install_root, node_archive(), work / 'pack')
        publish(work / 'pack', destination)
    print(f'Installed {package_count} locked language-server packages to {destination}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true', required=True,
                        help='explicitly download and install the optional pack')
    parser.add_argument('--output', type=Path,
                        help='pack directory to create instead of the default application profile')
    args = parser.parse_args()
    install(args.output if args.output is not None else default_destination())
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'Language-pack installation failed: {error}', file=sys.stderr)
        raise SystemExit(1) from error
