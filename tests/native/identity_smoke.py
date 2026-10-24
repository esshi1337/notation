#!/usr/bin/env python3
"""Verify the packaged identity, bundled fonts/icons, and UI containment.

Uses a disposable profile and saves native WebKit screenshots under
test-results/native-identity. No development server or injected styles.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile

import smoke
from media_graph_smoke import stop_profile_apps
from responsive_smoke import command


def screenshot(client, path, ready):
    smoke.wait_for(client, ready, 'visible screenshot target')
    # WebDriver can observe updated DOM before WebKit composites the new dialog.
    client.execute_async('const done=arguments[arguments.length-1];document.fonts.ready.then(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(done,150))))')
    client.screenshot(path)


def run(app):
    smoke.assert_ports_available()
    output = Path(__file__).resolve().parents[2] / 'test-results/native-identity'
    output.mkdir(parents=True, exist_ok=True)
    client = smoke.Client(smoke.BASE_URL)
    driver = None
    with tempfile.TemporaryDirectory(prefix='notation-identity-') as temporary:
        root = Path(temporary)
        env = {**os.environ, 'TAURI_WEBVIEW_AUTOMATION': 'true'}
        for key, folder in [('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache')]:
            (root / folder).mkdir()
            env[key] = str(root / folder)
        with (output / 'driver.log').open('wb') as log:
            try:
                driver = subprocess.Popen([
                    str(smoke.DRIVER), '--port', str(smoke.DRIVER_PORT),
                    '--native-port', str(smoke.NATIVE_PORT),
                    '--native-driver', str(smoke.WEBDRIVER),
                ], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                smoke.wait_for_driver(driver, output / 'driver.log')
                client.create_session(app)
                smoke.wait_for(client, "document.querySelector('main.app')", 'packaged UI')
                url = client.execute('return location.href')
                smoke.require('tauri.localhost' in url or url.startswith('tauri://'), f'Not a packaged URL: {url}')
                smoke.wait_for(client, "document.querySelectorAll('.identity-icon').length > 10", 'custom identity icons')
                markdown = ('# Seed germination\n\nA quiet place to think, connect ideas, and keep the work close.\n\n'
                            '## Observations\n\n- Keep light and moisture consistent.\n- Record the first signs of growth.\n\n'
                            '| Sample | Day | Observation |\n| --- | ---: | --- |\n| Basil | 4 | First leaves |\n| Mint | 7 | Roots visible |\n\n'
                            '```python\nseeds = ["basil", "mint"]\nfor seed in seeds:\n    print(seed)\n```\n')
                smoke.replace_editor_text(client, smoke.active_editor(client), markdown)
                command(client, 'Preview')
                smoke.wait_for(client, "document.querySelector('.markdown-body table')", 'rendered fixture')
                reports = []
                for theme in ['dark', 'light']:
                    if theme == 'light':
                        command(client, 'Settings')
                        client.execute("const e=document.querySelector('[aria-label=\"Theme\"]');e.value='light';e.dispatchEvent(new Event('change',{bubbles:true}))")
                        client.element_command(client.find('[aria-label="Close settings"]'), '/click')
                    client.execute_async('const done=arguments[arguments.length-1];document.fonts.ready.then(()=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
                    assets = client.execute_async("""
const done=arguments[arguments.length-1];
Promise.all([...new Set([...document.querySelectorAll('.identity-icon')].map(e=>e.dataset.iconSource))].map(src=>new Promise(resolve=>{
 const image=new Image(); image.onload=()=>resolve({src,loaded:image.naturalWidth>0});image.onerror=()=>resolve({src,loaded:false});image.src=src;
}))).then(done);
""")
                    smoke.require(assets and all(a['loaded'] for a in assets), f'Bundled icon failed: {assets}')
                    geometry = client.execute("""
const box=s=>document.querySelector(s).getBoundingClientRect();
const prose=getComputedStyle(document.querySelector('.markdown-body'));
const code=getComputedStyle(document.querySelector('.markdown-body pre code'));
return {theme:document.documentElement.dataset.theme,bar:box('.workspace-bar').height,
 rail:box('.app-navigation').width,contained:document.documentElement.scrollWidth<=innerWidth,
 railContained:document.querySelector('.sidebar-tools').scrollWidth<=document.querySelector('.sidebar-tools').clientWidth,
 prose:prose.fontFamily,code:code.fontFamily,
 fonts:[...document.fonts].filter(f=>f.status==='loaded').map(f=>f.family),
 centered:[...document.querySelectorAll('.sidebar-button')].every(e=>{const a=e.getBoundingClientRect(),b=e.querySelector('.identity-icon').getBoundingClientRect();return Math.abs(a.x+a.width/2-b.x-b.width/2)<.6&&Math.abs(a.y+a.height/2-b.y-b.height/2)<.6;})};
""")
                    smoke.require(geometry['bar'] == 44 and geometry['rail'] == 44 and geometry['contained'] and geometry['railContained'] and geometry['centered'], f'Identity geometry: {geometry}')
                    smoke.require('Source Sans 3' in geometry['prose'] and 'IBM Plex Mono' in geometry['code'], f'Bundled typography: {geometry}')
                    smoke.require(all(any(name in family for family in geometry['fonts']) for name in ['Source Sans 3', 'IBM Plex Mono']), f'Bundled fonts did not load: {geometry}')
                    reports.append(geometry)
                    screenshot(client, output / f'{theme}-editor.png', "!document.querySelector('dialog[open]')")
                    client.element_command(client.find('[aria-label="App menu"]'), '/click')
                    screenshot(client, output / f'{theme}-menu.png', "document.querySelector('.app-menu')")
                    client.element_command(client.find('[aria-label="App menu"]'), '/click')
                    client.element_command(client.find('[aria-label="Commands"]'), '/click')
                    screenshot(client, output / f'{theme}-commands.png', "document.querySelector('[aria-label=\"Search commands\"]')")
                    client.element_command(client.find('[aria-label="Close commands"]'), '/click')
                    command(client, 'Settings')
                    screenshot(client, output / f'{theme}-settings.png', "document.querySelector('.settings-dialog[open]')")
                    client.element_command(client.find('[aria-label="Close settings"]'), '/click')
                command(client, 'Source')
                smoke.require(smoke.editor_text(client) == markdown, 'Identity interactions changed the document')
                for _ in range(17):
                    client.element_command(client.find('[aria-label="New document"]'), '/click')
                smoke.wait_for(client, "document.querySelectorAll('.document-tab').length === 18", 'overflowed tab strip')
                client.execute_async('const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(done))')
                overflow = client.execute("""
const tabs=document.querySelector('.document-tabs'),bar=document.querySelector('.workspace-bar');
const host=tabs.getBoundingClientRect(),active=tabs.querySelector('.document-tab.active').getBoundingClientRect();
return {height:tabs.clientHeight,scrollbar:getComputedStyle(tabs).scrollbarWidth,
 overflow:tabs.scrollWidth>tabs.clientWidth,barContained:bar.scrollWidth<=bar.clientWidth,
 activeVisible:active.left>=host.left-1&&active.right<=host.right+1,
 controlsVisible:['App menu','New document','Commands','Layout'].every(label=>{const r=document.querySelector(`button[aria-label="${label}"]`).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})};
""")
                smoke.require(overflow == dict(height=32, scrollbar='none', overflow=True, barContained=True, activeVisible=True, controlsVisible=True), f'Tab strip overflow: {overflow}')
                wheel = client.execute("""
const tabs=document.querySelector('.document-tabs');tabs.scrollLeft=0;
const event=new WheelEvent('wheel',{deltaY:240,bubbles:true,cancelable:true});tabs.dispatchEvent(event);
return {moved:tabs.scrollLeft>0,consumed:event.defaultPrevented,headerFixed:document.querySelector('.workspace-bar').scrollLeft===0};
""")
                smoke.require(all(wheel.values()), f'Tab strip wheel navigation: {wheel}')
                client.execute("document.querySelector('.document-tab.active [role=tab]').focus({preventScroll:true})")
                client.send_keys(client.find('.document-tab.active [role=tab]'), '\ue014')
                smoke.wait_for(client, "document.querySelector('.document-tab:first-child.active') && document.querySelector('.document-tabs').scrollLeft === 0", 'keyboard tab wrap to first')
                client.send_keys(client.find('.document-tab.active [role=tab]'), '\ue012')
                smoke.wait_for(client, "document.querySelector('.document-tab:last-child.active')", 'keyboard tab wrap to last')
                screenshot(client, output / 'light-many-tabs.png', "document.querySelectorAll('.document-tab').length === 18")
                reports.append({'tabs': overflow, 'wheel': wheel})
                (output / 'report.json').write_text(json.dumps(reports, indent=2))
                print('PASS: native identity assets, centered icons, fonts, themes, menus, and source preservation ' + json.dumps(reports), flush=True)
            finally:
                if client.session_id:
                    try:
                        client.quit()
                    except smoke.WebDriverError:
                        pass
                stop_profile_apps(root / 'data')
                if driver and driver.poll() is None:
                    os.killpg(driver.pid, signal.SIGTERM)
                    try:
                        driver.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(driver.pid, signal.SIGKILL)
                        driver.wait(timeout=5)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    run(parser.parse_args().app.resolve())
