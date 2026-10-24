#!/usr/bin/env python3
"""Exercise designed Settings controls in packaged WebKit with a disposable profile."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import smoke
from identity_smoke import screenshot
from media_graph_smoke import stop_profile_apps
from responsive_smoke import command
from settings_controls import segment, select


def run(app):
    smoke.assert_ports_available()
    output = Path(__file__).resolve().parents[2] / 'test-results/native-settings-controls'
    output.mkdir(parents=True, exist_ok=True)
    client = smoke.Client(smoke.BASE_URL)
    driver = None
    with tempfile.TemporaryDirectory(prefix='notation-settings-controls-') as temporary:
        root = Path(temporary)
        env = {**os.environ, 'TAURI_WEBVIEW_AUTOMATION': 'true'}
        for key, folder in [('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache')]:
            (root / folder).mkdir(); env[key] = str(root / folder)
        with (output / 'driver.log').open('wb') as log:
            try:
                driver = subprocess.Popen([str(smoke.DRIVER), '--port', str(smoke.DRIVER_PORT), '--native-port', str(smoke.NATIVE_PORT), '--native-driver', str(smoke.WEBDRIVER)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                smoke.wait_for_driver(driver, output / 'driver.log'); client.create_session(app)
                smoke.wait_for(client, "document.querySelector('main.app')", 'packaged UI')
                command(client, 'Settings')
                results = []
                for theme in ['Dark', 'Light']:
                    client.element_command(client.find('[data-section="Appearance"]'), '/click')
                    segment(client, 'Theme', theme)
                    smoke.require(client.execute('return !!document.querySelector(\'[aria-label="Dark preset"]\')') == (theme == 'Dark'), 'Dark preset visibility')
                    smoke.require(client.execute('return !document.querySelector(\'[aria-label="Accent color"]\')'), 'Accent control visible')
                    select(client, 'Tool panel width', 'Wide')
                    segment(client, 'Density', 'Comfortable')
                    comfortable = client.execute("return document.querySelector('.workspace-bar').getBoundingClientRect().height")
                    segment(client, 'Density', 'Compact')
                    compact = client.execute("return document.querySelector('.workspace-bar').getBoundingClientRect().height")
                    smoke.require(comfortable > compact, 'Density did not change chrome')
                    screenshot(client, output / f'{theme.lower()}-appearance.png', "document.querySelector('[aria-label=\"Tool panel width\"]')")
                    client.element_command(client.find('[data-section="Editor"]'), '/click')
                    select(client, 'Editor font', 'Source Sans 3')
                    field = client.find('[aria-label="Font size"]')
                    client.element_command(field, '/click')
                    # Explicit key-up actions avoid WebKit's legacy send-keys
                    # NULL key leaving Control held for subsequent digits.
                    client.command('POST', '/actions', {'actions': [{'type': 'key', 'id': 'keyboard', 'actions': [{'type': 'keyDown', 'value': '\ue009'}, {'type': 'keyDown', 'value': 'a'}, {'type': 'keyUp', 'value': 'a'}, {'type': 'keyUp', 'value': '\ue009'}, {'type': 'keyDown', 'value': '1'}, {'type': 'keyUp', 'value': '1'}, {'type': 'keyDown', 'value': '8'}, {'type': 'keyUp', 'value': '8'}]}]})
                    client.send_keys(field, '\ue004')
                    size = client.execute('return document.querySelector(\'[aria-label="Font size"]\').value')
                    if size != '18':
                        client.screenshot(output / 'number-failure.png')
                    smoke.require(size == '18', 'Font size did not update: ' + str(size))
                    client.element_command(client.find('[aria-label="Layout"][role="combobox"]'), '/click')
                    screenshot(client, output / f'{theme.lower()}-dropdown.png', "document.querySelector('[role=listbox]')")
                    client.send_keys(client.find('[role="combobox"][aria-label="Layout"]'), '\ue00c')
                    smoke.require(client.execute("return !!document.querySelector('.settings-dialog[open]') && !document.querySelector('[role=listbox]')"), 'Escape closed Settings instead of dropdown')
                    select(client, 'Layout', 'Preview')
                    layout = client.find('[role="combobox"][aria-label="Layout"]')
                    client.send_keys(layout, 'ss\ue007')
                    smoke.require(client.execute('return document.querySelector(\'[aria-label="Layout"]\').textContent.trim()') == 'Split', 'Repeated-letter typeahead did not cycle to Split')
                    client.send_keys(layout, 'sou\ue007')
                    smoke.require(client.execute('return document.querySelector(\'[aria-label="Layout"]\').textContent.trim()') == 'Source', 'Multi-letter typeahead did not select Source')
                    screenshot(client, output / f'{theme.lower()}-editor.png', "document.querySelector('[aria-label=\"Font size\"]')")
                    client.element_command(client.find('[data-section="Agents"]'), '/click')
                    smoke.wait_for(client, "document.querySelector('.settings-mcp')?.textContent.includes('MCP ready')", 'MCP status ready')
                    status = client.execute_async("const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke('agent_status').then(done)")
                    displayed = client.execute("const e=document.querySelector('[aria-label=\"MCP command\"]');return e?.value??e?.textContent")
                    smoke.require(displayed and status['command'] in displayed and status['socketPath'] in displayed, 'Command missing launcher/socket')
                    client.element_command(smoke.button(client, 'Refresh MCP status'), '/click')
                    smoke.wait_for(client, "document.querySelector('.settings-mcp')?.textContent.includes('MCP ready')", 'MCP refresh recovered')
                    screenshot(client, output / f'{theme.lower()}-agents.png', "document.querySelector('.settings-mcp')")
                    results.append(dict(theme=theme, compact=compact, comfortable=comfortable, commandPresent=True, darkPresetOnlyInDark=True))
                (output / 'report.json').write_text(json.dumps(results, indent=2))
                print('PASS: packaged segmented controls, presets, density, number input, dropdown escape, MCP ready/refresh and both themes', flush=True)
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
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--app', type=Path, required=True)
    run(parser.parse_args().app.resolve())
