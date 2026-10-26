#!/usr/bin/env python3
"""Install a built Notation AppImage and desktop launcher for the current user."""

import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import sys


SAFE_EXECUTABLE = re.compile(r'^[A-Za-z0-9_./+-]+$')


def desktop_exec_argument(path):
    """Quote one desktop Exec argument without invoking shell semantics."""
    value = str(path)
    if not value or any(character in value for character in ('\0', '\n', '\r')):
        raise ValueError('The launcher path cannot be represented in a desktop entry.')
    # Keep ordinary paths unquoted: some xdg-mime generic resolvers have
    # historically misparsed a quoted executable. % is always a field-code
    # escape, including inside a quoted argument; %F is appended separately.
    if SAFE_EXECUTABLE.fullmatch(value):
        return value
    escaped = (value.replace('\\', '\\\\').replace('"', '\\"')
               .replace('`', '\\`').replace('$', '\\$').replace('%', '%%'))
    # Desktop Entry key values decode backslash escapes before Exec is parsed.
    # Preserve the Exec quoting escapes through that first decoding layer.
    return '"' + escaped.replace('\\', '\\\\') + '"'


def desktop_entry(launcher):
    command = desktop_exec_argument(launcher)
    # GIO checks the executable before expanding %% field-code escapes. A
    # literal percent in the executable path therefore needs a stable runner;
    # env receives the expanded path as an argument and executes it directly.
    if '%' in str(launcher):
        command = '/usr/bin/env ' + command
    return (
        '[Desktop Entry]\nType=Application\nName=Notation\n'
        'Comment=Write Markdown and Mermaid diagrams\n'
        f'Exec={command} %F\n'
        'MimeType=text/plain;text/markdown;text/x-markdown;\n'
        'Icon=local.notation.app\nTerminal=false\nCategories=Utility;TextEditor;\n'
        'StartupWMClass=notation\nStartupNotify=true\n'
    )


def main():
    root = Path(__file__).resolve().parent.parent
    platform = runpy.run_path(str(root / 'scripts/setup-macos.py'))
    try:
        platform['require_linux_x64']('The AppImage installer')
    except RuntimeError as error:
        raise SystemExit(str(error)) from error
    artifacts = sorted((root / 'src-tauri/target/release/bundle/appimage').glob('Notation_*.AppImage'))
    artifact = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else (artifacts[-1] if artifacts else None)
    if artifact is None or not artifact.is_file():
        raise SystemExit('Build first with npm run desktop:build, or pass an AppImage path.')

    app_dir = Path.home() / '.local/opt/notation'
    bin_dir = Path.home() / '.local/bin'
    data_dir = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share')))
    icon_dir = data_dir / 'icons/hicolor/64x64/apps'
    desktop_dir = data_dir / 'applications'
    for directory in (app_dir, bin_dir, icon_dir, desktop_dir):
        directory.mkdir(parents=True, exist_ok=True)

    staged = app_dir / 'Notation.AppImage.new'
    shutil.copyfile(artifact, staged)
    staged.chmod(0o755)
    staged.replace(app_dir / 'Notation.AppImage')
    shutil.copyfile(root / 'src-tauri/icons/icon.png', icon_dir / 'local.notation.app.png')

    launcher = bin_dir / 'notation'
    import shlex
    launcher.write_text('#!/bin/sh\nexec ' + shlex.quote(str(app_dir / 'Notation.AppImage')) + ' "$@"\n')
    launcher.chmod(0o755)
    desktop = desktop_dir / 'local.notation.app.desktop'
    desktop.write_text(desktop_entry(launcher))
    for command in ('desktop-file-validate', 'update-desktop-database'):
        if shutil.which(command):
            subprocess.run([command, str(desktop if command == 'desktop-file-validate' else desktop_dir)], check=True)
    print(f'Installed {app_dir / "Notation.AppImage"}')
    print(f'Launch with {launcher} or search for Notation in the application launcher.')


if __name__ == '__main__':
    main()
