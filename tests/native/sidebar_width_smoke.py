#!/usr/bin/env python3
"""Measure icon-strip and tool-panel presets in a packaged, isolated WebKit app."""
import argparse
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import tempfile
import smoke
from instance_smoke import owners, wait_until
from media_graph_smoke import stop_profile_apps
from responsive_smoke import command
from settings_controls import segment, select


def run(app: Path, output: Path):
    smoke.assert_ports_available()
    output.mkdir(parents=True, exist_ok=True)
    client = smoke.Client(smoke.BASE_URL)
    driver = None
    results = []
    with tempfile.TemporaryDirectory(prefix='nt-width-') as temporary:
        root = Path(temporary)
        env = {**os.environ, 'TAURI_WEBVIEW_AUTOMATION': 'true'}
        for key, name in [('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache')]:
            (root / name).mkdir(); env[key] = str(root / name)
        with (output / 'driver.log').open('wb') as log:
            try:
                driver = subprocess.Popen([str(smoke.DRIVER), '--port', str(smoke.DRIVER_PORT), '--native-port', str(smoke.NATIVE_PORT), '--native-driver', str(smoke.WEBDRIVER)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                smoke.wait_for_driver(driver, output / 'driver.log'); client.create_session(app)
                smoke.wait_for(client, "document.querySelector('main.app')", 'packaged UI')
                smoke.wait_for(client, "document.querySelector('.database-state')?.dataset.state==='saved'", 'initial native state')
                client.execute("setTimeout(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'}),50);return true")
                wait_until(lambda: not owners(root / 'data'), 'initial owner exit', timeout=15)
                try: client.quit()
                except smoke.WebDriverError: pass
                # Exercise an actual SQLite profile with the pre-rail preference
                # shape, preserving a custom numeric panel width on upgrade.
                with sqlite3.connect(root / 'data/local.notation.app/state.sqlite3') as database:
                    preferences = json.loads(database.execute('SELECT json FROM settings WHERE id=1').fetchone()[0])
                    preferences.pop('sidebarRailWidth', None)
                    preferences.update(sidebarWidth=310, density='compact')
                    database.execute('UPDATE settings SET json=? WHERE id=1', (json.dumps(preferences),))
                client.create_session(app)
                smoke.wait_for(client, "document.querySelector('.app-navigation')", 'legacy-profile sidebar')
                smoke.require(client.execute("return document.querySelector('.app-navigation').getBoundingClientRect().width") == 44, 'Legacy profile did not default rail width')
                command(client, 'Settings')
                smoke.require('310' in client.execute("return document.querySelector('[aria-label=\"Tool panel width\"]').textContent"), 'Upgrade lost the legacy custom panel width')
                for side in ['Left', 'Right']:
                    segment(client, 'Sidebar position', side)
                    for density, extra in [('Compact', 0), ('Comfortable', 4)]:
                        segment(client, 'Density', density)
                        for preset, expected in [('Narrow', 40), ('Standard', 44), ('Wide', 60)]:
                            select(client, 'Sidebar width', preset)
                            geometry = client.execute("const rail=document.querySelector('.app-navigation').getBoundingClientRect();const button=document.querySelector('.sidebar-button').getBoundingClientRect();return {width:rail.width,centerOffset:Math.abs((rail.left+rail.right-button.left-button.right)/2),contained:document.documentElement.scrollWidth<=innerWidth}")
                            smoke.require(abs(geometry['width'] - expected - extra) < 1, f'Icon strip did not resize: {side} {density} {preset} {geometry}')
                            smoke.require(geometry['centerOffset'] < 2 and geometry['contained'], f'Icon strip geometry: {geometry}')
                            results.append(dict(side=side, density=density, preset=preset, **geometry))
                client.element_command(smoke.button(client, 'Close settings'), '/click')
                for tool in ['Explorer', 'Note graph']:
                    client.element_command(smoke.button(client, tool + ' panel'), '/click')
                    command(client, 'Settings')
                    for preset, expected in [('Narrow', 220), ('Standard', 260), ('Wide', 340)]:
                        select(client, 'Tool panel width', preset)
                        geometry = client.execute("return {panel:document.querySelector('.sidebar-panel').getBoundingClientRect().width,rail:document.querySelector('.app-navigation').getBoundingClientRect().width}")
                        smoke.require(abs(geometry['panel'] - expected) < 1, f'{tool} panel did not resize: {preset} {geometry}')
                        smoke.require(geometry['rail'] == 64, f'Panel preset changed icon strip: {geometry}')
                        results.append(dict(tool=tool, preset=preset, **geometry))
                    client.element_command(smoke.button(client, 'Close settings'), '/click')
                    client.screenshot(output / (tool.lower().replace(' ', '-') + '-wide.png'))
                smoke.wait_for(client, "document.querySelector('.database-state')?.dataset.state==='saved'", 'settings persisted')
                client.execute("setTimeout(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'}),50);return true")
                wait_until(lambda: not owners(root / 'data'), 'owner exit', timeout=15)
                try: client.quit()
                except smoke.WebDriverError: pass
                client.create_session(app)
                smoke.wait_for(client, "document.querySelector('.app-navigation')", 'restarted sidebar')
                smoke.require(client.execute("return document.querySelector('.app-navigation').getBoundingClientRect().width") == 64, 'Restart lost rail width/density')
                command(client, 'Settings')
                for label in ['Sidebar width', 'Tool panel width']:
                    smoke.require('Wide' in client.execute('return document.querySelector('+json.dumps('[aria-label="'+label+'"][role="combobox"]')+').textContent'), f'Restart lost {label}')
                client.element_command(smoke.button(client, 'Reset appearance'), '/click')
                smoke.require(client.execute("return document.querySelector('.app-navigation').getBoundingClientRect().width") == 44, 'Appearance reset did not reset icon strip')
                smoke.require('Standard' in client.execute("return document.querySelector('[aria-label=\"Tool panel width\"]').textContent"), 'Appearance reset did not restore panel preset')
                smoke.require(client.execute("return getComputedStyle(document.querySelector('main.app')).getPropertyValue('--sidebar-width').trim()") == '260px', 'Appearance reset did not restore panel width')
                (output / 'report.json').write_text(json.dumps({'checks': results, 'legacyNativePreferences': True, 'restart': True, 'reset': True}, indent=2))
                print('PASS: actual icon strip sizes, centered buttons, independent panel sizes, native restart and reset', flush=True)
            finally:
                if client.session_id:
                    try: client.quit()
                    except smoke.WebDriverError: pass
                stop_profile_apps(root / 'data')
                if driver and driver.poll() is None:
                    os.killpg(driver.pid, signal.SIGTERM)
                    try: driver.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(driver.pid, signal.SIGKILL); driver.wait(timeout=5)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('test-results/native-sidebar-width'))
    args = parser.parse_args()
    run(args.app.resolve(), args.output.resolve())
