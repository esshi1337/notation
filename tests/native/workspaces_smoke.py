#!/usr/bin/env python3
"""Exercise virtual workspaces in the packaged native app with disposable files."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import smoke
from sqlite_smoke import invoke
from responsive_smoke import command
from instance_smoke import owners, wait_until


def click(client: smoke.Client, label: str) -> None:
    client.element_command(client.find('//button[normalize-space(.)=' + json.dumps(label) + ']', using='xpath'), '/click')


def ready(client: smoke.Client) -> None:
    smoke.wait_for(client, "document.querySelector('[aria-label=\"Active workspace\"]') && !document.querySelector('[aria-label=\"Active workspace\"]').disabled", 'workspace operation complete')


def create(client: smoke.Client, name: str) -> str:
    smoke.fill_control(client, '[aria-label="Workspace name"]', name)
    click(client, 'Create workspace')
    smoke.wait_for(client, 'document.querySelector(\'[aria-label="Active workspace"] option:checked\')?.textContent === ' + json.dumps(name), 'workspace ' + name)
    ready(client)
    return client.execute('return document.querySelector(\'[aria-label="Active workspace"]\').value')


def add(client: smoke.Client, path: Path) -> None:
    client.execute("const details=document.querySelector('.workspace-panel details'); details.open=true")
    smoke.fill_control(client, '[aria-label="File reference path"]', str(path))
    click(client, 'Add file reference')
    smoke.wait_for(client, 'Array.from(document.querySelectorAll(".workspace-reference")).some(e => e.innerText.includes(' + json.dumps(str(path)) + '))', 'file reference added')
    ready(client)


def select(client: smoke.Client, identity: str) -> None:
    client.execute("const s=document.querySelector('[aria-label=\"Active workspace\"]');s.value=arguments[0];s.dispatchEvent(new Event('change',{bubbles:true}))", [identity])
    ready(client)
    smoke.wait_for(client, 'JSON.parse(localStorage.getItem("notation.session")).activeWorkspaceId === ' + json.dumps(identity), 'workspace view persisted')


def open_note(client: smoke.Client, name: str) -> None:
    smoke.wait_for(client, 'document.querySelector(' + json.dumps('[aria-label="Open note: ' + name + '"]') + ')', 'indexed note ' + name)
    client.element_command(client.find('[aria-label="Open note: ' + name + '"]'), '/click')
    smoke.wait_for_active_tab(client, name)


def run(app: Path) -> None:
    smoke.assert_ports_available()
    output = Path(__file__).resolve().parents[2] / 'test-results/native-workspaces'
    output.mkdir(parents=True, exist_ok=True)
    client = smoke.Client(smoke.BASE_URL)
    driver = None
    with tempfile.TemporaryDirectory(prefix='notation-workspaces-') as temporary:
        root = Path(temporary)
        first = root / 'documents' / 'research'; first.mkdir(parents=True)
        second = root / 'elsewhere' / 'writing'; second.mkdir(parents=True)
        shared = first / 'shared.md'; shared.write_text('# Shared\n\nOriginal content.\n')
        distant = second / 'distant.md'; distant.write_text('# Distant\n\nUnique distant marker.\n')
        secret = second / 'unreferenced.md'; secret.write_text('# Outside\n\nMust not be indexed.\n')
        originals = {path: path.read_bytes() for path in [shared, distant, secret]}
        env = {**os.environ, 'TAURI_WEBVIEW_AUTOMATION': 'true'}
        for key, name in [('XDG_DATA_HOME','data'),('XDG_CONFIG_HOME','config'),('XDG_CACHE_HOME','cache')]:
            path = root / name; path.mkdir(); env[key] = str(path)
        log_path = root / 'driver.log'
        with log_path.open('wb') as log:
            try:
                driver = subprocess.Popen([str(smoke.DRIVER),'--port',str(smoke.DRIVER_PORT),'--native-port',str(smoke.NATIVE_PORT),'--native-driver',str(smoke.WEBDRIVER)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                smoke.wait_for_driver(driver, log_path)
                client.create_session(app)
                smoke.wait_for(client, "document.querySelector('main.app')", 'packaged UI')
                smoke.require('tauri' in client.execute('return location.href'), 'Expected packaged application')
                command(client, 'Workspace')
                research_id = create(client, 'Research')
                add(client, shared); add(client, distant)
                results = invoke(client, 'search_workspace', {'query':'', 'limit':50})
                smoke.require({row['path'] for row in results} == {str(shared),str(distant)}, f'Incorrect membership index: {results}')
                listing = invoke(client, 'list_directory', {'path':None})
                smoke.require({row['path'] for row in listing['entries']} == {str(shared),str(distant)}, 'Explorer escaped file references')
                open_note(client, 'shared.md')
                command(client, 'Source')
                changed = '# Shared\n\nUnsaved edit shared across workspaces.\n'
                smoke.replace_editor_text(client, smoke.active_editor(client), changed)
                writing_id = create(client, 'Writing')
                add(client, shared)
                open_note(client, 'shared.md')
                smoke.require(smoke.editor_text(client) == changed, 'Opening shared file lost unsaved edits')
                command(client, 'Live Preview')
                select(client, research_id)
                smoke.require(smoke.editor_text(client) == changed, 'Switching back lost shared edits')
                smoke.require('Source' in client.execute("return document.querySelector('[aria-label=\"Layout\"]').textContent"), 'Research layout was not restored')
                select(client, writing_id)
                smoke.require('Live' in client.execute("return document.querySelector('[aria-label=\"Layout\"]').textContent"), 'Writing layout was not restored')
                smoke.require(all(path.read_bytes() == content for path,content in originals.items()), 'Workspace actions modified files on disk')
                results = invoke(client, 'search_workspace', {'query':'distant', 'limit':50})
                smoke.require(results == [], 'Search leaked notes from the other workspace')
                session = json.loads(client.execute('return localStorage.getItem("notation.session")'))
                smoke.require(len([tab for tab in session['tabs'] if tab.get('path') == str(shared)]) == 1, 'Shared file has duplicate buffers')
                client.screenshot(output / 'shared-file.png')
                # Flush through the native close handler, then reopen the same disposable profile.
                smoke.wait_for(client, "document.querySelector('.database-state')?.dataset.state === 'saved'", 'session saved')
                smoke.require(len(owners(root / 'data')) == 1, 'Expected one isolated owner before restart')
                # Ending WebDriver alone can leave the GUI process alive. Ask
                # Tauri to close so its pending-state handler runs, then prove
                # that ownership is released before starting the next session.
                client.execute("setTimeout(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', {label:'main'}), 50); return true")
                wait_until(lambda: not owners(root / 'data'), 'graceful workspace owner exit', timeout=15)
                try:
                    client.quit()
                except smoke.WebDriverError:
                    pass  # The native close may already have ended the session.
                client.create_session(app)
                smoke.wait_for(client, "document.querySelector('main.app')", 'restart')
                smoke.require('Live' in client.execute("return document.querySelector('[aria-label=\"Layout\"]').textContent"), 'Restart lost Writing layout')
                command(client, 'Source')
                smoke.require(smoke.editor_text(client) == changed, 'Restart lost shared draft')
                smoke.require(client.execute('return document.querySelector(\'[aria-label="Active workspace"] option:checked\').textContent') == 'Writing', 'Restart lost selected workspace')
                command(client, 'Workspace')
                select(client, research_id)
                smoke.require('Source' in client.execute("return document.querySelector('[aria-label=\"Layout\"]').textContent"), 'Restart lost independent layout')
                # Remove the reference via UI; its source stays on disk and the other workspace retains it.
                client.execute("document.querySelector('.workspace-panel details').open=true")
                client.element_command(client.find('[aria-label=' + json.dumps('Remove reference: ' + str(shared)) + ']'), '/click')
                ready(client)
                smoke.wait_for(client, '!document.querySelector(' + json.dumps('[aria-label="Remove reference: ' + str(shared) + '"]') + ')', 'reference removed')
                catalog = invoke(client, 'list_workspaces', {})
                smoke.require(str(shared) in next(w for w in catalog['workspaces'] if w['id']==writing_id)['files'], 'Removal affected another workspace')
                deleted = invoke(client, 'delete_workspace', {'id': research_id})
                smoke.require(all(w['id'] != research_id for w in deleted['workspaces']), 'Workspace deletion failed')
                smoke.require(all(path.read_bytes() == content for path,content in originals.items()), 'Removing/deleting references modified source files')
                client.screenshot(output / 'references.png')
                print('PASS: disjoint locations, exact index/explorer scope, shared unsaved buffer, independent layouts, native restart, removal/deletion preserve files', flush=True)
            finally:
                if client.session_id:
                    try: client.quit()
                    except smoke.WebDriverError: pass
                if driver and driver.poll() is None:
                    os.killpg(driver.pid, signal.SIGTERM)
                    try: driver.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(driver.pid, signal.SIGKILL); driver.wait(timeout=5)
                log.flush(); shutil.copyfile(log_path, output / 'driver.log')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    run(parser.parse_args().app.resolve())
