#!/usr/bin/env python3
"""Verify file-launch errors and agent-permission independence in packaged WebKit."""
import argparse
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import tempfile
import time
import smoke
from instance_smoke import owners, rpc, wait_until
from media_graph_smoke import stop_profile_apps
from responsive_smoke import command


def run(app: Path, output: Path):
    smoke.assert_ports_available(); output.mkdir(parents=True, exist_ok=True)
    client = smoke.Client(smoke.BASE_URL); driver = None; secondary = None; database_lock = None
    with tempfile.TemporaryDirectory(prefix='nt-file-ui-') as temporary:
        root = Path(temporary)
        env = {**os.environ, 'TAURI_WEBVIEW_AUTOMATION': 'true'}
        for key, name in [('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache')]:
            (root / name).mkdir(); env[key] = str(root / name)
        child_env = dict(env); child_env.pop('TAURI_WEBVIEW_AUTOMATION', None)
        with (output / 'driver.log').open('wb') as log:
            try:
                driver = subprocess.Popen([str(smoke.DRIVER), '--port', str(smoke.DRIVER_PORT), '--native-port', str(smoke.NATIVE_PORT), '--native-driver', str(smoke.WEBDRIVER)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                smoke.wait_for_driver(driver, output / 'driver.log'); client.create_session(app)
                smoke.wait_for(client, "document.querySelector('main.app')", 'packaged UI')
                command(client, 'Settings')
                client.element_command(client.find('[data-section="Agents"]'), '/click')
                client.element_command(client.find('//label[contains(normalize-space(.), "Agent edits enabled")]', using='xpath'), '/click')
                client.element_command(smoke.button(client, 'Close settings'), '/click')
                smoke.wait_for(client, "document.querySelector('.database-state')?.dataset.state==='saved'", 'agent setting persisted')
                status = client.execute_async("const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke('agent_status').then(done)")
                smoke.require(status['editsEnabled'] is False, 'Agent edits did not turn off')
                missing = root / 'missing requested.txt'
                too_big = root / 'too big.txt'
                with too_big.open('wb') as handle: handle.truncate(4 * 1024 * 1024 + 1)
                invalid = root / 'invalid utf8.txt'; invalid.write_bytes(b'\xff\xfe')
                valid = root / 'still opens.txt'; valid.write_text('File-manager opening does not depend on agents.\n')
                result = subprocess.run([str(app), str(missing), str(too_big), str(invalid), str(valid)], env=child_env, stdout=log, stderr=log, timeout=15)
                smoke.require(result.returncode == 0, 'Launch request was not accepted')
                def opened():
                    tabs = rpc(root / 'data', 'list_tabs')
                    return next((tab for tab in tabs['tabs'] if tab['path'] == str(valid) and tab['active']), None)
                tab = wait_until(opened, 'valid file selected with agents disabled')
                smoke.require(rpc(root / 'data', 'read_tab', {'tabId': tab['id']})['content'] == valid.read_text(), 'Opened file content mismatch')
                for path in [missing, too_big, invalid]:
                    smoke.wait_for(client, "Array.from(document.querySelectorAll('[role=alert]')).some(e => e.textContent.includes("+json.dumps(path.name)+"))", 'visible launch error for '+path.name)
                smoke.wait_for(client, "document.querySelector('.preview-scroll .markdown-body')?.textContent.includes('File-manager opening does not depend on agents.')", 'launched document preview')
                client.screenshot(output / 'launch-errors.png')
                # Hold a real SQLite write lock so graceful close waits for its
                # pending draft while a second process asks to open a file.
                command(client, 'Source')
                pending_text = 'Unsaved close/handoff fixture.\n'
                smoke.replace_editor_text(client, smoke.active_editor(client), pending_text)
                smoke.wait_for(client, "document.querySelector('.database-state')?.dataset.state === 'saved'", 'saved state before locking')
                database_lock = sqlite3.connect(root / 'data/local.notation.app/state.sqlite3', timeout=0, isolation_level=None)
                database_lock.execute('BEGIN IMMEDIATE')
                client.send_keys(smoke.active_editor(client), '!')
                pending_text += '!'
                client.execute("setTimeout(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'}),50);return true")
                smoke.wait_for(client, "document.querySelector('main.app').hasAttribute('inert') && document.querySelector('dialog.close-recovery-dialog')?.open === true", 'close recovery decision', timeout=15)
                client.screenshot(output / 'close-recovery.png')
                during_close = root / 'opened after close.txt'; during_close.write_text('The next owner receives this request.\n')
                secondary = subprocess.Popen([str(app), str(during_close)], env=child_env, stdout=log, stderr=log, start_new_session=True)
                wait_until(lambda: secondary.poll() is not None or len(owners(root / 'data')) > 1, 'secondary begins handoff')
                time.sleep(.5)
                smoke.require(secondary.poll() is None, 'Closing owner acknowledged work that cannot be processed before exit')
                database_lock.execute('COMMIT'); database_lock.close(); database_lock = None
                client.element_command(smoke.button(client, 'Keep open'), '/click')
                smoke.require(secondary.wait(timeout=10) == 0, 'Canceled close did not reopen file admission')
                def selected(path):
                    tabs = rpc(root / 'data', 'list_tabs')
                    return next((item for item in tabs['tabs'] if item['path'] == str(path) and item['active']), None)
                wait_until(lambda: selected(during_close), 'file opens after canceling close')
                smoke.wait_for(client, "document.querySelector('.database-state')?.dataset.state === 'saved'", 'recovered draft persisted')
                # Establish the native closing gate before the real close to
                # make the otherwise tiny final-exit handoff race deterministic.
                client.execute("return window.__TAURI_INTERNALS__.invoke('set_launch_closing',{closing:true})")
                after_exit = root / 'opened by next owner.txt'; after_exit.write_text('Delivered after the previous owner exits.\n')
                secondary = subprocess.Popen([str(app), str(after_exit)], env=child_env, stdout=log, stderr=log, start_new_session=True)
                wait_until(lambda: secondary.poll() is not None or len(owners(root / 'data')) > 1, 'next launcher begins handoff')
                time.sleep(.25)
                smoke.require(secondary.poll() is None, 'Closing gate accepted a new request')
                client.execute("setTimeout(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'}),50);return true")
                wait_until(lambda: selected(after_exit), 'waiting launcher acquires ownership and opens its file')
                restored = rpc(root / 'data', 'list_tabs')
                saved = next(item for item in restored['tabs'] if item['path'] == str(valid))
                smoke.require(rpc(root / 'data', 'read_tab', {'tabId': saved['id']})['content'] == pending_text, 'Close handoff lost the flushed unsaved buffer')
                smoke.require(len(owners(root / 'data')) == 1, 'Close handoff created duplicate owners')
                (output / 'report.json').write_text(json.dumps({'agentEditsDisabled': True, 'validFileSelected': True, 'missingLargeAndInvalidUtf8ErrorsVisible': True, 'cancelCloseReopensAdmissionWithoutLosingDraft': True, 'closeHandoffRestoresPendingDraftAndOpensFile': True}, indent=2))
                print('PASS: launch ignores agent-edit permission, selects valid file, and displays every failed-file error', flush=True)
            finally:
                if database_lock:
                    database_lock.rollback(); database_lock.close()
                if client.session_id:
                    try: client.quit()
                    except smoke.WebDriverError: pass
                stop_profile_apps(root / 'data')
                if secondary:
                    try: secondary.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        secondary.terminate(); secondary.wait(timeout=5)
                if driver and driver.poll() is None:
                    os.killpg(driver.pid, signal.SIGTERM)
                    try: driver.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(driver.pid, signal.SIGKILL); driver.wait(timeout=5)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('test-results/native-file-launch-ui'))
    args = parser.parse_args()
    run(args.app.resolve(), args.output.resolve())
