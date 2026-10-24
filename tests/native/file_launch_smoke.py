#!/usr/bin/env python3
"""Open actual local files through cold/warm CLI and a generated desktop entry.

Uses disposable XDG profiles and guarded MCP reads to verify frontend buffers.
The installer and MIME configuration run under a temporary HOME, never the
user's real desktop settings. Cleanup matches only those isolated profiles.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from instance_smoke import owners, rpc, wait_until
from smoke import require


def run(app: Path, output: Path):
    output.mkdir(parents=True, exist_ok=True)
    report = {'checks': {}}
    processes = []
    profiles = []
    with tempfile.TemporaryDirectory(prefix='nt-files-') as temporary, (output / 'processes.log').open('wb') as log:
        root = Path(temporary)
        files = root / 'files'; files.mkdir()
        first = files / 'First note ü.txt'; first.write_text('Plain text from a file manager.\n', encoding='utf-8')
        second = files / 'Second note.md'; second.write_text('# Second note\n', encoding='utf-8')
        literal = files / 'literal $(touch NOTATION_EXECUTED) & ü.txt'; literal.write_text('Literal filename.\n', encoding='utf-8')
        alias = files / 'Alias.txt'; alias.symlink_to(first)
        originals = {path: path.read_bytes() for path in [first, second, literal]}

        def environment(name):
            env = dict(os.environ); env.pop('TAURI_WEBVIEW_AUTOMATION', None)
            for key, folder in [('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache')]:
                path = root / name / folder; path.mkdir(parents=True, exist_ok=True); env[key] = str(path)
            data = root / name / 'data'; profiles.append(data)
            return env, data

        def launch(env, args, cwd=files):
            process = subprocess.Popen([str(app), *map(str, args)], cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            processes.append(process)
            return process

        def tabs_with(data, expected):
            value = rpc(data, 'list_tabs')
            paths = {tab['path'] for tab in value['tabs']}
            return value if {str(path.resolve()) for path in expected} <= paths else None

        def tab_for(data, path):
            value = wait_until(lambda: tabs_with(data, [path]), f'opened {path.name}')
            matches = [tab for tab in value['tabs'] if tab['path'] == str(path.resolve())]
            require(len(matches) == 1, f'Duplicate canonical file tab: {matches}')
            return matches[0]

        def handed_off(process):
            require(process.wait(timeout=15) == 0, 'File request was not accepted by the owner; see processes.log')

        try:
            env, data = environment('cli')
            launch(env, [first.name, second])
            opened = wait_until(lambda: tabs_with(data, [first, second]), 'cold-launch file buffers')
            primary = owners(data); require(len(primary) == 1, f'Expected one GUI owner: {primary}')
            for path in [first, second]:
                tab = tab_for(data, path)
                require(rpc(data, 'read_tab', {'tabId': tab['id']})['content'] == path.read_text(), 'Cold-launch content mismatch')
            require(tab_for(data, second)['active'], 'Cold launch did not select the requested document')
            report['checks']['coldRelativeAndMultipleFiles'] = True

            tab = tab_for(data, first)
            dirty = 'Unsaved text must not be replaced by the file on disk.\n'
            rpc(data, 'edit_document', {'tabId': tab['id'], 'expectedContent': first.read_text(), 'content': dirty})
            handed_off(launch(env, [literal, alias]))
            wait_until(lambda: tabs_with(data, [literal, first]), 'warm-launch file buffers')
            require(owners(data) == primary, 'Warm file launch created another GUI owner')
            same = tab_for(data, first)
            require(same['id'] == tab['id'] and rpc(data, 'read_tab', {'tabId': same['id']})['content'] == dirty, 'Reopen replaced an unsaved buffer')
            require(same['active'], 'Reopening an existing file did not select it')
            special = tab_for(data, literal)
            require(rpc(data, 'read_tab', {'tabId': special['id']})['content'] == literal.read_text(), 'Literal filename was altered')
            require(not (files / 'NOTATION_EXECUTED').exists(), 'Filename text was executed')
            report['checks']['warmMultipleFilesPreserveDirtyCanonicalTab'] = True
            report['checks']['spacesUnicodeAndShellCharactersRemainLiteral'] = True

            dash = files / '--dash.txt'; dash.write_text('Explicit end of options.\n')
            originals[dash] = dash.read_bytes()
            handed_off(launch(env, ['--', dash.name]))
            wait_until(lambda: tabs_with(data, [dash]), 'dash-prefixed filename')
            require(tab_for(data, dash)['active'], 'Dash-prefixed file did not become active')
            report['checks']['explicitEndOfOptions'] = True

            startup_env, startup_data = environment('startup')
            starts = [launch(startup_env, [first]), launch(startup_env, [second])]
            wait_until(lambda: tabs_with(startup_data, [first, second]), 'simultaneous startup request delivery')
            wait_until(lambda: sum(process.poll() == 0 for process in starts) == 1, 'one startup launcher exits')
            require(len(owners(startup_data)) == 1, 'Startup file requests created two owners')
            report['checks']['requestsDuringStartupAreDelivered'] = True

            # Generate the actual desktop entry using the installer in a
            # disposable HOME; prove MIME resolution before using xdg-open.
            desktop_env, desktop_data = environment('desktop')
            home = root / 'home'; home.mkdir(); desktop_env['HOME'] = str(home)
            installer = Path(__file__).resolve().parents[2] / 'scripts/install-desktop.py'
            subprocess.run([sys.executable, str(installer), str(app)], env=desktop_env, stdout=log, stderr=log, check=True, timeout=30)
            subprocess.run(['xdg-mime', 'default', 'local.notation.app.desktop', 'text/plain'], env=desktop_env, stdout=log, stderr=log, check=True, timeout=10)
            default = subprocess.check_output(['xdg-mime', 'query', 'default', 'text/plain'], env=desktop_env, text=True, timeout=10).strip()
            require(default == 'local.notation.app.desktop', f'Text default resolved incorrectly: {default}')
            # Generic xdg-open may remain attached to the cold GUI process;
            # verify its actual document instead of requiring early shell exit.
            opener = subprocess.Popen(['xdg-open', str(first)], env=desktop_env, cwd=files, stdout=log, stderr=log, start_new_session=True)
            processes.append(opener)
            wait_until(lambda: tabs_with(desktop_data, [first]), 'xdg-open cold text document')
            require(opener.poll() in (None, 0), 'xdg-open failed before opening the text document')
            desktop_owner = owners(desktop_data); require(len(desktop_owner) == 1, 'Desktop cold launch owner missing')
            entry = desktop_data / 'applications/local.notation.app.desktop'
            subprocess.run(['gio', 'launch', str(entry), str(literal), str(second)], env=desktop_env, cwd=files, stdout=log, stderr=log, check=True, timeout=15)
            wait_until(lambda: tabs_with(desktop_data, [literal, second]), 'desktop entry forwards multiple files to existing owner')
            require(owners(desktop_data) == desktop_owner, 'Desktop warm launch created a second owner')
            require(tab_for(desktop_data, second)['active'], 'Desktop launch did not select its last requested file')
            report['checks']['installedDesktopEntryAndTextMimeColdAndWarm'] = True
            require(all(path.read_bytes() == content for path, content in originals.items()), 'Launching modified a source file')
            report['checks']['sourceFilesUnchanged'] = True
            report['complete'] = True
            print('PASS: cold/warm CLI, canonical unsaved buffers, startup races, literal filenames, desktop entry and text MIME opening', flush=True)
        except Exception as error:
            report.update(complete=False, error=str(error)); raise
        finally:
            (output / 'report.json').write_text(json.dumps(report, indent=2))
            for data in profiles:
                for pid in owners(data):
                    try: os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError: pass
            for process in processes:
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    try: process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill(); process.wait(timeout=3)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('test-results/native-file-launch'))
    args = parser.parse_args()
    run(args.app.resolve(), args.output.resolve())
