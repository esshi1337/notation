#!/usr/bin/env python3
"""Verify sidebar placement and persisted settings in a disposable native profile."""
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
from media_graph_smoke import stop_profile_apps
from responsive_smoke import command


def click(client: smoke.Client, label: str) -> None:
    client.element_command(client.find('[aria-label=' + json.dumps(label) + ']'), '/click')


def side(client: smoke.Client, value: str) -> None:
    click(client, 'App menu')
    click(client, 'Settings')
    select = client.find('dialog[aria-label="Settings"] select[aria-label="Sidebar position"]')
    client.send_keys(select, '\ue011' if value == 'left' else '\ue010')  # Home / End
    client.send_keys(select, '\ue007')  # Enter
    smoke.wait_for(client, 'document.querySelector(\'[aria-label="Sidebar position"]\').value === ' + json.dumps(value), 'sidebar position control')
    click(client, 'Close settings')
    smoke.wait_for(client, 'document.querySelector(".content-area").dataset.sidebarPosition === ' + json.dumps(value), 'sidebar position applied')


def geometry(client: smoke.Client, value: str) -> None:
    result = client.execute("""
const rail = document.querySelector('.app-navigation').getBoundingClientRect();
const panel = document.querySelector('.sidebar-panel').getBoundingClientRect();
const editor = document.querySelector('.content-area > .workspace').getBoundingClientRect();
return {rail:[rail.left,rail.right],panel:[panel.left,panel.right],editor:[editor.left,editor.right],width:innerWidth,contained:document.documentElement.scrollWidth<=innerWidth};
""")
    smoke.require(result['contained'], f'Page overflow: {result}')
    narrow = result['width'] <= 760
    smoke.require(0 <= result['panel'][0] < result['panel'][1] <= result['width'], f'Panel outside viewport: {result}')
    if value == 'left':
        edge = result['rail'][1] if narrow else result['panel'][1]
        smoke.require(abs(result['rail'][0]) < 2 and abs(result['rail'][1]-result['panel'][0]) < 2 and abs(edge-result['editor'][0]) < 2, f'Incorrect left placement: {result}')
    else:
        edge = result['rail'][0] if narrow else result['panel'][0]
        smoke.require(abs(result['rail'][1]-result['width']) < 2 and abs(result['rail'][0]-result['panel'][1]) < 2 and abs(edge-result['editor'][1]) < 2, f'Incorrect right placement: {result}')
    if narrow: smoke.require(result['editor'][1]-result['editor'][0] >= result['width']-45, f'Overlay squeezed the editor: {result}')


def run(app: Path) -> None:
    smoke.assert_ports_available()
    output = Path(__file__).resolve().parents[2] / 'test-results/native-sidebar'; output.mkdir(parents=True,exist_ok=True)
    client = smoke.Client(smoke.BASE_URL); driver = None
    with tempfile.TemporaryDirectory(prefix='notation-sidebar-') as temporary:
        root = Path(temporary); env = {**os.environ,'TAURI_WEBVIEW_AUTOMATION':'true'}
        for key,name in [('XDG_DATA_HOME','data'),('XDG_CONFIG_HOME','config'),('XDG_CACHE_HOME','cache')]:
            path=root/name;path.mkdir();env[key]=str(path)
        log_path=root/'driver.log'
        with log_path.open('wb') as log:
            try:
                driver=subprocess.Popen([str(smoke.DRIVER),'--port',str(smoke.DRIVER_PORT),'--native-port',str(smoke.NATIVE_PORT),'--native-driver',str(smoke.WEBDRIVER)],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                smoke.wait_for_driver(driver,log_path);client.create_session(app)
                smoke.wait_for(client,"document.querySelector('main.app')",'packaged app')
                smoke.require('tauri' in client.execute('return location.href'),'Not a packaged app')
                command(client,'Source')
                text='Sidebar native test\n\nKeep this unsaved draft intact.'
                smoke.replace_editor_text(client,smoke.active_editor(client),text)
                click(client,'Workspace panel')
                smoke.fill_control(client,'[aria-label="Workspace name"]','Unsubmitted native workspace')
                geometry(client,'left');client.screenshot(output/'left.png')
                side(client,'right');geometry(client,'right')
                smoke.require(client.execute('return document.querySelector(\'[aria-label="Workspace name"]\').value')=='Unsubmitted native workspace','Moving sidebar remounted its tool')
                smoke.require(smoke.editor_text(client)==text,'Moving sidebar changed the draft')
                client.screenshot(output/'right.png')
                click(client,'Scripts panel')
                smoke.fill_control(client,'[aria-label="Script code"]','return "Sidebar output stays";')
                client.element_command(smoke.button(client,'Run script'),'/click')
                smoke.wait_for(client,"document.querySelector('[aria-label=\"Script output\"]')?.textContent.includes('Sidebar output stays')",'script output')
                side(client,'left');geometry(client,'left')
                smoke.require(client.execute("return document.querySelector('[aria-label=\"Script output\"]').textContent.includes('Sidebar output stays')"),'Moving sidebar discarded tool state')
                side(client,'right')
                command(client,'Focus mode')
                smoke.require(client.execute('return !document.querySelector(".app-navigation") && !document.querySelector(".sidebar-panel")'),'Focus mode did not hide sidebar')
                command(client,'Focus mode')
                smoke.wait_for(client,'document.querySelector(".app-navigation")','sidebar restored')
                smoke.wait_for(client,"document.querySelector('.database-state')?.dataset.state==='saved'",'native settings saved')
                client.quit();client.create_session(app)
                smoke.wait_for(client,"document.querySelector('main.app')",'restart')
                smoke.require(client.execute('return document.querySelector(".content-area").dataset.sidebarPosition')=='right','Native restart lost sidebar position')
                smoke.require(smoke.editor_text(client)==text,'Native restart lost draft')
                click(client,'Explorer panel');geometry(client,'right')
                click(client,'App menu');click(client,'Settings')
                smoke.require(client.execute('return document.querySelector(\'[aria-label="Sidebar position"]\').value')=='right','Settings did not restore right')
                client.screenshot(output/'settings.png')
                print('PASS: left/right geometry, native settings control, tool state, draft preservation, Focus mode and restart persistence',flush=True)
            finally:
                if client.session_id:
                    try:client.quit()
                    except smoke.WebDriverError:pass
                stop_profile_apps(root / 'data')
                if driver and driver.poll() is None:
                    os.killpg(driver.pid,signal.SIGTERM)
                    try:driver.wait(timeout=5)
                    except subprocess.TimeoutExpired:os.killpg(driver.pid,signal.SIGKILL);driver.wait(timeout=5)
                log.flush();shutil.copyfile(log_path,output/'driver.log')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--app',type=Path,required=True)
    run(parser.parse_args().app.resolve())
