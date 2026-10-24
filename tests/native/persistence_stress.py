#!/usr/bin/env python3
"""Measure real packaged persistence IPC with disposable state, not mocked IPC."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import tempfile
import threading
import time

import smoke
from lightweight_stress import resources
from media_graph_smoke import stop_profile_apps


def run(app, output, legacy_summary=False):
    smoke.assert_ports_available()
    output.mkdir(parents=True, exist_ok=True)
    with app.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    report = {'appSha256': digest, 'legacySummary': legacy_summary, 'phases': {}, 'checks': {}}
    client = smoke.Client(smoke.BASE_URL)
    driver = None
    samples = []
    stop = threading.Event()
    phase_name = 'startup'
    with tempfile.TemporaryDirectory(prefix='nt-persist-', dir='/tmp') as temporary:
        root = Path(temporary)
        data = root / 'data'
        env = {**os.environ, 'TAURI_WEBVIEW_AUTOMATION': 'true'}
        for variable, name in [('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache')]:
            (root / name).mkdir()
            env[variable] = str(root / name)

        def sample():
            while not stop.wait(0.05):
                snapshot = resources(data)
                snapshot['phase'] = phase_name
                samples.append(snapshot)

        sampler = threading.Thread(target=sample, daemon=True)
        with (output / 'driver.log').open('wb') as log:
            try:
                driver = subprocess.Popen([str(smoke.DRIVER), '--port', str(smoke.DRIVER_PORT), '--native-port', str(smoke.NATIVE_PORT), '--native-driver', str(smoke.WEBDRIVER)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                smoke.wait_for_driver(driver, output / 'driver.log')
                sampler.start()
                client.create_session(app)
                smoke.wait_for(client, 'document.querySelector(".database-state")?.dataset.state === "saved"', 'initial persistence')
                # The production command receives real structured IPC. Generate
                # fixtures inside WebKit so WebDriver does not transport buffers.
                client.execute('''
const content = 'Text with "quotes", \\u005cslashes and Unicode café.\\n'.repeat(12000).slice(0, 512 * 1024);
window.__persistenceFixture = {activeTabId: 'profile-0', updatedAt: Date.now(), tabs:
  Array.from({length: 8}, (_, i) => ({id: 'profile-' + i, name: 'profile-' + i + '.txt', path: null,
    content, savedContent: content, savedName: 'profile-' + i + '.txt',
    selection: {anchor: 0, head: 0}, updatedAt: Date.now(), hemingway: false}))};
return true;
''')

                def measure(name, script, arguments=None):
                    nonlocal phase_name
                    phase_name = name
                    before = resources(data)
                    result = client.execute_async('''
const done = arguments[arguments.length - 1];
(async () => {''' + script + '''})().then(value => done({value}), error => done({error: String(error)}));
''', arguments or [])
                    smoke.require(isinstance(result, dict) and 'error' not in result, f'{name}: {result}')
                    after = resources(data)
                    report['phases'][name] = {'result': result['value'], 'before': before, 'after': after}
                    phase_name = 'settle'
                    time.sleep(1)

                measure('persist-12', '''
const state = window.__persistenceFixture;
const durations = [];
for (let i = 0; i < 12; i++) {
  state.updatedAt = Date.now();
  state.tabs[0].selection = {anchor: i, head: i};
  state.tabs[0].content = state.tabs[0].savedContent + '\\nedit-' + i;
  const start = performance.now();
  await window.__TAURI_INTERNALS__.invoke('persist_state', {state: {session: state, draft: state.tabs[0]}});
  durations.push(performance.now() - start);
}
return {durationsMs: durations, lastRequestChars: JSON.stringify({state: {session: state, draft: state.tabs[0]}}).length};
''')
                summary_command = 'bootstrap_state' if legacy_summary else 'metadata_summary'
                measure('summary-20', '''
const durations = []; let responseChars = 0;
for (let i = 0; i < 20; i++) {
  const start = performance.now();
  const value = await window.__TAURI_INTERNALS__.invoke(arguments[0]);
  durations.push(performance.now() - start);
  responseChars += JSON.stringify(value).length;
}
return {durationsMs: durations, responseChars};
''', [summary_command])
                measure('invalid-rollback', '''
const invalid = {...window.__persistenceFixture, activeTabId: 'missing'};
try {
  await window.__TAURI_INTERNALS__.invoke('persist_state', {state: {session: invalid, settings: {persistenceSentinel: 'must-not-commit'}}});
  throw new Error('Invalid session was accepted');
} catch (error) {
  if (!String(error).includes('Session active tab is missing')) throw error;
}
return {rejected: true};
''')
                database = data / 'local.notation.app/state.sqlite3'
                with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as connection:
                    session = json.loads(connection.execute('SELECT json FROM sessions WHERE id=1').fetchone()[0])
                    draft = json.loads(connection.execute('SELECT json FROM drafts WHERE id=1').fetchone()[0])
                    settings = json.loads(connection.execute('SELECT json FROM settings WHERE id=1').fetchone()[0])
                smoke.require(len(session['tabs']) == 8 and session['tabs'][0]['content'].endswith('\nedit-11'), 'Latest edit was not persisted')
                smoke.require(session['tabs'][0]['content'] == draft['content'], 'Active draft and session diverged')
                smoke.require('persistenceSentinel' not in settings, 'Rejected update partially committed')
                report['checks']['latestEditAndRollback'] = True
                # Reload the actual app: verify the UI hydrates the persisted
                # snapshot, then edit through CodeMirror and verify SQLite again.
                phase_name = 'ui-reload'
                client.execute('location.reload(); return true')
                smoke.wait_for(client, 'document.querySelectorAll(".document-tab").length === 8', 'restored tabs')
                smoke.wait_for(client, 'document.querySelector(".database-state")?.dataset.state === "saved"', 'restored session persistence')
                editor = smoke.active_editor(client)
                # Append through normal keyboard input without selecting a
                # half-megabyte document through WebKitWebDriver.
                marker = 'Unsaved persistence regression'
                edited_text = session['tabs'][0]['content'] + marker
                client.element_command(editor, '/click')
                client.send_keys(editor, '\ue009\ue010\ue000')
                client.send_keys(editor, marker)
                smoke.wait_for(client, 'document.querySelector(".database-state")?.dataset.state === "saved"', 'editor persistence')
                deadline = time.monotonic() + 10
                while True:
                    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as connection:
                        stored = json.loads(connection.execute('SELECT json FROM sessions WHERE id=1').fetchone()[0])
                    if stored['tabs'][0]['content'] == edited_text or time.monotonic() >= deadline:
                        break
                    time.sleep(0.1)
                smoke.require(stored['tabs'][0]['content'] == edited_text, 'UI edit did not reach the native session')
                smoke.require(stored['tabs'][0]['savedContent'] == session['tabs'][0]['savedContent'], 'UI edit lost the saved baseline')
                client.execute('location.reload(); return true')
                smoke.wait_for(client, 'document.querySelectorAll(".document-tab").length === 8', 'edited session reload')
                smoke.wait_for(client, 'document.querySelector(".cm-content")?.textContent.includes("Unsaved persistence regression")', 'unsaved text restored')
                report['checks']['reloadAndUnsavedEdit'] = True
                report['checks']['passed'] = True
                client.screenshot(output / 'restored.png')
            except Exception as error:
                report['error'] = str(error)
                raise
            finally:
                stop.set()
                if sampler.is_alive():
                    sampler.join(timeout=5)
                for name, value in report['phases'].items():
                    matched = [sample for sample in samples if sample['phase'] == name]
                    value['sampleCount'] = len(matched)
                    value['peakPssKiB'] = max(item['pssKiB'] for item in [value['before'], value['after'], *matched])
                (output / 'process-samples.json').write_text(json.dumps(samples, indent=2))
                (output / 'report.json').write_text(json.dumps(report, indent=2))
                try:
                    if client.session_id:
                        client.quit()
                finally:
                    stop_profile_apps(data)
                    if driver and driver.poll() is None:
                        os.killpg(driver.pid, signal.SIGTERM)
                        try:
                            driver.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            os.killpg(driver.pid, signal.SIGKILL)
                            driver.wait(timeout=5)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--legacy-summary', action='store_true', help='Compare the old full-bootstrap summary path')
    arguments = parser.parse_args()
    run(arguments.app.resolve(), arguments.output.resolve(), arguments.legacy_summary)
