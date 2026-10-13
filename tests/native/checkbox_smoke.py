#!/usr/bin/env python3
"""Verify settings checkbox alignment and keyboard toggles in native WebKit."""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import tempfile

import smoke


def run(app: Path, preview_css: Path | None = None) -> None:
    smoke.assert_ports_available()
    client = smoke.Client(smoke.BASE_URL)
    driver = None
    with tempfile.TemporaryDirectory(prefix='notation-checkbox-smoke-') as temporary:
        root = Path(temporary)
        data, config = root / 'data', root / 'config'
        data.mkdir(); config.mkdir()
        env = {**os.environ, 'XDG_DATA_HOME': str(data), 'XDG_CONFIG_HOME': str(config), 'TAURI_WEBVIEW_AUTOMATION': 'true'}
        log_path = root / 'driver.log'
        with log_path.open('wb') as log:
            try:
                driver = subprocess.Popen([str(smoke.DRIVER), '--port', str(smoke.DRIVER_PORT), '--native-port', str(smoke.NATIVE_PORT), '--native-driver', str(smoke.WEBDRIVER)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                smoke.wait_for_driver(driver, log_path)
                client.create_session(app)
                smoke.wait_for(client, "document.querySelector('main.app')", 'native app')
                if preview_css:
                    css = '\n'.join(line for line in preview_css.read_text().splitlines() if not line.startswith('@import'))
                    client.execute("const style=document.createElement('style');style.textContent=arguments[0];document.head.append(style)", [css])
                client.element_command(smoke.button(client, 'Settings'), '/click')
                smoke.wait_for(client, "document.querySelector('dialog[aria-label=Settings][open]')", 'Settings dialog')
                client.execute_async("const done=arguments[arguments.length-1];document.fonts.ready.then(()=>requestAnimationFrame(()=>requestAnimationFrame(done)))")
                for section, name in [('Appearance', 'Show status bar'), ('Editor', 'Show line numbers')]:
                    client.element_command(client.find(f"//dialog[@aria-label='Settings']//*[@role='tab' and normalize-space(.)='{section}']", using='xpath'), '/click')
                    selector = "//dialog[@aria-label='Settings']//label[contains(normalize-space(.), '" + name + "')]/input[@type='checkbox']"
                    checkbox = client.find(selector, using='xpath')
                    geometry = client.execute("""
const input=Array.from(document.querySelectorAll('dialog[aria-label=Settings] input[type=checkbox]')).find(e=>e.parentElement.textContent.includes(arguments[0]));
const label=input.parentElement,baseline=document.createElement('span'),cap=document.createElement('span');
baseline.style.cssText='display:inline-block;width:0;height:0;vertical-align:baseline';cap.style.cssText='position:absolute;width:0;height:1cap';label.append(baseline,cap);
const box=input.getBoundingClientRect(),center=baseline.getBoundingClientRect().top-cap.getBoundingClientRect().height/2;
const result={width:box.width,height:box.height,delta:Math.abs(box.top+box.height/2-center),appearance:getComputedStyle(input).appearance};baseline.remove();cap.remove();return result;
""", [name])
                    smoke.require(geometry['appearance'] == 'none' and geometry['width'] == geometry['height'] == 12 and geometry['delta'] < .75, f'{name} is misaligned: {geometry}')
                    client.element_command(checkbox, '/click')
                    smoke.require(client.command('GET', f'/element/{checkbox}/selected') is False, f'{name} did not uncheck')
                    client.send_keys(checkbox, ' ')
                    smoke.wait_for(client, "Array.from(document.querySelectorAll('dialog[aria-label=Settings] input[type=checkbox]')).find(e=>e.parentElement.textContent.includes(" + repr(name) + "))?.checked === true", 'Space checks ' + name)
                    print(f'{name}: aligned within {geometry["delta"]:.3f}px; pointer and Space toggle passed', flush=True)
                output = Path(__file__).resolve().parents[2] / 'test-results/notation-checkbox-native.png'
                output.parent.mkdir(exist_ok=True)
                client.screenshot(output)
            finally:
                if client.session_id:
                    try: client.quit()
                    except Exception: pass
                if driver and driver.poll() is None:
                    os.killpg(driver.pid, signal.SIGTERM)
                    try: driver.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(driver.pid, signal.SIGKILL); driver.wait(timeout=5)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--preview-css', type=Path, help='Development-only CSS preview; omit for packaged validation.')
    args = parser.parse_args()
    run(args.app.resolve(), args.preview_css)
