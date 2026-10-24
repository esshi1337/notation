#!/usr/bin/env python3
"""Check wrapped text and table geometry in a packaged app's native WebKit.

Usage: python3 tests/native/responsive_smoke.py --app /path/to/Notation.AppImage
Uses the smoke harness with disposable profiles; no development server or CSS
injection. Screenshots and the driver log are saved under test-results/.
"""
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


def command(client: smoke.Client, name: str) -> None:
    client.element_command(client.find('button[aria-label="Commands"]'), '/click')
    smoke.fill_control(client, '[aria-label="Search commands"]', name)
    client.element_command(smoke.menuitem(client, name), '/click')


def run(app: Path) -> None:
    smoke.assert_ports_available()
    output = Path(__file__).resolve().parents[2] / 'test-results/native-responsive'
    output.mkdir(parents=True, exist_ok=True)
    client = smoke.Client(smoke.BASE_URL)
    driver = None
    paragraph = 'Text wraps within the available pane as the window changes size. ' * 3
    columns = [f'Column {index + 1}' for index in range(14)]
    table = '\n'.join('| ' + ' | '.join(row) + ' |' for row in [
        columns, ['---'] * len(columns), ['A readable value'] * len(columns),
    ])
    markdown = (
        '# Responsive native test\n\n' + paragraph + '\n\n' + 'abcdefghij' * 30
        + '\n\n| Project | Description | Status |\n| --- | :---: | ---: |\n'
        + '| Notation | ' + paragraph + ' | Ready |\n\n' + table
        + '\n\nText after the tables.\n'
    )
    with tempfile.TemporaryDirectory(prefix='notation-responsive-') as temporary:
        root = Path(temporary)
        env = {**os.environ, 'TAURI_WEBVIEW_AUTOMATION': 'true'}
        for key, name in [('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache')]:
            folder = root / name
            folder.mkdir()
            env[key] = str(folder)
        log_path = root / 'driver.log'
        with log_path.open('wb') as log:
            try:
                driver = subprocess.Popen([
                    str(smoke.DRIVER), '--port', str(smoke.DRIVER_PORT),
                    '--native-port', str(smoke.NATIVE_PORT), '--native-driver', str(smoke.WEBDRIVER),
                ], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                smoke.wait_for_driver(driver, log_path)
                client.create_session(app)
                smoke.wait_for(client, "document.querySelector('main.app')", 'packaged UI')
                url = client.execute('return location.href')
                smoke.require('tauri.localhost' in url or url.startswith('tauri://'), f'Not a packaged URL: {url}')
                smoke.replace_editor_text(client, smoke.active_editor(client), markdown)
                smoke.require(smoke.editor_text(client) == markdown, 'Native keyboard input changed the fixture')

                for mode in ['Split', 'Preview', 'Live Preview']:
                    command(client, mode)
                    selector = '.cm-content' if mode == 'Live Preview' else '.preview-scroll'
                    smoke.wait_for(client, f"document.querySelector({json.dumps(selector)})?.querySelectorAll('table').length === 2", 'both tables in ' + mode)
                    client.execute_async('const done=arguments[arguments.length-1]; document.fonts.ready.then(()=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
                    geometry = client.execute("""
const root=document.querySelector(arguments[0]), tables=[...root.querySelectorAll('table')];
const first=tables[0], headers=[...first.querySelectorAll('th')], cells=[...first.querySelectorAll('tbody tr:first-child td')];
const range=document.createRange();range.selectNodeContents(headers[0]);
const containers=[root,...root.querySelectorAll('.markdown-body')];
const source=document.querySelector('.source-pane'),preview=document.querySelector('.preview-pane');
return {
  viewport:[innerWidth,innerHeight],
  contained:containers.every(e=>e.scrollWidth<=e.clientWidth+1),
  equalPanes:Math.abs(source.clientWidth-preview.clientWidth)<=1,
  aligned:headers.every((h,i)=>Math.abs(h.getBoundingClientRect().width-cells[i].getBoundingClientRect().width)<=1),
  headingReadable:range.getBoundingClientRect().height<=parseFloat(getComputedStyle(headers[0]).lineHeight),
  alignment:[getComputedStyle(headers[1]).textAlign,getComputedStyle(cells[1]).textAlign,getComputedStyle(headers[2]).textAlign,getComputedStyle(cells[2]).textAlign],
  tableScrolls:tables[1].parentElement.scrollWidth>tables[1].parentElement.clientWidth
};
""", [selector])
                    smoke.require(all(geometry[key] for key in ['contained', 'aligned', 'headingReadable', 'tableScrolls']), f'{mode} layout failed: {geometry}')
                    if mode == 'Split':
                        smoke.require(geometry['equalPanes'], f'Split pane widths differ: {geometry}')
                    smoke.require(geometry['alignment'] == ['center', 'center', 'right', 'right'], f'Column alignment changed: {geometry}')
                    client.execute("const root=document.querySelector(arguments[0]); const table=[...root.querySelectorAll('.markdown-table-scroll')].at(-1); table.scrollLeft=0;table.focus()", [selector])
                    # Send keys to the focused scroll region, including in Live Preview.
                    scroll = client.execute("return document.activeElement")
                    client.send_keys(scroll[smoke.ELEMENT_KEY], '\ue014')
                    smoke.wait_for(client, f"[...document.querySelector({json.dumps(selector)}).querySelectorAll('.markdown-table-scroll')].at(-1).scrollLeft > 0", 'keyboard table scrolling')
                    client.execute("const root=document.querySelector(arguments[0]); for(const e of root.querySelectorAll('.markdown-table-scroll'))e.scrollLeft=0;(root.closest('.cm-scroller')??root).scrollTop=0", [selector])
                    client.screenshot(output / (mode.lower().replace(' ', '-') + '.png'))
                    print(f'{mode}: PASS {json.dumps(geometry)}', flush=True)

                command(client, 'Source')
                smoke.require(smoke.editor_text(client) == markdown, 'View changes mutated Markdown')
                print('PASS: packaged URL, text containment, table alignment, keyboard scrolling, and source preservation', flush=True)
            finally:
                if client.session_id:
                    try:
                        client.quit()
                    except smoke.WebDriverError:
                        pass
                if driver and driver.poll() is None:
                    os.killpg(driver.pid, signal.SIGTERM)
                    try:
                        driver.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(driver.pid, signal.SIGKILL)
                        driver.wait(timeout=5)
                log.flush()
                shutil.copyfile(log_path, output / 'driver.log')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    run(parser.parse_args().app.resolve())
