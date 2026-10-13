#!/usr/bin/env python3
"""Fast native UI export control for plain, math, and Mermaid notes."""

from __future__ import annotations

import argparse
import os
import shutil
import dialogs
from pathlib import Path
import signal
import subprocess
import tempfile

import smoke


def click(client: smoke.Client, element: str) -> None:
    client.element_command(element, "/click")


def run(app: Path, mode: str) -> None:
    smoke.assert_ports_available()
    client = smoke.Client(smoke.BASE_URL)
    driver = None
    log = None
    with tempfile.TemporaryDirectory(prefix="notation-export-control-") as temp:
        root = Path(temp)
        data, config, workspace = root / "data", root / "config", root / "workspace"
        for path in (data, config, workspace):
            path.mkdir(parents=True, exist_ok=True)
        text = "# Export probe\n\n| A | B |\n| --- | --- |\n| one | two |\n"
        if mode in {"math", "mermaid"}:
            text += "\nEquation $x^2$.\n"
        if mode == "mermaid":
            text += "\n```mermaid\nflowchart LR\n A[One] --> B[Two]\n```\n"
        note = workspace / "probe.md"
        note.write_text(text, encoding="utf-8")
        env = os.environ.copy()
        env["XDG_DATA_HOME"], env["XDG_CONFIG_HOME"] = str(data), str(config)
        env["TAURI_WEBVIEW_AUTOMATION"] = "true"
        log_path = root / "tauri-driver.log"
        log = log_path.open("wb")
        try:
            driver = subprocess.Popen(
                [str(smoke.DRIVER), "--port", str(smoke.DRIVER_PORT), "--native-port", str(smoke.NATIVE_PORT),
                 "--native-driver", str(smoke.WEBDRIVER)],
                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, env=env, start_new_session=True,
            )
            smoke.wait_for_driver(driver, log_path)
            client.create_session(app)
            smoke.wait_for(client, "document.querySelector('main.app')", "native app UI")
            click(client, smoke.button(client, "Workspace"))
            folder = client.find("[aria-label='Workspace folder']")
            client.element_command(folder, "/clear")
            client.send_keys(folder, str(workspace))
            click(client, smoke.button(client, "Open workspace"))
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] .panel-status')?.innerText.includes('indexed')", "workspace indexing")
            search = client.find("[aria-label='Search notes']")
            client.element_command(search, "/clear")
            client.send_keys(search, "Export probe")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] [aria-label=\\\"Open note: probe.md\\\"]')", "probe note")
            click(client, client.find("[aria-label='Workspace'] [aria-label='Open note: probe.md']"))
            smoke.wait_for_active_tab(client, "probe.md")
            click(client, client.find("[aria-label='Workspace'] [aria-label='Close workspace']"))
            click(client, smoke.button(client, "Export"))
            select = client.find("[aria-label='Export format']")
            client.element_command(select, "/click")
            client.send_keys(select, "pdf")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Export format\\\"]').value==='pdf'", "PDF selection")
            output = root / "probe.pdf"
            click(client, client.find("//section[@aria-label='Export']//button[normalize-space(.)='Export document']", using="xpath"))
            dialogs.save_file(output, data)
            smoke.wait_for(client, "(() => {const p=document.querySelector('[aria-label=\\\"Export\\\"]');return Boolean(p?.querySelector('.panel-status')?.innerText.includes('Exported probe.pdf')||p?.querySelector('[role=\\\"alert\\\"]'))})()", "export status or error", timeout=90)
            state = client.execute("return {panel:document.querySelector('[aria-label=\\\"Export\\\"]')?.innerText,alerts:Array.from(document.querySelectorAll('[aria-label=\\\"Export\\\"] [role=\\\"alert\\\"]')).map(e=>e.innerText),hosts:Array.from(document.querySelectorAll('.markdown-body[aria-hidden=\\\"true\\\"]')).map(e=>({connected:e.isConnected,html:e.innerHTML.slice(0,2000),svg:e.querySelectorAll('svg').length,math:e.querySelectorAll('.katex').length})),resources:performance.getEntriesByType('resource').map(e=>e.name).filter(n=>/mermaid|katex|woff|fonts/u.test(n)).slice(-30)}")
            print(f"mode={mode} state={state!r} output={output.exists()}", flush=True)
            status = state.get("panel", "")
            smoke.require(not state.get("alerts"), f"Export showed an error: {state.get('alerts')!r}")
            smoke.require("Exported probe.pdf" in status and output.is_file() and output.read_bytes().startswith(b"%PDF-"),
                          f"Native UI PDF export did not complete: {status!r}; state={state!r}")
            artifacts = Path('/tmp/notation-native-artifacts'); artifacts.mkdir(exist_ok=True)
            shutil.copy2(output, artifacts / (mode + '.pdf'))
        finally:
            artifacts = Path('/tmp/notation-native-artifacts'); artifacts.mkdir(exist_ok=True)
            if log: log.flush()
            if log_path.exists(): shutil.copy2(log_path, artifacts / (mode + '-driver.log'))
            if client.session_id:
                try: client.quit()
                except Exception: pass
            if driver is not None and driver.poll() is None:
                os.killpg(driver.pid, signal.SIGTERM)
                try: driver.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(driver.pid, signal.SIGKILL); driver.wait(timeout=5)
            if log: log.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--mode", choices=["plain", "math", "mermaid"], required=True)
    args = parser.parse_args()
    run(args.app.resolve(), args.mode)


if __name__ == "__main__":
    main()
