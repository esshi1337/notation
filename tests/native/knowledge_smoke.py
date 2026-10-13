#!/usr/bin/env python3
"""Native integration smoke for wiki links, properties, backlinks, and revision diffs."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import signal
import subprocess
import tempfile

import smoke


def wait_active(client: smoke.Client, name: str) -> None:
    expression = "document.querySelector('[role=tablist][aria-label=Documents] [role=tab][aria-selected=true]')?.getAttribute('aria-label') === " + smoke.json.dumps(name)
    smoke.wait_for(client, expression, f"active tab {name}")


def ensure_workspace_panel(client: smoke.Client) -> None:
    if not client.execute("return Boolean(document.querySelector('[aria-label=\\\"Workspace\\\"]'))"):
        client.element_command(smoke.button(client, "Workspace"), "/click")


def click_preview_link(client: smoke.Client, index: int, label: str) -> None:
    smoke.wait_for(client, "document.querySelector('.preview-pane [aria-label=\\\"Document preview\\\"]')?.getAttribute('aria-busy') === 'false'",
                   "Preview render completed before wiki navigation")
    expression = (
        "Array.from(document.querySelectorAll('.preview-pane .wiki-link')).some((link, i) => "
        f"i === {index} && link.innerText === {smoke.json.dumps(label)} && link.getClientRects().length > 0 && link.getBoundingClientRect().width > 0)"
    )
    smoke.wait_for(client, expression, f"visible Preview link {label}")
    selector = f".preview-pane .wiki-link[data-wiki-index='{index}']"
    element = client.find(selector)
    client.element_command(element, "/click")


def run(app: Path) -> None:
    if not app.is_file() or not os.access(app, os.X_OK):
        raise FileNotFoundError(f"App launcher is missing or not executable: {app}")
    smoke.assert_ports_available()
    client = smoke.Client(smoke.BASE_URL)
    driver = None
    driver_log = None
    with tempfile.TemporaryDirectory(prefix="notation-knowledge-smoke-") as temp:
        root = Path(temp)
        data, config, workspace = root / "data", root / "config", root / "workspace"
        for path in (data, config, workspace, workspace / "a", workspace / "b"):
            path.mkdir(parents=True, exist_ok=True)

        home_text = (
            "---\r\ntitle: Home # preserve comment\r\nunknown: keep me\r\n---\r\n"
            "# Home\r\n\r\n"
            "[[Target|Target link]]\r\n"
            "[[AliasName|Alias link]]\r\n"
            "[[Target#Deep heading|Heading link]]\r\n"
            "[[Shared]]\r\n"
            "[[New note]]\r\n"
            "[[Race]]\r\n"
        )
        (workspace / "home.md").write_bytes(home_text.encode())
        (workspace / "Target.md").write_text(
            "---\ntitle: Target\naliases: [AliasName]\n---\n# Target\n\n## Deep heading\n\nTarget body.\n",
            encoding="utf-8",
        )
        (workspace / "a" / "Shared.md").write_text("# Shared A\n", encoding="utf-8")
        (workspace / "b" / "Shared.md").write_text("# Shared B\n", encoding="utf-8")
        properties_text = (
            "---\r\ntitle: Original # preserve property comment\r\nflag: false\r\ntags:\r\n"
            "  - old\r\nunknown_field: keep this\r\n---\r\n# Property body\r\n\r\n"
            "- [ ] Property task\r\n\r\nBody tail.\r\n"
        )
        properties_file = workspace / "properties.md"
        properties_file.write_bytes(properties_text.encode())
        history_file = workspace / "history.md"
        history_file.write_text("# Base version\n\nbase line\n", encoding="utf-8")

        env = os.environ.copy()
        env["XDG_DATA_HOME"] = str(data)
        env["XDG_CONFIG_HOME"] = str(config)
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
            session = client.create_session(app)
            print(f"Knowledge smoke WebDriver session started: {session}", flush=True)
            smoke.wait_for(client, "document.querySelector('main.app')", "native app UI")

            print("Indexing isolated wiki workspace", flush=True)
            ensure_workspace_panel(client)
            folder = client.find("[aria-label='Workspace folder']")
            client.element_command(folder, "/clear")
            client.send_keys(folder, str(workspace))
            client.element_command(smoke.button(client, "Open workspace"), "/click")
            smoke.wait_for(client, "document.querySelector('[aria-label=\"Workspace\"] .panel-status')?.innerText.includes('indexed')",
                           "workspace index")
            search = client.find("[aria-label='Search notes']")
            client.element_command(search, "/clear")
            client.send_keys(search, "Home")
            smoke.wait_for(client, "document.querySelector('[aria-label=\"Workspace\"] [aria-label=\"Open note: home.md\"]')",
                           "Home result")
            client.element_command(client.find("[aria-label='Workspace'] [aria-label='Open note: home.md']"), "/click")
            wait_active(client, "home.md")

            print("Resolving same-folder, alias, heading, ambiguous, and missing wiki targets", flush=True)
            initial_tabs = client.execute("return document.querySelectorAll('[role=\"tablist\"][aria-label=\"Documents\"] [role=\"tab\"]').length")
            smoke.wait_for(client, "Array.from(document.querySelectorAll('.preview-pane .wiki-link')).some(link => link.title === 'Target|Target link' && link.getClientRects().length > 0)",
                           "Preview refreshed for Home tab")
            click_preview_link(client, 0, "Target link")
            wait_active(client, "Target.md")
            smoke.require(smoke.editor_text(client).endswith("## Deep heading\n\nTarget body.\n"),
                          "Same-folder wiki resolution opened the wrong target")
            target_tabs = client.execute("return document.querySelectorAll('[role=\"tablist\"][aria-label=\"Documents\"] [role=\"tab\"]').length")
            smoke.require(target_tabs == initial_tabs + 1, "Opening a wiki link did not add exactly one tab")
            client.element_command(client.find("[role='tablist'][aria-label='Documents'] [role='tab'][aria-label='home.md']"), "/click")
            click_preview_link(client, 0, "Target link")
            wait_active(client, "Target.md")
            smoke.require(client.execute("return document.querySelectorAll('[role=\"tablist\"][aria-label=\"Documents\"] [role=\"tab\"]').length") == target_tabs,
                          "Following an already-open wiki link duplicated its tab")

            client.element_command(client.find("[role='tablist'][aria-label='Documents'] [role='tab'][aria-label='home.md']"), "/click")
            click_preview_link(client, 1, "Alias link")
            wait_active(client, "Target.md")
            client.element_command(client.find("[role='tablist'][aria-label='Documents'] [role='tab'][aria-label='home.md']"), "/click")
            click_preview_link(client, 2, "Heading link")
            wait_active(client, "Target.md")
            smoke.wait_for(client, "Array.from(document.querySelectorAll('.cm-activeLine')).some(e => e.innerText.includes('Deep heading'))",
                           "wiki heading navigation")

            client.element_command(client.find("[role='tablist'][aria-label='Documents'] [role='tab'][aria-label='home.md']"), "/click")
            click_preview_link(client, 3, "Shared")
            smoke.wait_for(client, "document.querySelector('dialog[aria-label=\"Choose note\"]')?.open === true",
                           "ambiguous wiki chooser")
            smoke.require(client.execute("return document.querySelectorAll('dialog[aria-label=\"Choose note\"] [aria-label^=\"Open \"]').length") == 2,
                          "Ambiguous wiki chooser did not list both candidates")
            client.element_command(client.find("dialog[aria-label='Choose note'] [aria-label='Open b/Shared.md']"), "/click")
            wait_active(client, "Shared.md")
            smoke.require(client.execute("return document.querySelector('[role=\"tablist\"] [role=\"tab\"][aria-selected=\"true\"]')?.title.endsWith('b/Shared.md')") is True,
                          "Ambiguous wiki chooser opened the wrong Shared.md")

            client.element_command(client.find("[role='tablist'][aria-label='Documents'] [role='tab'][aria-label='home.md']"), "/click")
            click_preview_link(client, 4, "New note")
            smoke.wait_for(client, "document.querySelector('dialog[aria-label=\"Create note\"]')?.open === true",
                           "explicit Create note confirmation")
            smoke.require(not (workspace / "New note.md").exists(), "Missing note was created without confirmation")
            client.element_command(client.find("dialog[aria-label='Create note'] [aria-label='Close note navigation']"), "/click")
            smoke.require(not (workspace / "New note.md").exists(), "Canceling Create note wrote a file")
            click_preview_link(client, 4, "New note")
            smoke.wait_for(client, "document.querySelector('dialog[aria-label=\"Create note\"]')?.open === true",
                           "Create note reopened")
            client.element_command(client.find("dialog[aria-label='Create note'] button:not([aria-label='Close note navigation'])"), "/click")
            smoke.wait_for(client, "Array.from(document.querySelectorAll('[role=\"tab\"][aria-selected=\"true\"]')).some(e => e.getAttribute('aria-label') === 'New note.md')",
                           "created missing note tab")
            smoke.require((workspace / "New note.md").read_text(encoding="utf-8") == "",
                          "Explicit Create note did not create an empty note")

            client.element_command(client.find("[role='tablist'][aria-label='Documents'] [role='tab'][aria-label='home.md']"), "/click")
            click_preview_link(client, 5, "Race")
            smoke.wait_for(client, "document.querySelector('dialog[aria-label=\"Create note\"]')?.open === true",
                           "race Create note prompt")
            race_file = workspace / "Race.md"
            race_file.write_text("sentinel must survive\n", encoding="utf-8")
            client.element_command(client.find("dialog[aria-label='Create note'] button:not([aria-label='Close note navigation'])"), "/click")
            smoke.wait_for(client, "document.querySelector('[role=alert]')?.innerText.includes('Could not open or create note')",
                           "no-overwrite race reported")
            smoke.require(race_file.read_text(encoding="utf-8") == "sentinel must survive\n",
                          "Explicit wiki creation overwrote a file created after indexing")
            client.element_command(client.find("dialog[aria-label='Create note'] [aria-label='Close note navigation']"), "/click")

            print("Checking backlinks and CRLF property preservation", flush=True)
            ensure_workspace_panel(client)
            search = client.find("[aria-label='Search notes']")
            client.element_command(search, "/clear")
            client.send_keys(search, "Target")
            smoke.wait_for(client, "document.querySelector('[aria-label=\"Workspace\"] [aria-label=\"Open note: Target.md\"]')",
                           "Target search result for backlinks")
            client.element_command(client.find("[aria-label='Workspace'] [aria-label='Open note: Target.md']"), "/click")
            backlinks = client.find("//button[normalize-space(.)='Backlinks']", using="xpath")
            client.element_command(backlinks, "/click")
            smoke.wait_for(client, "Array.from(document.querySelectorAll('[aria-label=\\\"Workspace\\\"] [aria-label^=\\\"Open backlink: \\\"]')).some(e => e.getAttribute('aria-label').includes('home.md'))",
                           "wiki backlink to Home")
            notes_tab = client.find("//div[@aria-label='Workspace views']//button[normalize-space(.)='Notes']", using="xpath")
            client.element_command(notes_tab, "/click")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace views\\\"] button[aria-pressed=\\\"true\\\"]')?.innerText === 'Notes'",
                           "Notes workspace view selected")

            ensure_workspace_panel(client)
            search = client.find("[aria-label='Search notes']")
            client.element_command(search, "/clear")
            client.send_keys(search, "Property body")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] [aria-label=\\\"Open note: properties.md\\\"]')",
                           "properties file search result")
            client.element_command(client.find("[aria-label='Workspace'] [aria-label='Open note: properties.md']"), "/click")
            wait_active(client, "properties.md")
            client.element_command(smoke.button(client, "Properties"), "/click")
            client.execute_async("const done = arguments[arguments.length - 1]; requestAnimationFrame(() => requestAnimationFrame(done));")
            screenshot = Path(__file__).resolve().parents[2] / "test-results" / "notation-knowledge-properties.png"
            screenshot.parent.mkdir(parents=True, exist_ok=True)
            client.screenshot(screenshot)
            print(f"Native Properties screenshot saved to {screenshot}", flush=True)
            title = client.find("[aria-label='Property value: title']")
            client.element_command(title, "/clear")
            client.send_keys(title, "Native update")
            client.element_command(smoke.button(client, "Apply property: title"), "/click")
            smoke.require(properties_file.read_bytes() == properties_text.encode(),
                          "Properties wrote to disk before Save")
            client.element_command(smoke.button(client, "Save"), "/click")
            smoke.wait_for(client, "document.querySelector('.status-message')?.innerText.includes('Saved properties.md')",
                           "properties saved")
            changed = properties_file.read_bytes()
            smoke.require(b"title: Native update # preserve property comment\r\n" in changed,
                          "Property update lost the YAML comment or CRLF")
            smoke.require(b"unknown_field: keep this\r\n---\r\n# Property body\r\n\r\n- [ ] Property task\r\n\r\nBody tail.\r\n" in changed,
                          "Property edit changed unknown YAML fields or the CRLF body")

            print("Comparing revisions to current draft and another revision", flush=True)
            ensure_workspace_panel(client)
            search = client.find("[aria-label='Search notes']")
            client.element_command(search, "/clear")
            client.send_keys(search, "Base version")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] [aria-label=\\\"Open note: history.md\\\"]')",
                           "history file search result")
            client.element_command(client.find("[aria-label='Workspace'] [aria-label='Open note: history.md']"), "/click")
            wait_active(client, "history.md")
            client.element_command(smoke.button(client, "Source"), "/click")
            editor = smoke.active_editor(client)
            smoke.replace_editor_text(client, editor, "# Revision A\n\nalpha line\n")
            client.element_command(smoke.button(client, "Save"), "/click")
            smoke.wait_for(client, "document.querySelector('.status-message')?.innerText.includes('Saved history.md')", "Revision A saved")
            smoke.replace_editor_text(client, smoke.active_editor(client), "# Revision B\n\nchanged line\n")
            client.element_command(smoke.button(client, "Save"), "/click")
            deadline = smoke.time.monotonic() + 10
            while smoke.time.monotonic() < deadline and history_file.read_text(encoding="utf-8") != "# Revision B\n\nchanged line\n":
                smoke.time.sleep(0.1)
            smoke.require(history_file.read_text(encoding="utf-8") == "# Revision B\n\nchanged line\n", "Revision B did not reach disk")
            smoke.replace_editor_text(client, smoke.active_editor(client), "# Draft C\n\nunsaved line\n")
            client.element_command(smoke.button(client, "History"), "/click")
            smoke.wait_for(client, "document.querySelector('[aria-label=\"History\"] .revision-list button')",
                           "history revisions")
            revision_b = client.find("//section[@aria-label='History']//div[@class='revision-list']//button[contains(.,'Revision B')]", using="xpath")
            client.element_command(revision_b, "/click")
            smoke.wait_for(client, "document.querySelector('[aria-label=\"Unified diff\"]')?.innerText.includes('Draft C')",
                           "revision versus draft diff")
            draft_diff = client.execute("return document.querySelector('[aria-label=\"Unified diff\"]').innerText")
            smoke.require("Revision B" in draft_diff and "Draft C" in draft_diff,
                          f"Revision/current diff omitted edits: {draft_diff!r}")
            selected_compare = client.execute("const select = document.querySelector('[aria-label=\\\"Compare against\\\"]'); "
                           "const rows = Array.from(document.querySelectorAll('[aria-label=\\\"History\\\"] .revision-list button')); "
                           "const rowIndex = rows.findIndex(button => button.innerText.includes('Revision A')); "
                           "const option = select?.options[rowIndex + 1]; "
                           "if (option) { select.value = option.value; select.dispatchEvent(new Event('change', {bubbles:true})); } "
                           "return {rowIndex, optionText:option?.textContent, value:option?.value, selectedIndex:select?.selectedIndex}")
            print(f"Revision A compare selection: {selected_compare!r}", flush=True)
            smoke.require(isinstance(selected_compare, dict) and selected_compare.get("rowIndex", -1) >= 0,
                          "Could not map Revision A to its comparison option")
            smoke.wait_for(client, "document.querySelector('[aria-label=\"Unified diff\"]')?.innerText.includes('Revision A')",
                           "revision versus revision diff")
            revision_diff = client.execute("return document.querySelector('[aria-label=\"Unified diff\"]').innerText")
            smoke.require("Revision B" in revision_diff and "Revision A" in revision_diff and "Draft C" not in revision_diff,
                          f"Revision comparison did not use the other revision: {revision_diff!r}")
            client.element_command(smoke.button(client, "Restore revision"), "/click")
            smoke.require(smoke.editor_text(client) == "# Revision B\n\nchanged line\n",
                          "Restore revision did not update the editor")
            client.element_command(smoke.active_editor(client), "/click")
            client.send_keys(smoke.active_editor(client), "\ue009z\ue000")
            smoke.require(smoke.editor_text(client) == "# Draft C\n\nunsaved line\n",
                          "Undo did not revert restoration to the selected revision")
            smoke.require(history_file.read_text(encoding="utf-8") == "# Revision B\n\nchanged line\n",
                          "Revision restoration or Undo changed disk without Save")
            print("Native wiki resolution/create/backlinks, CRLF YAML properties, and revision diff/restore/Undo passed",
                  flush=True)
        finally:
            try:
                client.quit()
            except Exception as error:
                print(f"WebDriver cleanup: {error}", flush=True)
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
            if driver_log is not None:
                driver_log.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    run(parser.parse_args().app.resolve())


if __name__ == "__main__":
    main()
