#!/usr/bin/env python3
"""Run Tauri, preserving pinned engines when creating Linux AppImages.

linuxdeploy's recursive ELF rewriting damages Typst's static PIE. Restore the
engine resources after dependency deployment, then invoke the standalone output
plugin. Separately deployed application/shared libraries remain unchanged.
Repair an idle AppDir: --repack-appdir PATH --output PATH.AppImage
"""
import argparse
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
ENGINES = ROOT / 'src-tauri/resources/engines'


def pkg_variable(package, variable):
    return subprocess.check_output(
        ['pkg-config', '--variable=' + variable, package], text=True).strip()


@contextmanager
def media_environment(environment):
    """Give linuxdeploy portable scanner paths (Arch colocates helpers/plugins).

    Its default helpers path is Debian-specific. Passing Arch's whole plugin
    directory as helpers would duplicate every plugin, so stage only the two
    runtime helpers. Explicit packager overrides remain supported.
    """
    environment = environment.copy()
    environment.setdefault('GSTREAMER_PLUGINS_DIR', pkg_variable('gstreamer-1.0', 'pluginsdir'))
    scanner_directory = Path(pkg_variable('gstreamer-1.0', 'pluginscannerdir'))
    with tempfile.TemporaryDirectory(prefix='notation-gstreamer-') as temporary:
        if not environment.get('GSTREAMER_HELPERS_DIR'):
            for name in ('gst-plugin-scanner', 'gst-ptp-helper'):
                source = scanner_directory / name
                if not source.is_file():
                    raise RuntimeError(f'GStreamer runtime helper is missing: {source}')
                shutil.copy2(source, Path(temporary) / name)
            environment['GSTREAMER_HELPERS_DIR'] = temporary
        yield environment


def verify_media_bundle(appdir):
    """Fail packaging rather than ship a webview that crashes on local media."""
    required = [
        'usr/lib/gstreamer-1.0/libgstapp.so',
        'usr/lib/gstreamer-1.0/libgstautodetect.so',
        'usr/lib/gstreamer-1.0/libgstcoreelements.so',
        'usr/lib/gstreamer-1.0/libgstplayback.so',
        'usr/lib/gstreamer-1.0/libgstaudioconvert.so',
        'usr/lib/gstreamer-1.0/libgstaudioresample.so',
        'usr/lib/gstreamer-1.0/libgstwavparse.so',
        'usr/lib/gstreamer-1.0/libgstisomp4.so',
        'usr/lib/gstreamer-1.0/libgstlibav.so',
        'usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner',
        'apprun-hooks/linuxdeploy-plugin-gstreamer.sh',
    ]
    missing = [name for name in required if not (appdir / name).is_file()]
    if missing:
        raise RuntimeError('AppImage playback dependencies are missing: ' + ', '.join(missing))
    if 'linuxdeploy-plugin-gstreamer.sh' not in (appdir / 'AppRun').read_text():
        raise RuntimeError('AppImage launcher does not activate its bundled GStreamer plugins')


def restore_webkit_helpers(appdir):
    """linuxdeploy may omit helpers when WebKit comes from a staged sysroot."""
    source = Path(pkg_variable('webkit2gtk-4.1', 'libdir')) / 'webkit2gtk-4.1'
    target = appdir / 'usr/lib/webkit2gtk-4.1'
    for name in ('WebKitWebProcess', 'WebKitNetworkProcess'):
        if not (target / name).is_file():
            if not (source / name).is_file():
                raise RuntimeError(f'WebKit runtime helper is missing: {source / name}')
            target.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / name, target / name)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def restore_engines(appdir):
    """Replace only bundled resources; never touch deployed application libs."""
    if not (ENGINES / 'manifest.json').is_file():
        raise RuntimeError('Pinned engine resources are missing; run npm run desktop:engines')
    candidates = list((appdir / 'usr/lib').glob('*/engines/manifest.json'))
    if len(candidates) != 1:
        raise RuntimeError(f'Expected one bundled engine resource directory in {appdir}')
    destination = candidates[0].parent
    shutil.rmtree(destination)
    shutil.copytree(ENGINES, destination, symlinks=True)
    for source in ENGINES.rglob('*'):
        target = destination / source.relative_to(ENGINES)
        if source.is_symlink():
            if not target.is_symlink() or os.readlink(source) != os.readlink(target):
                raise RuntimeError(f'Engine symlink changed: {source}')
        elif source.is_file():
            if digest(source) != digest(target) or source.stat().st_mode != target.stat().st_mode:
                raise RuntimeError(f'Engine bytes or permissions changed: {source}')
    environment = os.environ.copy()
    environment['LD_LIBRARY_PATH'] = os.pathsep.join([
        str(destination / 'jre/lib'), str(destination / 'jre/lib/server'),
        str(appdir / 'usr/lib'), environment.get('LD_LIBRARY_PATH', ''),
    ])
    for name, argument in [('bin/typst', '--version'), ('bin/pandoc', '--version'),
                           ('bin/d2', '--version'), ('jre/bin/java', '-version')]:
        result = subprocess.run([str(destination / name), argument], env=environment,
                                capture_output=True, text=True, timeout=15)
        if result.returncode:
            raise RuntimeError(f'Restored {name} failed ({result.returncode}): '
                               f'{result.stderr.strip() or "no error output"}')
    print(f'Restored and verified pinned engines: {destination}', flush=True)


def preserve_launch_directory(appdir):
    """Keep relative CLI paths valid after AppRun.wrapped changes directory."""
    launcher = appdir / 'AppRun'
    text = launcher.read_text()
    marker = '# Notation: preserve the caller directory before AppRun.wrapped.'
    if marker in text:
        return
    lines = text.splitlines(keepends=True)
    if not lines or not lines[0].startswith('#!'):
        raise RuntimeError('Expected the linuxdeploy shell launcher')
    lines.insert(1, marker + '\nexport OWD="${OWD:-$(pwd -P)}"\n')
    launcher.write_text(''.join(lines))


def repackage(appdir, output):
    appdir, output = appdir.resolve(), output.resolve()
    if not (appdir / 'AppRun').is_file():
        raise RuntimeError(f'AppDir launcher is missing: {appdir}')
    cache = Path(os.environ.get('XDG_CACHE_HOME', str(Path.home() / '.cache'))) / 'tauri'
    plugin = cache / 'linuxdeploy-plugin-appimage.AppImage'
    if not plugin.is_file():
        raise RuntimeError(f'Tauri AppImage output plugin is missing: {plugin}')
    restore_engines(appdir)
    restore_webkit_helpers(appdir)
    verify_media_bundle(appdir)
    preserve_launch_directory(appdir)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Publish only the successfully regenerated image. Preserve the previous
    # image if packaging fails, and return nonzero to prevent installation.
    with tempfile.TemporaryDirectory(prefix='notation-appimage-', dir=output.parent) as temporary:
        artifact = Path(temporary) / output.name
        environment = os.environ.copy()
        environment.update(APPIMAGE_EXTRACT_AND_RUN='1', LDAI_OUTPUT=str(artifact),
                           LDAI_NO_APPSTREAM='1')
        subprocess.run([str(plugin), '--appimage-extract-and-run', f'--appdir={appdir}'],
                       cwd=temporary, env=environment, check=True)
        if not artifact.is_file() or not os.access(artifact, os.X_OK):
            raise RuntimeError('AppImage plugin did not create an executable artifact')
        artifact.replace(output)
    print(f'Packaged verified offline engines: {output}', flush=True)


def built_images(target):
    # Cargo layouts: target/profile and target/triple/profile. Avoid traversing
    # incremental compilation trees or engine downloads.
    layouts = [target, *[path for path in target.glob('*') if path.is_dir()]]
    return [image for layout in layouts
            for image in layout.glob('*/bundle/appimage/*.AppImage')]


def main():
    if '--repack-appdir' in sys.argv:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('--repack-appdir', type=Path, required=True)
        parser.add_argument('--output', type=Path, required=True)
        args = parser.parse_args()
        repackage(args.repack_appdir, args.output)
        return 0
    environment = os.environ.copy()
    jre = ENGINES / 'jre/lib'
    if jre.is_dir():
        paths = [str(jre), str(jre / 'server')]
        if environment.get('LD_LIBRARY_PATH'):
            paths.append(environment['LD_LIBRARY_PATH'])
        environment['LD_LIBRARY_PATH'] = os.pathsep.join(paths)
    started = time.time()
    arguments = sys.argv[1:]
    if arguments and arguments[0] in ('build', 'bundle') and '--no-bundle' not in arguments:
        if not shutil.which('patchelf'):
            raise RuntimeError('AppImage media packaging requires patchelf on PATH')
        with media_environment(environment) as bundle_environment:
            result = subprocess.call(['npx', 'tauri', *arguments], cwd=ROOT, env=bundle_environment)
    else:
        result = subprocess.call(['npx', 'tauri', *arguments], cwd=ROOT, env=environment)
    if result:
        return result
    arguments = sys.argv[1:]
    if arguments and arguments[0] in ('build', 'bundle') and '--no-bundle' not in arguments:
        target = Path(environment.get('CARGO_TARGET_DIR', str(ROOT / 'src-tauri/target')))
        if not target.is_absolute():
            target = ROOT / target
        for image in built_images(target):
            if image.stat().st_mtime < started:
                continue
            appdirs = list(image.parent.glob('*.AppDir'))
            if len(appdirs) != 1:
                raise RuntimeError(f'Expected one AppDir beside {image}')
            repackage(appdirs[0], image)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'Native packaging failed: {error}', file=sys.stderr)
        raise SystemExit(1) from error
