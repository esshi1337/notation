#!/usr/bin/env python3
"""Smoke-test the installed Tauri application through its native WebDriver.

Usage:
    python3 tests/native/smoke.py --app /absolute/path/to/notation

The script uses only the Python standard library. It starts its own
tauri-driver, gives the application isolated XDG data/config directories, and
removes all temporary documents when it exits.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DRIVER = Path(os.environ["TAURI_DRIVER"]) if os.environ.get("TAURI_DRIVER") else Path(shutil.which("tauri-driver") or "tauri-driver")
WEBDRIVER = Path(os.environ["WEBKIT_WEBDRIVER"]) if os.environ.get("WEBKIT_WEBDRIVER") else Path(shutil.which("WebKitWebDriver") or "/usr/bin/WebKitWebDriver")
DRIVER_PORT = 4445
NATIVE_PORT = 4446
BASE_URL = f"http://127.0.0.1:{DRIVER_PORT}"
ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf"
TIMEOUT_SECONDS = 45


class WebDriverError(RuntimeError):
    pass


class Client:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url
        self.session_id: str | None = None
        self.element_selectors: dict[str, str] = {}

    def request(
        self,
        method: str,
        route: str,
        body: dict[str, Any] | None = None,
        *,
        timeout: float = TIMEOUT_SECONDS,
    ) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(
            self.base_url + route,
            data=data,
            method=method,
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                raw = response.read()
        except HTTPError as error:
            raw = error.read()
            raise WebDriverError(
                f"WebDriver {method} {route} returned HTTP {error.code}: "
                f"{raw.decode('utf-8', errors='replace')}"
            ) from error
        except (URLError, TimeoutError, OSError) as error:
            raise WebDriverError(f"WebDriver {method} {route} failed: {error}") from error

        if not raw:
            return None
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as error:
            raise WebDriverError(
                f"WebDriver {method} {route} returned invalid JSON: "
                f"{raw.decode('utf-8', errors='replace')}"
            ) from error
        if isinstance(payload, dict):
            value = payload.get("value")
            if isinstance(value, dict) and value.get("error"):
                raise WebDriverError(f"WebDriver {method} {route}: {value}")
        return payload.get("value", payload) if isinstance(payload, dict) else payload

    def create_session(self, app: Path) -> str:
        value = self.request(
            "POST",
            "/session",
            {
                "capabilities": {
                    "alwaysMatch": {
                        "tauri:options": {
                            "application": str(app),
                            "args": [],
                            "webviewOptions": {},
                        },
                    }
                }
            },
            timeout=90,
        )
        session_id = value.get("sessionId") if isinstance(value, dict) else None
        if not session_id:
            raise WebDriverError(f"WebDriver did not return a session id: {value!r}")
        self.session_id = session_id
        return session_id

    def command(self, method: str, suffix: str, body: dict[str, Any] | None = None) -> Any:
        if not self.session_id:
            raise WebDriverError("No active WebDriver session")
        return self.request(method, f"/session/{self.session_id}{suffix}", body)

    def execute(self, script: str, args: list[Any] | None = None) -> Any:
        return self.command("POST", "/execute/sync", {"script": script, "args": args or []})

    def execute_async(self, script: str, args: list[Any] | None = None) -> Any:
        return self.command("POST", "/execute/async", {"script": script, "args": args or []})

    def find(self, selector: str, *, using: str = "css selector") -> str:
        try:
            value = self.command("POST", "/element", {"using": using, "value": selector})
        except WebDriverError as error:
            raise WebDriverError(f"Finding {using} {selector!r} failed: {error}") from error
        element_id = value.get(ELEMENT_KEY) if isinstance(value, dict) else None
        if not element_id:
            raise WebDriverError(f"Could not find {using} {selector!r}: {value!r}")
        self.element_selectors[element_id] = f"{using} {selector!r}"
        return element_id

    def element_command(self, element_id: str, suffix: str, body: dict[str, Any] | None = None) -> Any:
        selector = self.element_selectors.get(element_id, f"element id {element_id}")
        try:
            return self.command("POST", f"/element/{element_id}{suffix}", body if body is not None else {})
        except WebDriverError as error:
            raise WebDriverError(f"Command {suffix!r} on {selector} failed: {error}") from error

    def send_keys(self, element_id: str, text: str) -> None:
        self.element_command(
            element_id,
            "/value",
            # Include both W3C fields for compatibility with WebKitWebDriver
            # builds that consume either representation.
            {"text": text, "value": list(text)},
        )

    def screenshot(self, destination: Path) -> None:
        value = self.command("GET", "/screenshot")
        if not isinstance(value, str):
            raise WebDriverError(f"Screenshot response was not base64 text: {value!r}")
        destination.write_bytes(base64.b64decode(value, validate=True))

    def quit(self) -> None:
        if self.session_id:
            try:
                self.command("DELETE", "")
            finally:
                self.session_id = None


def wait_for_driver(process: subprocess.Popen[bytes], log_path: Path) -> None:
    deadline = time.monotonic() + TIMEOUT_SECONDS
    last_error = "not ready"
    while time.monotonic() < deadline:
        if process.poll() is not None:
            detail = log_path.read_text(errors="replace") if log_path.exists() else ""
            raise WebDriverError(
                f"tauri-driver exited with code {process.returncode} before becoming ready.\n"
                f"{detail}"
            )
        try:
            with urlopen(BASE_URL + "/status", timeout=1) as response:
                if response.status == 200:
                    return
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            last_error = str(error)
        time.sleep(0.2)
    detail = log_path.read_text(errors="replace") if log_path.exists() else ""
    raise WebDriverError(f"tauri-driver did not become ready: {last_error}\n{detail}")


def assert_ports_available() -> None:
    for port in (DRIVER_PORT, NATIVE_PORT):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                listener.bind(("127.0.0.1", port))
            except OSError as error:
                raise WebDriverError(f"Required isolated WebDriver port {port} is unavailable: {error}") from error


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def wait_for(client: Client, expression: str, description: str, timeout: float = 20) -> Any:
    deadline = time.monotonic() + timeout
    last: Any = None
    while time.monotonic() < deadline:
        last = client.execute(f"return Boolean({expression})")
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"Timed out waiting for {description}; last result: {last!r}")


def editor_text(client: Client) -> str:
    return client.execute(
        "const editor = document.querySelector('.editor-tab-host:not([hidden]) .cm-content'); "
        "return Array.from(editor?.querySelectorAll('.cm-line') ?? [])"
        ".map(line => line.textContent).join(String.fromCharCode(10))"
    )


def active_editor(client: Client) -> str:
    return client.find('.editor-tab-host:not([hidden]) [aria-label="Document source"]')


def active_tab_button(client: Client) -> str:
    return client.find("[role='tablist'][aria-label='Documents'] [role='tab'][aria-selected='true']")


def wait_for_active_tab(client: Client, name: str) -> None:
    expression = "document.querySelector('[role=tablist][aria-label=Documents] [role=tab][aria-selected=true]')?.getAttribute('aria-label') === " + json.dumps(name)
    wait_for(client, expression, f"active tab {name}")


def rename_document(client: Client, name: str) -> None:
    client.element_command(button(client, "Rename document"), "/click")
    wait_for(client, "document.querySelector('dialog[aria-label=\\\"Rename document\\\"]')?.open === true", "Rename document dialog")
    field = client.find("[aria-label='Document name']")
    client.element_command(field, "/clear")
    client.send_keys(field, name)
    client.element_command(button(client, "Rename"), "/click")
    wait_for(client, f"document.querySelector('[role=\\\"tablist\\\"][aria-label=\\\"Documents\\\"] [role=\\\"tab\\\"][aria-label={json.dumps(name)}][aria-selected=\\\"true\\\"]')",
             f"renamed active tab to {name}")


def button(client: Client, name: str) -> str:
    try:
        return client.find(f"//button[@aria-label='{name}' or normalize-space(.)='{name}']", using="xpath")
    except WebDriverError:
        # Top-level actions are command-palette entries in the current UI;
        # panel buttons (Close, Save script, and so on) remain direct controls.
        launcher = client.find("//button[@aria-label='Commands' or normalize-space(.)='Commands']", using="xpath")
        client.element_command(launcher, "/click")
        search = client.find("[aria-label='Search commands']")
        client.element_command(search, "/clear")
        client.send_keys(search, name)
        escaped = json.dumps(name)
        wait_for(
            client,
            f"Array.from(document.querySelectorAll('[role=\\\"listbox\\\"][aria-label=\\\"Commands\\\"] [role=\\\"option\\\"]')).some(e => (e.getAttribute('aria-label') || e.innerText.trim()) === {escaped})",
            f"command palette result {name}",
        )
        try:
            return client.find(f"//*[@role='listbox' and @aria-label='Commands']//*[@role='option' and @aria-label='{name}']", using="xpath")
        except WebDriverError:
            return client.find(f"//*[@role='dialog' and @aria-label='Commands']//button[@aria-label='{name}' or normalize-space(.)='{name}']", using="xpath")


def menuitem(client: Client, name: str) -> str:
    return client.find(
        f"//*[@role='listbox' and @aria-label='Commands']//*[@role='option' and @aria-label='{name}']",
        using="xpath",
    )


def attribute(client: Client, element_id: str, name: str) -> Any:
    return client.command("GET", f"/element/{element_id}/attribute/{name}")


def fill_control(client: Client, selector: str, text: str) -> str:
    element_id = client.find(selector)
    client.element_command(element_id, "/clear")
    if text:
        client.send_keys(element_id, text)
    return element_id


def replace_editor_text(client: Client, element_id: str, text: str) -> None:
    client.element_command(element_id, "/click")
    client.send_keys(element_id, "\ue009a\ue000")
    lines = text.split("\n")
    for index, line in enumerate(lines):
        if line:
            client.send_keys(element_id, line)
        if index < len(lines) - 1:
            client.send_keys(element_id, "\ue007")
            # CodeMirror may add indentation after Enter; remove only that
            # generated whitespace before sending the next literal Markdown line.
            client.send_keys(element_id, "\ue011")
            client.send_keys(element_id, "\ue008\ue010")
            client.send_keys(element_id, "\ue017")


def invoke_document(client: Client, command: str, path: Path, content: str | None = None) -> Any:
    args: dict[str, str] = {"path": str(path)}
    if content is not None:
        args["content"] = content
    script = """
const done = arguments[arguments.length - 1];
const command = arguments[0];
const args = arguments[1];
const internals = window.__TAURI_INTERNALS__;
if (!internals || typeof internals.invoke !== 'function') {
  done({ __webdriverError: 'Tauri invoke bridge is unavailable' });
} else {
  internals.invoke(command, args).then(
    value => done({ value }),
    error => done({ __webdriverError: String(error) })
  );
}
"""
    result = client.execute_async(script, [command, args])
    if not isinstance(result, dict) or "__webdriverError" in result:
        raise WebDriverError(f"Native invoke {command} failed: {result!r}")
    return result.get("value")


def run(app: Path) -> None:
    if not app.exists() or not os.access(app, os.X_OK):
        raise FileNotFoundError(f"App launcher does not exist or is not executable: {app}")
    if not DRIVER.is_file() or not os.access(DRIVER, os.X_OK):
        raise FileNotFoundError(f"tauri-driver is not executable: {DRIVER}")
    if not WEBDRIVER.is_file() or not os.access(WEBDRIVER, os.X_OK):
        raise FileNotFoundError(f"WebKitWebDriver is not executable: {WEBDRIVER}")

    output = Path(__file__).resolve().parents[2] / "test-results" / "notation-native.png"
    output.parent.mkdir(parents=True, exist_ok=True)
    client = Client(BASE_URL)
    driver: subprocess.Popen[bytes] | None = None
    driver_log = None
    assert_ports_available()

    with tempfile.TemporaryDirectory(prefix="notation-native-smoke-") as temporary:
        root = Path(temporary)
        xdg_data = root / "data"
        xdg_config = root / "config"
        xdg_data.mkdir()
        xdg_config.mkdir()
        env = os.environ.copy()
        env["XDG_DATA_HOME"] = str(xdg_data)
        env["XDG_CONFIG_HOME"] = str(xdg_config)
        env["TAURI_WEBVIEW_AUTOMATION"] = "true"
        driver_log_path = root / "tauri-driver.log"
        driver_log = driver_log_path.open("wb")

        try:
            driver = subprocess.Popen(
                [
                    str(DRIVER),
                    "--port",
                    str(DRIVER_PORT),
                    "--native-port",
                    str(NATIVE_PORT),
                    "--native-driver",
                    str(WEBDRIVER),
                ],
                stdin=subprocess.DEVNULL,
                stdout=driver_log,
                stderr=subprocess.STDOUT,
                env=env,
                start_new_session=True,
            )
            wait_for_driver(driver, driver_log_path)
            session_id = client.create_session(app)
            print(f"WebDriver session started: {session_id}")

            wait_for(client, "document.querySelector('main.app')", "packaged app's initial UI")
            page = client.execute(
                "return {href: location.href, title: document.title, text: document.body.innerText}"
            )
            require(isinstance(page, dict), f"Could not inspect packaged app page: {page!r}")
            href = page.get("href", "")
            require("localhost:1420" not in href, f"App loaded a development server: {href}")
            require("tauri.localhost" in href or href.startswith("tauri://"), f"Unexpected packaged app URL: {href}")
            require("Notation" in page.get("text", ""), "Notation UI did not render")
            require("Browser mode" not in page.get("text", ""), "Packaged app displayed the Browser mode label")
            require("SOURCE" in page.get("text", "") and "PREVIEW" in page.get("text", ""), "Source/preview panes did not render")
            print(f"Packaged UI loaded at {href}")

            wait_for(client, "document.querySelector('.diagram svg')", "initial Mermaid diagram")
            initial = client.execute("return document.querySelector('.diagram').innerText")
            require("An idea" in initial and "Make a note" in initial and "Connect the dots" in initial,
                    f"Initial Mermaid diagram did not render its labels: {initial!r}")

            original_markdown = editor_text(client)
            client.element_command(button(client, "Live Preview"), "/click")
            wait_for(client, "document.querySelector('.cm-live-preview')", "Live Preview editor")
            wait_for(client, "document.querySelector('.cm-live-mermaid svg')", "inline Mermaid diagram")
            live_diagram = client.execute("return document.querySelector('.cm-live-mermaid').innerText")
            require("An idea" in live_diagram and "Make a note" in live_diagram and "Connect the dots" in live_diagram,
                    f"Inline Mermaid diagram did not render its labels: {live_diagram!r}")

            widget = client.find(".cm-live-mermaid[role='button']")
            client.element_command(widget, "/click")
            wait_for(client, "!document.querySelector('.cm-live-mermaid')", "editable Mermaid source")
            revealed_source = editor_text(client)
            require("```mermaid" in revealed_source and "A[An idea] --> B[Make a note]" in revealed_source,
                    f"Clicking the Mermaid widget did not reveal its editable Markdown source: {revealed_source!r}")

            document_name = active_tab_button(client)
            client.element_command(document_name, "/click")
            wait_for(client, "document.querySelector('.cm-live-mermaid svg')", "diagram restored after leaving its source")

            client.element_command(button(client, "Source"), "/click")
            wait_for(client, "document.querySelector('.preview-pane')?.hidden === true", "Source layout")
            source_markdown = editor_text(client)
            require(source_markdown == original_markdown,
                    f"Switching through widget/source changed Markdown:\nexpected {original_markdown!r}\nactual {source_markdown!r}")
            client.element_command(button(client, "Live Preview"), "/click")
            wait_for(client, "document.querySelector('.cm-live-mermaid svg')", "restored inline Mermaid diagram")
            client.element_command(button(client, "Source"), "/click")
            wait_for(client, "document.querySelector('.editor-tab-host:not([hidden]) .cm-content .cm-line')", "source editor after Live Preview")
            require(editor_text(client) == original_markdown, "Toggling Live Preview changed the exact Markdown source")
            print("Live Preview rendered Mermaid, revealed editable source, and preserved exact Markdown across mode changes")

            editor = active_editor(client)
            # Exercise the slash command as a single undoable edit.
            print("Running native slash command smoke", flush=True)
            editor = active_editor(client)
            replace_editor_text(client, editor, "")
            editor = active_editor(client)
            client.send_keys(editor, "/todo")
            wait_for(client, "document.querySelector('[role=\"listbox\"][aria-label=\"Slash commands\"]')", "slash command menu")
            client.execute_async(
                "const done = arguments[arguments.length - 1]; "
                "requestAnimationFrame(() => requestAnimationFrame(done));"
            )
            task_option = client.find("//*[@role='listbox' and @aria-label='Slash commands']//*[@role='option' and normalize-space(.)='Task list']", using="xpath")
            option_rect = client.execute(
                "const option = Array.from(document.querySelectorAll('[role=\"option\"]')).find(element => element.textContent.trim() === 'Task list'); "
                "if (!option) return null; "
                "const rect = option.getBoundingClientRect(); "
                "return {text: option.innerText, x: rect.x, y: rect.y, width: rect.width, height: rect.height, "
                "viewportWidth: innerWidth, viewportHeight: innerHeight};"
            )
            print(f"Slash Task list option geometry: {option_rect}", flush=True)
            try:
                client.element_command(task_option, "/click")
            except WebDriverError:
                screenshot = output.with_name("notation-native-slash-menu-failure.png")
                client.screenshot(screenshot)
                print(f"Slash menu failure screenshot saved to {screenshot}", flush=True)
                raise
            inserted_task = editor_text(client)
            require("- [ ]" in inserted_task, f"Task list slash command did not insert its template: {inserted_task!r}")
            print(f"Slash task template inserted: {inserted_task!r}", flush=True)
            source_state = client.execute(
                "return {labelCount: document.querySelectorAll('[aria-label=\\\"Document source\\\"]').length, "
                "editable: Array.from(document.querySelectorAll('.cm-content')).map(element => ({label: element.getAttribute('aria-label'), "
                "contenteditable: element.getAttribute('contenteditable'), text: element.innerText})), "
                "active: document.activeElement?.outerHTML, "
                "layout: document.querySelector('.source-pane .pane-heading span')?.innerText}"
            )
            print(f"Native source DOM after slash command: {json.dumps(source_state, ensure_ascii=False)}", flush=True)
            editor = active_editor(client)
            client.element_command(editor, "/click")
            client.send_keys(editor, "\ue009z\ue000")
            require(editor_text(client) == "/todo", f"Undo did not restore the slash command query: {editor_text(client)!r}")

            # Block actions duplicate a whole paragraph and undo it as one edit.
            print("Running native block action smoke", flush=True)
            paragraph_text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph."
            editor = active_editor(client)
            replace_editor_text(client, editor, paragraph_text)
            second_line = client.find("//div[contains(@class,'cm-line') and contains(.,'Second paragraph.')]", using="xpath")
            client.element_command(second_line, "/click")
            click_state = client.execute(
                "return {activeLines: Array.from(document.querySelectorAll('.cm-activeLine')).map(line => line.innerText), "
                "activeLabel: document.activeElement?.getAttribute('aria-label'), "
                "selectionText: window.getSelection()?.toString()}"
            )
            print(f"Block action selection after line click: {click_state}", flush=True)
            if not any("Second paragraph." in line for line in click_state.get("activeLines", [])):
                print("WebDriver click did not place the caret on the requested line; using keyboard line navigation", flush=True)
                editor = active_editor(client)
                client.element_command(editor, "/click")
                client.send_keys(editor, "\ue009\ue011\ue000")
                client.send_keys(editor, "\ue015\ue015")
                click_state = client.execute(
                    "return {activeLines: Array.from(document.querySelectorAll('.cm-activeLine')).map(line => line.innerText), "
                    "activeLabel: document.activeElement?.getAttribute('aria-label'), "
                    "selectionText: window.getSelection()?.toString()}"
                )
                print(f"Block action selection after keyboard navigation: {click_state}", flush=True)
            require(any("Second paragraph." in line for line in click_state.get("activeLines", [])),
                    f"Could not place native editor selection on Second paragraph: {click_state!r}")
            client.element_command(button(client, "Block actions"), "/click")
            client.element_command(menuitem(client, "Duplicate"), "/click")
            duplicated = editor_text(client)
            require(duplicated.count("Second paragraph.") == 2,
                    f"Block duplicate did not copy the selected paragraph: {duplicated!r}")
            editor = active_editor(client)
            client.element_command(editor, "/click")
            client.send_keys(editor, "\ue009z\ue000")
            require(editor_text(client) == paragraph_text,
                    f"Undo did not remove the duplicated paragraph: {editor_text(client)!r}")

            # Fold, unfold, and edit the callout while preserving its source.
            print("Running native callout smoke", flush=True)
            callout_markdown = "# Notes\n\n> [!NOTE]- Details\n> Hidden **content**.\n\nEnd.\n"
            editor = active_editor(client)
            replace_editor_text(client, editor, callout_markdown)
            client.element_command(button(client, "Preview"), "/click")
            wait_for(client, "document.querySelector('[aria-label=\"Callout: Details\"]')", "Preview callout region")
            preview_toggle = client.find("[aria-label='Toggle callout: Details']")
            require(attribute(client, preview_toggle, "aria-expanded") == "false", "Folded callout started expanded")
            client.element_command(preview_toggle, "/click")
            preview_toggle = client.find("[aria-label='Toggle callout: Details']")
            require(attribute(client, preview_toggle, "aria-expanded") == "true", "Preview callout did not expand")
            require(editor_text(client) == callout_markdown, "Preview callout toggle changed Markdown")
            client.element_command(button(client, "Live Preview"), "/click")
            wait_for(client, "document.querySelector('.cm-live-callout')", "Live Preview callout widget")
            live_toggle = client.find(".cm-live-callout [aria-label='Toggle callout: Details']")
            require(attribute(client, live_toggle, "aria-expanded") == "true", "Expanded callout state was not retained in Live Preview")
            edit_callout = client.find(".cm-live-callout [aria-label='Edit callout']")
            client.element_command(edit_callout, "/click")
            wait_for(client, "!document.querySelector('.cm-live-callout')", "editable callout source")
            revealed_callout = editor_text(client)
            require("> [!NOTE]- Details" in revealed_callout and "> Hidden **content**." in revealed_callout,
                    f"Editing the callout did not reveal its raw source: {revealed_callout!r}")
            client.element_command(button(client, "Source"), "/click")
            wait_for(client, "document.querySelector('.preview-pane')?.hidden === true", "Source after callout edit")
            require(editor_text(client) == callout_markdown,
                    f"Editing the callout changed canonical Markdown: {editor_text(client)!r}")
            client.element_command(button(client, "Live Preview"), "/click")
            wait_for(client, "document.querySelector('.cm-live-callout')", "callout restored after source mode")
            client.element_command(document_name, "/click")
            wait_for(client, "document.querySelector('.cm-live-callout')", "blurred callout restored")
            print("Running native Scripts panel smoke", flush=True)
            client.element_command(button(client, "Source"), "/click")
            wait_for(client, "document.querySelector('.preview-pane')?.hidden === true", "Source after callout edit")

            edited_markdown = (
                "# Native smoke edit\n\n"
                "- [ ] Finish notes\n"
                "- [x] Keep completed\n"
                "[] Bare task\n"
                "[x] Bare done\n\n"
                "Inline $x^2 + \\alpha$ here.\n\n"
                "$$\n"
                "\\frac{1}{2} + \\sum_{i=1}^{n} i\n"
                "$$\n\n"
                "> [!TIP]- Script output\n"
                "> Native worker wrote script-test.md.\n\n"
                "```mermaid\nflowchart LR\n  A[Native smoke] --> B[Verified]\n```\n"
            )
            replace_editor_text(client, editor, edited_markdown)
            typed_markdown = editor_text(client)
            require(typed_markdown == edited_markdown,
                    f"WebDriver key input produced different Markdown:\nexpected {edited_markdown!r}\nactual {typed_markdown!r}")
            client.element_command(button(client, "Live Preview"), "/click")
            wait_for(client, "document.querySelector('.cm-live-preview')", "edited Live Preview editor")
            wait_for(client, "document.querySelectorAll('.cm-live-math .katex').length === 2", "inline and display KaTeX")
            wait_for(client, "document.querySelector('.cm-live-mermaid svg')", "edited Live Preview Mermaid diagram")
            wait_for(
                client,
                "document.querySelector('.cm-live-mermaid')?.innerText.includes('Verified')",
                "edited Mermaid labels in Live Preview",
            )
            rendered = client.execute("return document.querySelector('.cm-live-preview').innerText")
            require("Native smoke edit" in rendered, f"Typed heading did not appear in Live Preview: {rendered!r}")
            require("Verified" in rendered, f"Typed Mermaid diagram did not appear in Live Preview: {rendered!r}")

            math_fonts_loaded = client.execute_async(
                "const done = arguments[arguments.length - 1]; "
                "document.fonts.ready.then(() => done(document.fonts.check('16px KaTeX_Main')));"
            )
            require(math_fonts_loaded is True, "Local KaTeX math fonts did not load in the native app")

            pending_task = client.find("input.task-checkbox[aria-label='Task: Finish notes']")
            client.element_command(pending_task, "/click")
            wait_for(
                client,
                "document.querySelector('input.task-checkbox[aria-label=\\\"Task: Finish notes\\\"]')?.checked === true",
                "Live task checkbox toggle",
            )
            client.element_command(button(client, "Source"), "/click")
            wait_for(client, "document.querySelector('.preview-pane')?.hidden === true", "Source after task toggle")
            toggled_markdown = edited_markdown.replace("- [ ] Finish notes", "- [x] Finish notes", 1)
            require(editor_text(client) == toggled_markdown,
                    f"Clicking the Live checkbox did not update canonical source:\nexpected {toggled_markdown!r}\nactual {editor_text(client)!r}")
            editor = active_editor(client)
            client.element_command(editor, "/click")
            client.send_keys(editor, "\ue009z\ue000")
            require(editor_text(client) == edited_markdown,
                    f"One-step undo did not restore the unchecked task:\nexpected {edited_markdown!r}\nactual {editor_text(client)!r}")

            client.element_command(button(client, "Live Preview"), "/click")
            wait_for(client, "document.querySelectorAll('.cm-live-math .katex').length === 2", "math after task undo")
            inline_math = client.find(".cm-live-math[role='button'][aria-label='Edit inline equation']")
            client.element_command(inline_math, "/click")
            wait_for(client, "!document.querySelector('.cm-live-math[aria-label=\\\"Edit inline equation\\\"]')", "editable inline math source")
            inline_source = editor_text(client)
            require("Inline $x^2 + \\alpha$ here." in inline_source,
                    f"Clicking inline math did not reveal its raw source: {inline_source!r}")
            client.element_command(document_name, "/click")
            wait_for(client, "document.querySelector('.cm-live-math[aria-label=\\\"Edit inline equation\\\"] .katex')", "inline math restored after blur")

            block_math = client.find(".cm-live-math[role='button'][aria-label='Edit block equation']")
            client.element_command(block_math, "/click")
            wait_for(client, "!document.querySelector('.cm-live-math[aria-label=\\\"Edit block equation\\\"]')", "editable display math source")
            block_source = editor_text(client)
            require("\\frac{1}{2}" in block_source and "\\sum_{i=1}^{n} i" in block_source,
                    f"Clicking display math did not reveal its raw source: {block_source!r}")
            client.element_command(document_name, "/click")
            wait_for(client, "document.querySelector('.cm-live-math[aria-label=\\\"Edit block equation\\\"] .katex-display')", "display math restored after blur")

            client.element_command(button(client, "Preview"), "/click")
            wait_for(client, "document.querySelectorAll('.preview-pane .katex').length === 2", "reading preview KaTeX")
            require(client.execute("return document.querySelectorAll('.preview-pane .katex-display').length") == 1,
                    "Display math did not render as a block in the reading preview")
            client.element_command(button(client, "Live Preview"), "/click")
            wait_for(client, "document.querySelectorAll('.cm-live-math .katex').length === 2", "Live Preview restored after reading preview")
            client.element_command(document_name, "/click")
            wait_for(client, "document.querySelector('.cm-live-mermaid svg')", "blurred Live Preview Mermaid diagram")
            print("Native tasks toggle/undo, inline/display math, Mermaid, and exact source checks passed")

            client.element_command(button(client, "Source"), "/click")
            editor = active_editor(client)
            script_document = "hello script"
            replace_editor_text(client, editor, script_document)
            require(editor_text(client) == script_document, "Could not prepare the native script document")
            client.element_command(button(client, "Scripts"), "/click")
            wait_for(client, "document.querySelector('[role=\\\"dialog\\\"][aria-label=\\\"Scripts\\\"]')", "Scripts dialog")
            fill_control(client, '[aria-label="Script name"]', "Native smoke")
            fill_control(client, '[aria-label="Working directory"]', str(root))
            script_code = (
                "api.writeText('script-test.md', '# Script'); "
                "const result = api.run('printf', ['hello']); "
                "console.log(result.stdout); "
                "return {text: api.readText('script-test.md')};"
            )
            fill_control(client, '[aria-label="Script code"]', script_code)
            client.element_command(button(client, "Run script"), "/click")
            wait_for(client, "document.querySelector('[role=\\\"dialog\\\"][aria-label=\\\"Scripts\\\"]')?.innerText.includes('hello')", "native script output")
            require((root / "script-test.md").read_text(encoding="utf-8") == "# Script",
                    "Native api.writeText did not create script-test.md in its working directory")
            require(client.execute("return !document.querySelector('[role=dialog] button[aria-label=\\\"Apply to document\\\"]')?.disabled"),
                    "Successful native script did not enable Apply to document")
            client.element_command(button(client, "Apply to document"), "/click")
            client.element_command(button(client, "Close scripts"), "/click")
            require(editor_text(client) == "# Script",
                    f"Script result did not replace the document: {editor_text(client)!r}")
            editor = active_editor(client)
            client.element_command(editor, "/click")
            client.send_keys(editor, "\ue009z\ue000")
            require(editor_text(client) == script_document,
                    f"Undo did not restore the pre-script document: {editor_text(client)!r}")

            editor = active_editor(client)
            replace_editor_text(client, editor, edited_markdown)
            require(editor_text(client) == edited_markdown, "Could not restore the native feature fixture")
            client.element_command(button(client, "Live Preview"), "/click")
            wait_for(client, "document.querySelector('.cm-live-callout') && document.querySelector('.cm-live-mermaid svg')", "Live Preview callout and Mermaid")
            wait_for(client, "document.querySelectorAll('.cm-live-math .katex').length === 2", "Live Preview math after script undo")
            screenshot_callout = client.find(".cm-live-callout [aria-label='Toggle callout: Script output']")
            if attribute(client, screenshot_callout, "aria-expanded") == "false":
                client.element_command(screenshot_callout, "/click")
            screenshot_callout = client.find(".cm-live-callout [aria-label='Toggle callout: Script output']")
            require(attribute(client, screenshot_callout, "aria-expanded") == "true", "Could not expand the screenshot callout")
            client.element_command(document_name, "/click")
            wait_for(client, "document.querySelector('.cm-live-callout') && document.querySelector('.cm-live-mermaid svg')", "blurred native feature screenshot")

            fixtures = [
                (root / "roundtrip.md", "# Native Markdown\n\noriginal content\n", "# Native Markdown\n\nsaved through native invoke\n"),
                (root / "roundtrip.mmd", "flowchart LR\n  A[Start] --> B[Finish]\n", "flowchart LR\n  A[Native save] --> B[Verified]\n"),
            ]
            for path, original, replacement in fixtures:
                path.write_text(original, encoding="utf-8")
                loaded = invoke_document(client, "read_document", path)
                require(loaded == {"path": str(path), "content": original},
                        f"read_document returned an unexpected document for {path.name}: {loaded!r}")
                saved = invoke_document(client, "write_document", path, replacement)
                require(saved == {"path": str(path), "content": replacement},
                        f"write_document returned an unexpected document for {path.name}: {saved!r}")
                require(path.read_text(encoding="utf-8") == replacement,
                        f"Native write_document did not persist {path.name} to disk")
                print(f"Native read/write invoke passed for {path.suffix}")

            client.execute_async(
                "const done = arguments[arguments.length - 1]; "
                "requestAnimationFrame(() => requestAnimationFrame(done));"
            )
            live_state = client.execute(
                "return {live: Boolean(document.querySelector('.cm-live-preview')), "
                "numberedGutter: Boolean(document.querySelector('.cm-live-preview .cm-lineNumbers')), "
                "diagram: Boolean(document.querySelector('.cm-live-mermaid svg')), "
                "mathCount: document.querySelectorAll('.cm-live-math .katex').length, "
                "taskCount: document.querySelectorAll('.cm-live-preview input.task-checkbox').length, "
                "calloutCount: document.querySelectorAll('.cm-live-callout .callout').length}"
            )
            require(live_state == {"live": True, "numberedGutter": False, "diagram": True, "mathCount": 2, "taskCount": 4, "calloutCount": 1},
                    f"Native screenshot is not in the expected unnumbered Live Preview state: {live_state!r}")
            client.screenshot(output)
            require(output.is_file() and output.stat().st_size > 1000,
                    f"Native screenshot is missing or unexpectedly small: {output}")
            print(f"Native screenshot saved to {output}")

            def capture_settled(destination: Path) -> None:
                client.execute_async(
                    "const done = arguments[arguments.length - 1]; "
                    "requestAnimationFrame(() => requestAnimationFrame(done));"
                )
                client.screenshot(destination)

            commands_shot = output.with_name("notation-native-commands.png")
            client.element_command(button(client, "Commands"), "/click")
            wait_for(client, "document.querySelector('dialog[aria-label=\\\"Commands\\\"]')?.open === true", "native Commands palette screenshot")
            capture_settled(commands_shot)
            client.element_command(client.find("dialog[aria-label='Commands'] [aria-label='Close commands']"), "/click")
            wait_for(client, "!document.querySelector('dialog[aria-label=\\\"Commands\\\"]')?.open", "Commands palette closed after screenshot")

            settings_shot = output.with_name("notation-native-settings.png")
            client.element_command(button(client, "Settings"), "/click")
            wait_for(client, "document.querySelector('dialog[aria-label=\\\"Settings\\\"]')?.open === true", "native Settings screenshot")
            capture_settled(settings_shot)
            print(f"Native Commands and Settings screenshots saved to {commands_shot} and {settings_shot}")
        finally:
            try:
                client.quit()
            except Exception as error:  # Keep teardown moving; include the exact failure.
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
            if driver_log:
                driver_log.close()
            if driver_log_path.exists():
                detail = driver_log_path.read_text(errors="replace").strip()
                if detail:
                    print("tauri-driver log:", file=sys.stderr)
                    print(detail, file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--app",
        type=Path,
        default=Path(os.environ.get("NOTATION_APP", str(Path.home() / ".local/bin/notation"))),
        help="absolute installed launcher or AppImage path",
    )
    args = parser.parse_args()
    try:
        run(args.app.expanduser().resolve())
    except Exception as error:
        print(f"NATIVE SMOKE FAILED: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
