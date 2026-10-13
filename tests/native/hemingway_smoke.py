#!/usr/bin/env python3
"""Exercise Hemingway's per-document read-only editing mode in native WebKit.

Usage: python3 tests/native/hemingway_smoke.py --app /absolute/path/to/notation
The app runs with a temporary XDG profile and an isolated WebDriver session.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile

from smoke import (
    BASE_URL,
    DRIVER,
    DRIVER_PORT,
    NATIVE_PORT,
    WEBDRIVER,
    Client,
    active_editor,
    assert_ports_available,
    button,
    editor_text,
    replace_editor_text,
    wait_for,
    wait_for_driver,
)
import tooling_smoke


def run(app: Path) -> None:
    if not app.exists() or not os.access(app, os.X_OK):
        raise FileNotFoundError(f"App launcher does not exist or is not executable: {app}")
    if not DRIVER.is_file() or not os.access(DRIVER, os.X_OK):
        raise FileNotFoundError(f"tauri-driver was not found or is not executable: {DRIVER}")
    if not WEBDRIVER.is_file() or not os.access(WEBDRIVER, os.X_OK):
        raise FileNotFoundError(f"WebKitWebDriver was not found or is not executable: {WEBDRIVER}")
    assert_ports_available()

    client = Client(BASE_URL)
    driver: subprocess.Popen[bytes] | None = None
    with tempfile.TemporaryDirectory(prefix="notation-hemingway-") as temporary:
        root = Path(temporary)
        xdg_data, xdg_config = root / "data", root / "config"
        xdg_data.mkdir()
        xdg_config.mkdir()
        env = os.environ.copy()
        env["XDG_DATA_HOME"] = str(xdg_data)
        env["XDG_CONFIG_HOME"] = str(xdg_config)
        env["TAURI_WEBVIEW_AUTOMATION"] = "true"
        log_path = root / "tauri-driver.log"
        with log_path.open("wb") as log:
            try:
                driver = subprocess.Popen(
                    [str(DRIVER), "--port", str(DRIVER_PORT), "--native-port", str(NATIVE_PORT), "--native-driver", str(WEBDRIVER)],
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    env=env,
                    start_new_session=True,
                )
                wait_for_driver(driver, log_path)
                session = client.create_session(app)
                print(f"WebDriver session started: {session}", flush=True)
                wait_for(client, "document.querySelector('main.app')", "native application UI")
                wait_for(client, "document.querySelector('.editor-tab-host:not([hidden]) [aria-label=\"Document source\"]')", "active source editor")

                original = (
                    "# Literal Markdown\n\n"
                    "**bold**, $x^2$, and [[Target|alias]].\n\n"
                    "```mermaid\nflowchart LR\n  A[Plain] --> B[Text]\n```\n"
                )
                replace_editor_text(client, active_editor(client), original)
                require(editor_text(client) == original, "Could not seed exact Markdown fixture")

                print("Enabling Hemingway through the Commands palette", flush=True)
                client.element_command(button(client, "Hemingway mode"), "/click")
                wait_for(client, "document.querySelector('.editor-tab-host:not([hidden]) .cm-editor[data-hemingway=\"true\"]')", "Hemingway editor state")
                mode = client.execute(
                    "const status = document.querySelector('[role=\"status\"][aria-label=\"Hemingway mode\"]'); "
                    "return {status: Boolean(status && status.innerText.includes('Deletion blocked')), "
                    "syntax: document.querySelectorAll('.editor-tab-host:not([hidden]) .cm-content .cm-line span[class*=\"ͼ\"]').length, "
                    "widgets: document.querySelectorAll('.editor-tab-host:not([hidden]) .cm-live-math,.editor-tab-host:not([hidden]) .cm-live-wiki,.editor-tab-host:not([hidden]) .cm-live-mermaid,.editor-tab-host:not([hidden]) .cm-live-table,.editor-tab-host:not([hidden]) input.task-checkbox').length, "
                    "slash: Boolean(document.querySelector('[aria-label=\"Slash commands\"]'))}"
                )
                require(mode == {"status": True, "syntax": 0, "widgets": 0, "slash": False},
                        f"Hemingway UI did not remain literal/plain: {mode!r}")

                editor = active_editor(client)
                client.element_command(editor, "/click")
                client.send_keys(editor, "\ue009a\ue000")
                client.send_keys(editor, "\ue008")  # Backspace with a nonempty selection.
                require(editor_text(client) == original, "Backspace removed existing text in Hemingway mode")
                client.send_keys(editor, "\ue009a\ue000")
                client.send_keys(editor, "\ue009x\ue000")  # Cut.
                require(editor_text(client) == original, "Cut removed existing text in Hemingway mode")
                client.send_keys(editor, "\ue009a\ue000")
                client.send_keys(editor, "replacement")
                require(editor_text(client) == original, "Selection replacement changed existing text in Hemingway mode")
                client.send_keys(editor, "\ue009z\ue000")
                client.send_keys(editor, "\ue009y\ue000")
                require(editor_text(client) == original, "Undo/redo changed existing text in Hemingway mode")

                # Insertions at an empty caret remain available.
                client.send_keys(editor, "\ue009\ue010\ue000")  # Control+End
                client.send_keys(editor, " appended")
                appended = original + " appended"
                require(editor_text(client) == appended,
                        f"Hemingway blocked safe insertion or changed exact Markdown: {editor_text(client)!r}")

                print("Checking per-tab native state and MCP edit refusal", flush=True)
                original_tab = client.execute(
                    "return document.querySelector('[role=\"tablist\"][aria-label=\"Documents\"] [role=\"tab\"][aria-selected=\"true\"]')?.dataset.tabId"
                )
                client.element_command(button(client, "New"), "/click")
                wait_for(client, "document.querySelectorAll('[role=\"tablist\"][aria-label=\"Documents\"] [role=\"tab\"]').length === 2", "second document tab")
                second_editor = active_editor(client)
                require(client.execute("return !document.querySelector('.editor-tab-host:not([hidden]) .cm-editor')?.classList.contains('cm-hemingway')"),
                        "A new native tab inherited Hemingway mode")
                client.element_command(second_editor, "/click")
                client.send_keys(second_editor, "Unlocked second tab")
                client.send_keys(second_editor, "\ue009a\ue000")
                client.element_command(button(client, "Hemingway mode"), "/click")
                wait_for(client, "document.querySelector('.editor-tab-host:not([hidden]) .cm-editor[data-hemingway=\"true\"]')", "second tab Hemingway mode")
                client.send_keys(active_editor(client), "blocked replacement")
                require(editor_text(client) == "Unlocked second tab",
                        "Hemingway allowed replacement through a retained selection")

                client.element_command(button(client, "Settings"), "/click")
                wait_for(client, "document.querySelector('dialog[aria-label=\"Settings\"]')?.open === true", "Settings dialog")
                agents = client.find("//dialog[@aria-label='Settings']//button[@role='tab' and normalize-space(.)='Agents']", using="xpath")
                client.element_command(agents, "/click")
                wait_for(client, "document.querySelector('[aria-label=\"Settings\"] .panel-status')?.innerText.includes('MCP ready')", "native MCP bridge readiness")
                agent_status = tooling_smoke.invoke(client, "agent_status", {})
                require(isinstance(agent_status, dict) and agent_status.get("ready"), f"MCP bridge is not ready: {agent_status!r}")
                socket_path = Path(agent_status["socketPath"])
                require(socket_path.is_socket(), f"Native MCP socket is missing: {socket_path}")
                command = [str(agent_status["command"]), *(str(item) for item in agent_status["args"])]
                mcp = tooling_smoke.McpStdio(command, env)
                try:
                    initialized = mcp.request("initialize", {
                        "protocolVersion": "2025-11-25", "capabilities": {},
                        "clientInfo": {"name": "Notation Hemingway smoke", "version": "1"},
                    })
                    require(initialized.get("result", {}).get("protocolVersion") == "2025-11-25",
                            f"MCP initialization failed: {initialized!r}")
                    mcp.notify("notifications/initialized")
                    tabs = mcp.call("list_tabs", {}).get("tabs", [])
                    locked = next((tab for tab in tabs if tab.get("id") == original_tab), None)
                    require(locked is not None,
                            f"Inactive Hemingway tab was not exposed to MCP: {tabs!r}")
                    refusal = mcp.call("edit_document", {
                        "tabId": original_tab,
                        "expectedContent": appended,
                        "content": "# MCP must not replace Hemingway text\n",
                    }, expect_error=True)
                    require("Hemingway" in refusal, f"MCP did not explain Hemingway refusal: {refusal!r}")
                    readback = mcp.call("read_tab", {"tabId": original_tab})
                    require(readback.get("content") == appended,
                            f"Rejected inactive MCP edit changed the Hemingway buffer: {readback!r}")
                    active_tab = client.execute(
                        "return document.querySelector('[role=\"tablist\"][aria-label=\"Documents\"] [role=\"tab\"][aria-selected=\"true\"]')?.dataset.tabId"
                    )
                    require(active_tab != original_tab, "MCP edit refusal changed the active tab")
                finally:
                    mcp.close()

                client.element_command(button(client, "Close settings"), "/click")
                client.element_command(button(client, "Hemingway mode"), "/click")
                wait_for(client, "!document.querySelector('.editor-tab-host:not([hidden]) .cm-editor')?.classList.contains('cm-hemingway')", "second tab mode exit")
                editor = active_editor(client)
                client.send_keys(editor, "replacement")
                require(editor_text(client) == "replacement",
                        f"Selection was not preserved or editing did not resume after mode exit: {editor_text(client)!r}")

                # Return to the first document, exit its independent lock, and
                # verify that ordinary source editing resumes there too.
                tab = client.find(f"//*[@role='tablist' and @aria-label='Documents']//*[@role='tab' and @data-tab-id='{original_tab}']", using="xpath")
                client.element_command(tab, "/click")
                wait_for(client, "document.querySelector('.editor-tab-host:not([hidden]) .cm-editor[data-hemingway=\"true\"]')", "first tab lock restored")
                client.element_command(button(client, "Hemingway mode"), "/click")
                wait_for(client, "!document.querySelector('.editor-tab-host:not([hidden]) .cm-editor')?.classList.contains('cm-hemingway')", "first tab mode exit")
                editor = active_editor(client)
                client.send_keys(editor, "\ue009\ue010\ue000")
                client.send_keys(editor, " editable")
                require(editor_text(client) == appended + " editable",
                        f"Normal editing did not resume on the original tab: {editor_text(client)!r}")
                print("Native Hemingway smoke passed: literal rendering, destructive edit protection, safe insertion, per-tab state, MCP refusal, and mode exit", flush=True)
            finally:
                try:
                    client.quit()
                except Exception as error:
                    print(f"WebDriver session cleanup failed: {error}", file=sys.stderr)
                if driver is not None and driver.poll() is None:
                    try:
                        os.killpg(driver.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        driver.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(driver.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        driver.wait(timeout=5)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=Path(os.environ.get("NOTATION_APP", str(Path.home() / ".local/bin/notation"))))
    args = parser.parse_args()
    try:
        run(args.app.expanduser().resolve())
    except Exception as error:
        print(f"NATIVE HEMINGWAY SMOKE FAILED: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
