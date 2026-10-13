#!/usr/bin/env python3
"""Smoke-test native Explorer, read-only Git, and the stdio MCP bridge."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import sqlite3
import subprocess
import sys
import tempfile

import smoke


class McpStdio:
    def __init__(self, command: list[str], env: dict[str, str]) -> None:
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                        bufsize=1, env=env)
        self.sequence = 0

    def send(self, message: dict[str, object]) -> None:
        if self.process.stdin is None:
            raise smoke.WebDriverError("MCP stdio input is unavailable")
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def response(self, request_id: int, timeout: float = 15) -> dict[str, object]:
        if self.process.stdout is None:
            raise smoke.WebDriverError("MCP stdio output is unavailable")
        ready, _, _ = select.select([self.process.stdout], [], [], timeout)
        if not ready:
            raise smoke.WebDriverError(f"MCP request {request_id} timed out")
        line = self.process.stdout.readline()
        if not line:
            detail = self.process.stderr.read() if self.process.stderr else ""
            raise smoke.WebDriverError(f"MCP stdio closed awaiting {request_id}; stderr={detail!r}")
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise smoke.WebDriverError(f"MCP emitted non-JSON stdout: {line!r}") from error
        if value.get("id") != request_id:
            raise smoke.WebDriverError(f"MCP response id mismatch: expected {request_id}, got {value!r}")
        return value

    def request(self, method: str, params: dict[str, object] | None = None) -> dict[str, object]:
        self.sequence += 1
        message: dict[str, object] = {"jsonrpc": "2.0", "id": self.sequence, "method": method}
        if params is not None:
            message["params"] = params
        self.send(message)
        response = self.response(self.sequence)
        if "error" in response:
            raise smoke.WebDriverError(f"MCP {method} failed: {response['error']!r}")
        return response

    def notify(self, method: str) -> None:
        self.send({"jsonrpc": "2.0", "method": method})

    def call(self, name: str, arguments: dict[str, object], *, expect_error: bool = False) -> object:
        response = self.request("tools/call", {"name": name, "arguments": arguments})
        result = response.get("result")
        if not isinstance(result, dict) or bool(result.get("isError")) != expect_error:
            raise smoke.WebDriverError(f"MCP {name} returned an unexpected result: {result!r}")
        if expect_error:
            return " ".join(item.get("text", "") for item in result.get("content", []) if isinstance(item, dict))
        value = result.get("structuredContent")
        return value["data"] if isinstance(value, dict) and set(value) == {"data"} else value

    def close(self) -> None:
        if self.process.poll() is None:
            if self.process.stdin:
                self.process.stdin.close()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)


def invoke(client: smoke.Client, command: str, arguments: dict[str, object]) -> object:
    script = """
const done = arguments[arguments.length - 1];
window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(
  value => done({ value }), error => done({ error: String(error) })
);
"""
    value = client.execute_async(script, [command, arguments])
    if not isinstance(value, dict) or "error" in value:
        raise smoke.WebDriverError(f"Native invoke {command} failed: {value!r}")
    return value.get("value")


def wait_for_tabs(client: smoke.Client, count: int) -> None:
    smoke.wait_for(client, f"document.querySelectorAll('[role=\\\"tablist\\\"][aria-label=\\\"Documents\\\"] [role=\\\"tab\\\"]').length === {count}",
                   f"{count} document tabs")


def run(app: Path) -> None:
    if not app.exists() or not os.access(app, os.X_OK):
        raise FileNotFoundError(f"App launcher is missing or not executable: {app}")
    if not smoke.DRIVER.is_file() or not os.access(smoke.DRIVER, os.X_OK):
        raise FileNotFoundError(f"tauri-driver is not executable: {smoke.DRIVER}")
    if not smoke.WEBDRIVER.is_file() or not os.access(smoke.WEBDRIVER, os.X_OK):
        raise FileNotFoundError(f"WebKitWebDriver is not executable: {smoke.WEBDRIVER}")
    smoke.assert_ports_available()

    client = smoke.Client(smoke.BASE_URL)
    driver: subprocess.Popen[bytes] | None = None
    driver_log = None
    mcp: McpStdio | None = None
    with tempfile.TemporaryDirectory(prefix="notation-tooling-smoke-") as temporary:
        root = Path(temporary)
        data, config, repo = root / "data", root / "config", root / "workspace"
        data.mkdir(); config.mkdir(); repo.mkdir()
        (repo / "nested").mkdir()
        (repo / "target").mkdir()
        (repo / ".hidden.md").write_text("hidden\n", encoding="utf-8")
        (repo / "target" / "ignored.md").write_text("build output\n", encoding="utf-8")
        (repo / ".gitignore").write_text(".hidden.md\ntarget/\n", encoding="utf-8")
        note = repo / "README.md"
        baseline = "# MCP baseline\n\nCommitted version.\n"
        note.write_text(baseline, encoding="utf-8")
        (repo / "nested" / "child.md").write_text("# Nested file\n", encoding="utf-8")

        def git(*args: str) -> str:
            return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()

        git("init", "--quiet", "--initial-branch=main")
        git("config", "user.name", "Notation Test")
        git("config", "user.email", "notation-test@example.invalid")
        git("add", ".gitignore", "README.md", "nested/child.md")
        git("commit", "--quiet", "-m", "Initial notes")
        (repo / "nested" / "child.md").write_text("# Nested file\n\nSecond commit update.\n", encoding="utf-8")
        git("add", "nested/child.md")
        git("commit", "--quiet", "-m", "Update nested note")
        working = baseline + "Working tree edit.\n"
        note.write_text(working, encoding="utf-8")
        (repo / "untracked.md").write_text("# Untracked note\n", encoding="utf-8")

        env = os.environ.copy()
        env["XDG_DATA_HOME"], env["XDG_CONFIG_HOME"] = str(data), str(config)
        env["TAURI_WEBVIEW_AUTOMATION"] = "true"
        log_path = root / "tauri-driver.log"
        driver_log = log_path.open("wb")
        try:
            driver = subprocess.Popen(
                [str(smoke.DRIVER), "--port", str(smoke.DRIVER_PORT), "--native-port", str(smoke.NATIVE_PORT),
                 "--native-driver", str(smoke.WEBDRIVER)],
                stdin=subprocess.DEVNULL, stdout=driver_log, stderr=subprocess.STDOUT,
                env=env, start_new_session=True,
            )
            smoke.wait_for_driver(driver, log_path)
            client.create_session(app)
            smoke.wait_for(client, "document.querySelector('main.app')", "native app UI")

            print("Opening temporary workspace", flush=True)
            client.element_command(smoke.button(client, "Workspace"), "/click")
            folder = client.find("[aria-label='Workspace folder']")
            client.element_command(folder, "/clear")
            client.send_keys(folder, str(repo))
            client.element_command(smoke.button(client, "Open workspace"), "/click")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] .panel-status')?.innerText.includes('indexed')",
                           "workspace index")

            print("Checking Explorer navigation and path deduplication", flush=True)
            client.element_command(smoke.button(client, "Explorer"), "/click")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Explorer\\\"] [aria-label=\\\"Folder: nested\\\"]')",
                           "nested Explorer folder")
            visible_entries = client.execute("return Array.from(document.querySelectorAll('[aria-label=\\\"Explorer\\\"] [role=\\\"treeitem\\\"]')).map(e => e.getAttribute('aria-label'))")
            smoke.require(not any(".hidden" in item or "target" in item for item in visible_entries),
                          f"Explorer exposed a hidden/build entry: {visible_entries!r}")
            client.element_command(client.find("[aria-label='Explorer'] [aria-label='Folder: nested']"), "/click")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Explorer\\\"] [aria-label=\\\"Open file: child.md\\\"]')",
                           "nested file")
            client.element_command(client.find("[aria-label='Explorer'] [aria-label='Open file: README.md']"), "/click")
            smoke.wait_for_active_tab(client, "README.md")
            tabs_before = client.execute("return document.querySelectorAll('[role=\\\"tablist\\\"][aria-label=\\\"Documents\\\"] [role=\\\"tab\\\"]').length")
            client.element_command(client.find("[aria-label='Explorer'] [aria-label='Open file: README.md']"), "/click")
            smoke.require(client.execute("return document.querySelectorAll('[role=\\\"tablist\\\"][aria-label=\\\"Documents\\\"] [role=\\\"tab\\\"]').length") == tabs_before,
                          "Explorer opened a duplicate tab for the same file")
            client.element_command(client.find("[aria-label='Explorer'] [aria-label='Open file: child.md']"), "/click")
            smoke.wait_for_active_tab(client, "child.md")
            smoke.require(smoke.editor_text(client) == "# Nested file\n\nSecond commit update.\n",
                          f"Explorer opened unexpected child contents: {smoke.editor_text(client)!r}")

            print("Checking Git status/history/diff without repository mutation", flush=True)
            status_before = git("status", "--porcelain=v1")
            head_before = git("rev-parse", "HEAD")
            index_before = hashlib.sha256((repo / ".git" / "index").read_bytes()).hexdigest()
            client.element_command(smoke.button(client, "Git"), "/click")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Git\\\"] .git-current-branch')?.innerText.includes('main')",
                           "current Git branch")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Git\\\"] .git-history button')",
                           "Git history")
            git_text = client.execute("return document.querySelector('[aria-label=\\\"Git\\\"]').innerText")
            smoke.require("Changes (2)" in git_text and "Initial notes" in git_text,
                          f"Git panel missed expected status/history: {git_text!r}")
            graph_state = client.execute(
                "return {commits: document.querySelectorAll('[aria-label=\\\"Git\\\"] .git-history button').length, "
                "edges: document.querySelectorAll('[aria-label=\\\"Git\\\"] .git-history svg path').length}"
            )
            smoke.require(graph_state.get("commits", 0) >= 2 and graph_state.get("edges", 0) >= 1,
                          f"Git view did not draw a parent edge for multiple commits: {graph_state!r}")
            diff_button = client.find("//section[@aria-label='Git']//button[contains(@aria-label,'View diff:') and contains(@aria-label,'README.md')]", using="xpath")
            client.element_command(diff_button, "/click")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Git diff\\\"]').innerText.includes('+Working tree edit.')",
                           "Git diff")
            client.execute_async("const done = arguments[arguments.length - 1]; requestAnimationFrame(() => requestAnimationFrame(done));")
            staged_label = client.execute(
                "const input = document.querySelector('[aria-label=\\\"Git\\\"] .git-staged input'); "
                "const label = input?.closest('label'); const inputRect = input?.getBoundingClientRect(); "
                "const labelRect = label?.getBoundingClientRect(); "
                "return {inputWidth: inputRect?.width, inputHeight: inputRect?.height, labelHeight: labelRect?.height, text: label?.innerText};"
            )
            smoke.require(staged_label.get("inputWidth", 999) <= 20 and staged_label.get("inputHeight", 999) <= 20
                          and staged_label.get("labelHeight", 999) <= 20 and staged_label.get("text") == "Staged diff",
                          f"Git staged-diff checkbox or label is not compact and single-line: {staged_label!r}")
            diff = client.execute("return document.querySelector('[aria-label=\\\"Git diff\\\"]').innerText")
            smoke.require(" Committed version." in diff and "+Working tree edit." in diff,
                          f"Git diff did not show expected patch: {diff!r}")
            smoke.require(git("status", "--porcelain=v1") == status_before and git("rev-parse", "HEAD") == head_before,
                          "Reading Git status/history/diff mutated repository state")
            smoke.require(hashlib.sha256((repo / ".git" / "index").read_bytes()).hexdigest() == index_before,
                          "Reading Git status/history/diff changed the index")
            smoke.require(note.read_text(encoding="utf-8") == working,
                          "Reading Git views modified the workspace file")
            git_screenshot = Path(__file__).resolve().parents[2] / "test-results" / "notation-git-native.png"
            git_screenshot.parent.mkdir(parents=True, exist_ok=True)
            client.execute_async("const done = arguments[arguments.length - 1]; requestAnimationFrame(() => requestAnimationFrame(done));")
            client.screenshot(git_screenshot)
            print(f"Native Git screenshot saved to {git_screenshot}", flush=True)

            print("Starting MCP over actual stdio JSON-RPC", flush=True)
            client.element_command(smoke.button(client, "Settings"), "/click")
            agents = client.find("//dialog[@aria-label='Settings']//button[@role='tab' and normalize-space(.)='Agents']", using="xpath")
            client.element_command(agents, "/click")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Settings\\\"] .panel-status')?.innerText.includes('MCP ready')",
                           "MCP bridge ready")
            status = invoke(client, "agent_status", {})
            smoke.require(isinstance(status, dict) and status.get("ready"), f"MCP agent bridge is not ready: {status!r}")
            socket_path = Path(status["socketPath"])
            smoke.require(socket_path.is_socket(), f"MCP socket is missing: {socket_path}")
            status_args = [str(part) for part in status["args"]]
            smoke.require(status.get("command") and "--mcp" in status_args and "--socket" in status_args and str(socket_path) in status_args,
                          f"Settings exposed an incomplete MCP command: {status!r}")
            reported_launcher = Path(str(status["command"]))
            smoke.require(reported_launcher.is_file() and os.access(reported_launcher, os.X_OK),
                          f"Settings MCP command is not an executable launcher: {reported_launcher}")
            command = [str(reported_launcher), *status_args]

            appearance = client.find("//dialog[@aria-label='Settings']//button[@role='tab' and normalize-space(.)='Appearance']", using="xpath")
            client.element_command(appearance, "/click")
            preset = client.find("dialog[aria-label='Settings'] [aria-label='Dark preset']")
            client.element_command(preset, "/click")
            client.execute("arguments[0].value = 'charcoal'; arguments[0].dispatchEvent(new Event('input', {bubbles:true})); arguments[0].dispatchEvent(new Event('change', {bubbles:true}));", [{smoke.ELEMENT_KEY: preset}])
            accent = smoke.fill_control(client, "dialog[aria-label='Settings'] input[aria-label='Accent color']", "#447799")
            client.send_keys(accent, "\ue007")
            density = client.find("dialog[aria-label='Settings'] [aria-label='Density']")
            client.execute("arguments[0].value = 'comfortable'; arguments[0].dispatchEvent(new Event('input', {bubbles:true})); arguments[0].dispatchEvent(new Event('change', {bubbles:true}));", [{smoke.ELEMENT_KEY: density}])
            shortcuts_tab = client.find("//dialog[@aria-label='Settings']//button[@role='tab' and normalize-space(.)='Shortcuts']", using="xpath")
            client.element_command(shortcuts_tab, "/click")
            new_binding = smoke.fill_control(client, "dialog[aria-label='Settings'] [aria-label='Shortcut for New']", "Ctrl+Shift+J")
            client.send_keys(new_binding, "\ue007")
            smoke.require(client.execute("return arguments[0].value", [{smoke.ELEMENT_KEY: new_binding}]) == "Mod+Shift+J",
                          "Native shortcut remap did not normalize to Mod+Shift+J")
            client.element_command(agents, "/click")
            mcp = McpStdio(command, env)
            initialized = mcp.request("initialize", {
                "protocolVersion": "2025-11-25", "capabilities": {},
                "clientInfo": {"name": "Notation native smoke", "version": "1"},
            })
            smoke.require(initialized.get("result", {}).get("protocolVersion") == "2025-11-25",
                          f"MCP initialize negotiated an unexpected protocol: {initialized!r}")
            mcp.notify("notifications/initialized")
            tools = mcp.request("tools/list", {}).get("result", {}).get("tools", [])
            tool_names = {tool.get("name") for tool in tools if isinstance(tool, dict)}
            expected = {"workspace_info", "list_directory", "search_documents", "read_file", "list_tabs",
                        "read_tab", "open_document", "edit_document", "git_status", "git_history", "git_diff"}
            smoke.require(expected <= tool_names, f"MCP tool list is incomplete: {expected - tool_names}")

            info = mcp.call("workspace_info", {})
            smoke.require(info.get("workspace") == str(repo), f"Unexpected MCP workspace: {info!r}")
            entries = mcp.call("list_directory", {"path": str(repo)})["entries"]
            names = {entry["name"] for entry in entries}
            smoke.require({"README.md", "nested", "untracked.md"} <= names and ".hidden.md" not in names and "target" not in names,
                          f"MCP directory results are incomplete or expose skipped paths: {names!r}")
            results = mcp.call("search_documents", {"query": "MCP baseline", "limit": 10})
            smoke.require(any(item["path"] == str(note) for item in results), f"MCP search missed README: {results!r}")
            history = mcp.call("git_history", {"limit": 10})
            smoke.require(len(history) >= 2 and len(history[0]["parents"]) == 1,
                          f"MCP git_history did not return a parent edge: {history!r}")
            disk = mcp.call("read_file", {"path": str(note)})
            smoke.require(disk["content"] == working, "MCP read_file returned the wrong disk text")
            all_tabs = mcp.call("list_tabs", {})
            readme_tabs = [item for item in all_tabs["tabs"] if item.get("path") == str(note)]
            smoke.require(len(readme_tabs) == 1, f"MCP tab list has no unique README tab: {readme_tabs!r}")
            tab_id = readme_tabs[0]["id"]
            active_tab_data = mcp.call("read_tab", {"tabId": tab_id})
            smoke.require(active_tab_data.get("content") == working, "MCP read_tab failed to read the open buffer")
            opened = mcp.call("open_document", {"path": str(note)})
            smoke.require(opened.get("path") == str(note), f"MCP open_document failed: {opened!r}")
            readme_tabs = [item for item in mcp.call("list_tabs", {})["tabs"] if item.get("path") == str(note)]
            smoke.require(len(readme_tabs) == 1, "MCP open_document duplicated an already-open document")

            client.element_command(smoke.button(client, "Close settings"), "/click")
            client.element_command(smoke.button(client, "New"), "/click")
            smoke.rename_document(client, "active.md")
            smoke.replace_editor_text(client, smoke.active_editor(client), "# Scratch stays active")
            active_id = client.execute("return document.querySelector('[role=\\\"tablist\\\"][aria-label=\\\"Documents\\\"] [role=\\\"tab\\\"][aria-selected=\\\"true\\\"]')?.dataset.tabId")
            smoke.require(active_id != readme_tabs[0]["id"], "Could not create a separate active tab")

            client.element_command(smoke.button(client, "Settings"), "/click")
            agents = client.find("//dialog[@aria-label='Settings']//button[@role='tab' and normalize-space(.)='Agents']", using="xpath")
            client.element_command(agents, "/click")
            edit_toggle = client.find("//dialog[@aria-label='Settings']//label[contains(.,'Agent edits enabled')]/input", using="xpath")
            enabled = client.execute("return arguments[0].checked", [{smoke.ELEMENT_KEY: edit_toggle}])
            if enabled:
                client.element_command(edit_toggle, "/click")
            smoke.wait_for(client, "document.querySelector('.database-state')?.dataset.state === 'saved'",
                           "agent edits disabled in persisted Settings")
            failure = mcp.call("edit_document", {"tabId": tab_id, "expectedContent": working,
                                                 "content": "# Must remain disabled\n"}, expect_error=True)
            smoke.require("disabled" in failure.lower(), f"Agent edit disable gate returned an unexpected error: {failure!r}")
            smoke.require(mcp.call("read_tab", {"tabId": tab_id})["content"] == working,
                          "A disabled MCP edit changed the buffer")
            client.element_command(edit_toggle, "/click")
            smoke.wait_for(client, "document.querySelector('.database-state')?.dataset.state === 'saved'",
                           "agent edits enabled in persisted Settings")
            client.element_command(smoke.button(client, "Close settings"), "/click")
            stale = mcp.call("edit_document", {"tabId": tab_id, "expectedContent": "stale text",
                                               "content": "# Must reject stale text\n"}, expect_error=True)
            smoke.require("expected" in stale.lower() or "changed" in stale.lower(),
                          f"Stale edit guard returned an unexpected error: {stale!r}")
            smoke.require(mcp.call("read_tab", {"tabId": tab_id})["content"] == working,
                          "Stale MCP edit changed the buffer")

            edited = working + "\nAgent edit, still unsaved.\n"
            reply = mcp.call("edit_document", {"tabId": tab_id, "expectedContent": working, "content": edited})
            smoke.require(reply.get("content") == edited, f"MCP edit failed to return exact updated text: {reply!r}")
            selected = client.execute("return document.querySelector('[role=\\\"tablist\\\"][aria-label=\\\"Documents\\\"] [role=\\\"tab\\\"][aria-selected=\\\"true\\\"]')?.getAttribute('aria-label')")
            smoke.require(selected == "active.md", f"Editing an inactive tab stole focus: {selected!r}")
            visible = client.execute("return Array.from(document.querySelectorAll('.cm-content')).find(e => e.getClientRects().length)?.innerText")
            smoke.require(visible == "# Scratch stays active", f"Inactive edit changed visible text: {visible!r}")
            smoke.require(note.read_text(encoding="utf-8") == working,
                          "MCP edit saved to disk before an explicit Save")
            readback = mcp.call("read_tab", {"tabId": tab_id})
            smoke.require(readback.get("content") == edited and readback.get("dirty") is True,
                          f"MCP read_tab did not return the unsaved edit: {readback!r}")

            client.element_command(client.find("[role='tablist'][aria-label='Documents'] [role='tab'][aria-label='README.md']"), "/click")
            smoke.wait_for(client, "Array.from(document.querySelectorAll('.cm-content')).some(e => e.getClientRects().length && e.innerText.includes('Agent edit, still unsaved.'))",
                           "README buffer selected")
            source = smoke.active_editor(client)
            client.element_command(source, "/click")
            client.send_keys(source, "\ue009z\ue000")
            smoke.require(smoke.editor_text(client) == working, "One-step Undo did not revert the guarded MCP edit")
            smoke.require(note.read_text(encoding="utf-8") == working,
                          "Undo changed the file on disk")

            edited_again = working + "Agent edit saved explicitly.\n"
            mcp.call("edit_document", {"tabId": tab_id, "expectedContent": working, "content": edited_again})
            smoke.require(note.read_text(encoding="utf-8") == working,
                          "MCP edit wrote the document before Save")
            client.element_command(smoke.button(client, "Save"), "/click")
            smoke.wait_for(client, "document.querySelector('.status-message')?.innerText.includes('Saved README.md')",
                           "normal Save of an MCP-edited document")
            smoke.require(note.read_text(encoding="utf-8") == edited_again,
                          "The explicit Save action failed to write the MCP buffer")
            smoke.wait_for(client, "document.querySelector('.database-state')?.dataset.state === 'saved'",
                           "all document tabs persisted before restart")

            print("Checking close recovery with both SQLite and local recovery cache unavailable", flush=True)
            database = data / "local.notation.app" / "state.sqlite3"
            lock = sqlite3.connect(database, timeout=0, isolation_level=None)
            lock.execute("BEGIN IMMEDIATE")
            client.execute("window.__notationOriginalSetItem = Storage.prototype.setItem; "
                           "Storage.prototype.setItem = function(){ throw new DOMException('Storage full', 'QuotaExceededError'); }")
            close_text = edited_again + "Close guard keeps this draft.\n"
            smoke.replace_editor_text(client, smoke.active_editor(client), close_text)
            smoke.wait_for(client, "document.querySelector('[role=\\\"alert\\\"]')?.innerText.toLowerCase().includes('recovery')",
                           "visible recovery-cache write failure")

            def emit_close_request() -> object:
                return invoke(client, "plugin:event|emit_to", {
                    "target": {"kind": "Window", "label": "main"},
                    "event": "tauri://close-requested",
                    "payload": None,
                })

            emit_close_request()
            smoke.wait_for(client, "document.querySelector('dialog[aria-label=\\\"Unsaved recovery\\\"]')?.open === true",
                           "close recovery decision dialog", timeout=20)
            # A second native close request while the first decision is pending
            # must remain prevented instead of tearing the editor down.
            emit_close_request()
            smoke.wait_for(client, "document.querySelector('dialog[aria-label=\\\"Unsaved recovery\\\"]')?.open === true",
                           "recovery dialog survives repeated close")
            close_error = mcp.call("edit_document", {"tabId": tab_id, "expectedContent": edited_again,
                                                      "content": "# MCP must wait until recovery is resolved\n"}, expect_error=True)
            smoke.require("pending" in close_error.lower() or "decision" in close_error.lower(),
                          f"MCP edit was not blocked during the close decision: {close_error!r}")
            smoke.require(smoke.editor_text(client) == close_text,
                          "Repeated close or pending MCP edit changed the unsaved document")
            client.element_command(smoke.button(client, "Keep open"), "/click")
            smoke.wait_for(client, "!document.querySelector('dialog[aria-label=\\\"Unsaved recovery\\\"]')",
                           "keep-open decision")
            smoke.require(smoke.editor_text(client) == close_text,
                          "Keep open discarded the in-memory document")
            client.execute("Storage.prototype.setItem = window.__notationOriginalSetItem; "
                           "delete window.__notationOriginalSetItem")
            lock.rollback()
            lock.close()
            client.element_command(smoke.button(client, "Retry saving app state"), "/click")
            smoke.wait_for(client, "document.querySelector('.database-state')?.dataset.state === 'saved'",
                           "recovery retry after restoring both stores", timeout=20)
            smoke.require(smoke.editor_text(client) == close_text,
                          "Retrying persistence changed the retained draft")

            mcp.close()
            mcp = None
            client.quit()
            print("Restarting the native app to verify active and inactive tab persistence", flush=True)
            session = client.create_session(app)
            print(f"Tooling restart session started: {session}", flush=True)
            smoke.wait_for(client, "document.querySelector('main.app')", "native app after restart")
            wait_for_tabs(client, 4)
            smoke.wait_for(client, "document.querySelector('[role=\\\"tablist\\\"][aria-label=\\\"Documents\\\"] [role=\\\"tab\\\"][aria-label=\\\"README.md\\\"][aria-selected=\\\"true\\\"]')",
                           "active README tab restored")
            client.element_command(smoke.button(client, "Settings"), "/click")
            appearance = client.find("//dialog[@aria-label='Settings']//button[@role='tab' and normalize-space(.)='Appearance']", using="xpath")
            client.element_command(appearance, "/click")
            smoke.require(client.execute("return document.querySelector('[aria-label=\\\"Dark preset\\\"]')?.value") == "charcoal",
                          "Native appearance preset did not survive app restart")
            smoke.require(client.execute("return document.querySelector('[aria-label=\\\"Accent color\\\"]')?.value") == "#447799",
                          "Native accent color did not survive app restart")
            smoke.require(client.execute("return document.querySelector('[aria-label=\\\"Density\\\"]')?.value") == "comfortable",
                          "Native density setting did not survive app restart")
            shortcuts_tab = client.find("//dialog[@aria-label='Settings']//button[@role='tab' and normalize-space(.)='Shortcuts']", using="xpath")
            client.element_command(shortcuts_tab, "/click")
            smoke.require(client.execute("return document.querySelector('[aria-label=\\\"Shortcut for New\\\"]')?.value") == "Mod+Shift+J",
                          "Native shortcut remap did not survive app restart")
            client.element_command(smoke.button(client, "Close settings"), "/click")
            smoke.require(smoke.editor_text(client) == close_text,
                          "Saved active README content did not survive native app restart")
            client.element_command(client.find("[role='tablist'][aria-label='Documents'] [role='tab'][aria-label='active.md']"), "/click")
            smoke.require(smoke.editor_text(client) == "# Scratch stays active",
                          "Inactive active.md tab content did not survive native app restart")
            print("Explorer navigation/deduplication, read-only Git, MCP initialize/list/call, guarded edit, Undo, Save, and native tab restart persistence passed", flush=True)
        finally:
            if mcp:
                mcp.close()
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
            if driver_log:
                driver_log.close()
            if log_path.exists():
                detail = log_path.read_text(errors="replace").strip()
                if detail:
                    print("tauri-driver log:", file=sys.stderr)
                    print(detail, file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path,
                        default=Path(os.environ.get("NOTATION_APP", str(Path.home() / ".local/bin/notation"))),
                        help="absolute staged launcher or AppImage path")
    args = parser.parse_args()
    try:
        run(args.app.expanduser().resolve())
    except Exception as error:
        print(f"NATIVE TOOLING SMOKE FAILED: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
