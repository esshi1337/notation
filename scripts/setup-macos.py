#!/usr/bin/env python3
"""Prepare basic macOS development and preflight optional desktop resources."""
import json
from pathlib import Path
import platform
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ENGINES = ROOT / 'src-tauri/resources/engines'


def host_platform():
    system = platform.system()
    machine = platform.machine().lower()
    architecture = {'arm64': 'aarch64', 'amd64': 'x86_64'}.get(machine, machine)
    if system not in ('Linux', 'Darwin') or architecture not in ('aarch64', 'x86_64'):
        raise RuntimeError(f'Unsupported desktop host: {system}/{machine}')
    return ('macos' if system == 'Darwin' else 'linux') + '-' + architecture


def require_linux_x64(feature):
    if host_platform() != 'linux-x86_64':
        raise RuntimeError(f'{feature} is available only on Linux x86-64. '
                           'No compatible macOS assets are pinned; nothing was installed. '
                           'Use python3 scripts/setup-macos.py for basic macOS development.')


def stub_manifest(host):
    return {'platform': host, 'resourceKind': 'notation-disabled-engines',
            'manifestVersion': 1, 'artifacts': [],
            'reason': 'Native engines require the Linux Landlock and seccomp sandbox.'}


def check_resource_path(directory):
    for path in (directory, *directory.parents):
        if path.is_symlink():
            raise RuntimeError(f'Engine resource path must not contain symlinks: {path}')


def validate_macos_resources(directory=None):
    """Accept only our exact empty stub; never bundle foreign executable payloads."""
    directory = ENGINES if directory is None else directory
    host = host_platform()
    if not host.startswith('macos-'):
        raise RuntimeError('The disabled engine stub is for macOS hosts only')
    check_resource_path(directory)
    try:
        manifest = directory / 'manifest.json'
        valid = (directory.is_dir() and set(directory.iterdir()) == {manifest}
                 and not manifest.is_symlink() and manifest.is_file()
                 and manifest.stat().st_size <= 4096
                 and json.loads(manifest.read_text()) == stub_manifest(host))
    except (OSError, ValueError):
        valid = False
    if not valid:
        raise RuntimeError(f'Engine resources at {directory} are missing or incompatible with {host}. '
                           'Move any existing resources aside explicitly, then run '
                           'python3 scripts/setup-macos.py. Existing resources were not changed.')


def prepare_macos_resources(directory=None):
    directory = ENGINES if directory is None else directory
    # Never convert a Linux bundle or a stub for another architecture in place.
    if directory.exists() or directory.is_symlink():
        validate_macos_resources(directory)
        return
    check_resource_path(directory)
    host = host_platform()
    if not host.startswith('macos-'):
        raise RuntimeError('The disabled engine stub is for macOS hosts only')
    directory.mkdir(parents=True)
    with (directory / 'manifest.json').open('x') as output:
        output.write(json.dumps(stub_manifest(host), indent=2) + '\n')
    validate_macos_resources(directory)


def version_at_least(output, minimum, name):
    match = re.search(r'(\d+)\.(\d+)\.(\d+)', output)
    if not match or tuple(map(int, match.groups())) < minimum:
        raise RuntimeError(f'{name} must be at least {".".join(map(str, minimum))}; found {output.strip()}')


def main():
    if sys.version_info < (3, 11):
        raise RuntimeError('Python 3.11 or newer is required; install it and use its python3 command')
    host = host_platform()
    if not host.startswith('macos-'):
        raise RuntimeError('This setup command requires macOS')
    subprocess.run(['xcode-select', '-p'], check=True, capture_output=True, text=True)
    subprocess.run(['xcrun', '--find', 'clang'], check=True, capture_output=True, text=True)
    node = subprocess.check_output(['node', '--version'], text=True)
    version_at_least(node, (22, 13, 0), 'Node.js')
    rust = subprocess.check_output(['rustc', '-vV'], text=True)
    version_at_least(rust, (1, 89, 0), 'Rust')
    architecture = host.removeprefix('macos-')
    node_arch = subprocess.check_output(['node', '-p', 'process.arch'], text=True).strip()
    if node_arch != {'aarch64': 'arm64', 'x86_64': 'x64'}[architecture] or (
            f'host: {architecture}-apple-darwin' not in rust.splitlines()):
        raise RuntimeError('Python, Node.js and Rust must use the same host architecture. '
                           'Use native tools consistently (avoid mixing Rosetta and Apple Silicon tools).')
    subprocess.run(['cargo', '--version'], check=True)
    # Reject a copied Linux bundle before npm installs or modifies anything.
    check_resource_path(ENGINES)
    if ENGINES.exists() or ENGINES.is_symlink():
        validate_macos_resources()
    subprocess.run(['npm', 'ci'], cwd=ROOT, check=True)
    prepare_macos_resources()
    print(f'Ready for {host}: run npm run desktop. Native engines and the optional '
          'TypeScript/Svelte language pack are unavailable on macOS.')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'macOS setup failed: {error}', file=sys.stderr)
        raise SystemExit(1) from error
