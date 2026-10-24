#!/usr/bin/env python3
"""Packaged profile ownership, activation and crash recovery using disposable state.

No WebDriver session is needed: guarded MCP edits and SQLite establish that a
secondary launch cannot create a divergent writer. Existing user windows are
never closed, and process cleanup matches the exact disposable XDG profile.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time

from smoke import require
from tooling_smoke import McpStdio


def rpc(data: Path, name: str, arguments: dict | None = None):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(3)
        connection.connect(str(data / 'local.notation.app/agent.sock'))
        connection.sendall((json.dumps({'name': name, 'arguments': arguments or {}}) + '\n').encode())
        response = json.loads(connection.makefile().readline())
        require(response.get('ok'), f'MCP {name}: {response}')
        return response['value']


def wait_until(check, description: str, timeout: float = 30):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = check()
            if last:
                return last
        except (OSError, ValueError, AssertionError) as error:
            last = str(error)
        time.sleep(.1)
    raise AssertionError(f'Timed out waiting for {description}: {last}')


def owners(data: Path) -> list[int]:
    marker = b'XDG_DATA_HOME=' + os.fsencode(data)
    result = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if (entry / 'comm').read_text().strip() == 'notation' and marker in (entry / 'environ').read_bytes().split(b'\0'):
                result.append(int(entry.name))
        except (OSError, ProcessLookupError):
            pass
    return result


def stop_profile(data: Path):
    for pid in owners(data):
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


def active_pid() -> int | None:
    result = subprocess.run(['hyprctl', '-j', 'activewindow'], capture_output=True, text=True, check=True)
    return json.loads(result.stdout).get('pid')


def persisted(data: Path, tab_id: str) -> str | None:
    with sqlite3.connect(f'file:{data}/local.notation.app/state.sqlite3?mode=ro', uri=True) as database:
        row = database.execute('SELECT json FROM sessions WHERE id=1').fetchone()
        if row is None:
            return None
        session = json.loads(row[0])
    return next((tab['content'] for tab in session['tabs'] if tab['id'] == tab_id), None)


def run(app: Path, legacy_app: Path | None, check_focus: bool, check_windows: bool, output: Path):
    check_windows = check_windows or check_focus
    output.mkdir(parents=True, exist_ok=True)
    results = {'profile': 'disposable', 'checks': {}}
    processes = []
    profiles = []
    launch_times = {}
    with tempfile.TemporaryDirectory(prefix='nt-owner-') as temporary, (output / 'processes.log').open('wb') as log:
        root = Path(temporary)

        def environment(name):
            profile = root / name
            env = dict(os.environ)
            env.pop('TAURI_WEBVIEW_AUTOMATION', None)
            for key, folder in [('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache')]:
                path = profile / folder
                path.mkdir(parents=True, exist_ok=True)
                env[key] = str(path)
            profiles.append(profile / 'data')
            return env, profile / 'data'

        def launch(env, binary=app):
            started = time.monotonic()
            process = subprocess.Popen([str(binary)], env=env, stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            processes.append(process)
            launch_times[process.pid] = started
            return process

        def handed_off(process):
            try:
                code = process.wait(timeout=15)
            except subprocess.TimeoutExpired as error:
                raise AssertionError('Secondary stayed running instead of handing off to the owner') from error
            require(code == 0, f'Secondary failed to acknowledge activation (exit {code}); see processes.log')
            results.setdefault('observedHandoffExitSeconds', []).append(round(time.monotonic() - launch_times[process.pid], 3))

        try:
            env, data = environment('primary')
            launch(env)
            initial = wait_until(lambda: rpc(data, 'list_tabs'), 'primary MCP ready')
            primary_pids = owners(data)
            require(len(primary_pids) == 1, f'Expected one primary: {primary_pids}')
            primary_pid = primary_pids[0]
            tab_id = initial['activeTabId']
            old = rpc(data, 'read_tab', {'tabId': tab_id})['content']
            sentinel = '# One owner\n\nUnsaved buffer must survive another launch.\n'
            rpc(data, 'edit_document', {'tabId': tab_id, 'expectedContent': old, 'content': sentinel})
            wait_until(lambda: persisted(data, tab_id) == sentinel, 'sentinel recovery persisted')

            handed_off(launch(env))
            require(owners(data) == primary_pids, 'Second GUI owner appeared')
            require(rpc(data, 'read_tab', {'tabId': tab_id})['content'] == sentinel, 'Live buffer changed on activation')
            require(persisted(data, tab_id) == sentinel, 'Secondary replaced recovery state')
            results['checks']['secondaryPreservesLiveAndPersistedBuffer'] = True

            burst = [launch(env) for _ in range(3)]
            for process in burst:
                handed_off(process)
            require(owners(data) == primary_pids, 'Launch burst created another owner')
            results['checks']['threeSimultaneousSecondaries'] = True

            # A temporarily unresponsive owner still owns its profile. A new
            # process must fail, never assume it can replace that writer.
            os.kill(primary_pid, signal.SIGSTOP)
            try:
                stalled = launch(env)
                deadline = time.monotonic() + 20
                while stalled.poll() is None and time.monotonic() < deadline:
                    if check_windows:
                        clients = json.loads(subprocess.check_output(['hyprctl', '-j', 'clients'], text=True))
                        candidates = set(owners(data)) - {primary_pid}
                        require(not any(client.get('pid') in candidates for client in clients),
                                'Secondary created a window before ownership was decided')
                    time.sleep(.1)
                require(stalled.wait(timeout=1) != 0, 'Unresponsive owner produced a false successful handoff')
                results['checks']['noSecondaryWindowWhileOwnerPaused'] = True if check_windows else 'unrun: requires --check-windows or --check-focus'
                require(owners(data) == primary_pids, 'Unresponsive owner was duplicated')
            finally:
                os.kill(primary_pid, signal.SIGCONT)
            require(rpc(data, 'read_tab', {'tabId': tab_id})['content'] == sentinel, 'Failed handoff changed the live buffer')
            results['checks']['unresponsiveOwnerFailsClosed'] = True

            alias = root / 'alias'
            alias.symlink_to(data, target_is_directory=True)
            alias_env = {**env, 'XDG_DATA_HOME': str(alias)}
            profiles.append(alias)
            handed_off(launch(alias_env))
            require(not owners(alias), 'Canonical profile alias created another owner')
            results['checks']['canonicalProfileAlias'] = True

            other_env, other_data = environment('independent')
            launch(other_env)
            wait_until(lambda: rpc(other_data, 'list_tabs'), 'independent profile ready')
            require(len(owners(other_data)) == 1 and owners(data) == primary_pids, 'Independent profiles did not coexist')
            results['checks']['independentProfilesCoexist'] = True
            if check_focus:
                wait_until(lambda: active_pid() in owners(other_data), 'independent window focused')
                handed_off(launch(env))
                try:
                    wait_until(lambda: active_pid() == primary_pid, 'secondary activates original window', timeout=5)
                finally:
                    results['focusObservation'] = {'expectedOwnerPid': primary_pid, 'activePid': active_pid(),
                                                   'independentOwnerPids': owners(other_data)}
                results['checks']['focusReturnsToOriginalWindow'] = True
            else:
                results['checks']['focusReturnsToOriginalWindow'] = 'unrun: requires --check-focus and Hyprland'

            mcp = McpStdio([str(app), '--mcp', '--socket', str(data / 'local.notation.app/agent.sock')], env)
            try:
                mcp.request('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'instance-smoke', 'version': '1'}})
                mcp.notify('notifications/initialized')
                require(mcp.call('read_tab', {'tabId': tab_id})['content'] == sentinel, 'MCP worker was intercepted by GUI handoff')
            finally:
                mcp.close()
            results['checks']['mcpWorkerBypassesGuiHandoff'] = True

            request = {'id': 'ownership-worker', 'code': 'return {value: 6 * 7};', 'cwd': None,
                       'document': {'name': 'probe.md', 'path': None, 'text': '', 'selection': '', 'from': 0, 'to': 0}}
            script = subprocess.run([str(app), '--script-worker'], input=json.dumps(request),
                                    env=env, capture_output=True, text=True, timeout=20)
            response = json.loads(script.stdout)
            require(script.returncode == 0 and response.get('ok') and response.get('result') == {'value': 42},
                    f'Script worker was intercepted or failed: {script.stderr} {response}')
            results['checks']['scriptWorkerBypassesGuiHandoff'] = True

            engine_dir = root / 'engine'
            engine_dir.mkdir()
            engine_request = {'program': '/usr/bin/printf', 'arguments': ['ownership-worker-ok'],
                              'cwd': str(engine_dir), 'input': None,
                              'read_paths': ['/usr/bin/printf', '/etc/ld.so.cache'], 'environment': {}}
            engine = subprocess.run([str(app), '--engine-worker'], input=json.dumps(engine_request),
                                    env=env, capture_output=True, text=True, timeout=20)
            require(engine.returncode == 0 and engine.stdout == 'ownership-worker-ok',
                    f'Engine worker was intercepted or failed: {engine.returncode} {engine.stderr}')
            results['checks']['engineWorkerBypassesGuiHandoff'] = True

            # Crash during an in-flight handoff: the waiting process must
            # acquire the released lock, rather than fail or become a rival.
            os.kill(primary_pid, signal.SIGSTOP)
            try:
                waiting = launch(env)
                wait_until(lambda: len(owners(data)) == 2, 'handoff process waiting')
                time.sleep(.3)
                require(waiting.poll() is None, 'Handoff completed despite paused owner')
                os.kill(primary_pid, signal.SIGKILL)
            finally:
                try:
                    os.kill(primary_pid, signal.SIGCONT)
                except ProcessLookupError:
                    pass
            wait_until(lambda: primary_pid not in owners(data), 'crashed test owner gone', timeout=10)
            recovered = wait_until(lambda: rpc(data, 'list_tabs'), 'replacement owner ready')
            require(recovered['activeTabId'] == tab_id, 'Crash restart lost the active tab')
            require(rpc(data, 'read_tab', {'tabId': tab_id})['content'] == sentinel, 'Crash restart lost the persisted buffer')
            require(len(owners(data)) == 1, 'Crash restart has duplicate owners')
            handed_off(launch(env))
            results['checks']['crashDuringHandoffReacquiresAndRestoresDraft'] = True

            cold_env, cold_data = environment('cold')
            cold = [launch(cold_env) for _ in range(2)]
            wait_until(lambda: rpc(cold_data, 'list_tabs'), 'simultaneous cold launch ready')
            wait_until(lambda: sum(process.poll() == 0 for process in cold) == 1, 'one cold launcher hands off', timeout=15)
            require(len(owners(cold_data)) == 1, 'Cold starts created two owners')
            results['checks']['simultaneousColdStarts'] = True

            if legacy_app:
                legacy_env, legacy_data = environment('legacy')
                launch(legacy_env, legacy_app)
                wait_until(lambda: rpc(legacy_data, 'list_tabs'), 'legacy owner ready')
                legacy_pids = owners(legacy_data)
                refused = launch(legacy_env)
                require(refused.wait(timeout=15) != 0, 'New release silently competed with a legacy owner')
                require(owners(legacy_data) == legacy_pids, 'Legacy owner was replaced or duplicated')
                require(bool(rpc(legacy_data, 'list_tabs')), 'Legacy MCP endpoint was damaged')
                results['checks']['legacyOwnerRefusedWithoutMutation'] = True
            else:
                results['checks']['legacyOwnerRefusedWithoutMutation'] = 'unrun: --legacy-app not supplied'

            results['complete'] = True
            print('PASS: packaged profile ownership, handoff, isolation, MCP and recovery', flush=True)
        except Exception as error:
            results.update(complete=False, error=str(error))
            raise
        finally:
            (output / 'report.json').write_text(json.dumps(results, indent=2))
            for profile in profiles:
                stop_profile(profile)
            for process in processes:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=3)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--legacy-app', type=Path)
    parser.add_argument('--check-focus', action='store_true', help='Require focus transfer (compositor must permit activation); also checks windows')
    parser.add_argument('--check-windows', action='store_true', help='Check no secondary window appears while the owner is paused (Hyprland)')
    parser.add_argument('--output', type=Path, default=Path('test-results/native-instance'))
    args = parser.parse_args()
    run(args.app.resolve(), args.legacy_app.resolve() if args.legacy_app else None, args.check_focus, args.check_windows, args.output.resolve())
