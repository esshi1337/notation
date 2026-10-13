#!/usr/bin/env python3
"""Exercise workspace indexing and SQLite-backed app state in the native app.

The test uses an isolated XDG profile and temporary workspace. It imports the
standard-library WebDriver helpers from smoke.py.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time

import smoke


def click(client: smoke.Client, element: str) -> None:
    client.element_command(element, "/click")


def wait_for_text(client: smoke.Client, selector: str, text: str, description: str, timeout: float = 20) -> None:
    escaped = smoke.json.dumps(text)
    smoke.wait_for(
        client,
        f"Array.from(document.querySelectorAll({smoke.json.dumps(selector)})).some(e => e.innerText.includes({escaped}))",
        description,
        timeout,
    )


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


def run(app: Path) -> None:
    if not app.exists() or not os.access(app, os.X_OK):
        raise FileNotFoundError(f"App launcher does not exist or is not executable: {app}")
    if not smoke.DRIVER.is_file() or not os.access(smoke.DRIVER, os.X_OK):
        raise FileNotFoundError(f"tauri-driver is not executable: {smoke.DRIVER}")
    if not smoke.WEBDRIVER.is_file() or not os.access(smoke.WEBDRIVER, os.X_OK):
        raise FileNotFoundError(f"WebKitWebDriver is not executable: {smoke.WEBDRIVER}")

    smoke.assert_ports_available()
    client = smoke.Client(smoke.BASE_URL)
    driver = None
    driver_log = None

    with tempfile.TemporaryDirectory(prefix="notation-sqlite-smoke-") as temporary:
        root = Path(temporary)
        workspace = root / "workspace"
        data = root / "data"
        config = root / "config"
        workspace.mkdir()
        data.mkdir()
        config.mkdir()
        alpha = workspace / "alpha.md"
        beta = workspace / "beta.md"
        (workspace / "graph.mmd").write_text("flowchart LR\n  A[Alpha] --> B[Beta]\n", encoding="utf-8")
        alpha.write_text(
            "# Alpha\n\nAlpha links to [Beta](beta.md) and carries #alpha.\n\n"
            "- [ ] Review beta\n- [x] Finish alpha\n",
            encoding="utf-8",
        )
        beta.write_text("# Beta\n\nBeta has #beta.\n\n- [ ] Ship beta\n", encoding="utf-8")

        env = os.environ.copy()
        env["XDG_DATA_HOME"] = str(data)
        env["XDG_CONFIG_HOME"] = str(config)
        env["TAURI_WEBVIEW_AUTOMATION"] = "true"
        log_path = root / "tauri-driver.log"
        driver_log = log_path.open("wb")
        try:
            driver = smoke.subprocess.Popen(
                [str(smoke.DRIVER), "--port", str(smoke.DRIVER_PORT), "--native-port", str(smoke.NATIVE_PORT),
                 "--native-driver", str(smoke.WEBDRIVER)],
                stdin=smoke.subprocess.DEVNULL,
                stdout=driver_log,
                stderr=smoke.subprocess.STDOUT,
                env=env,
                start_new_session=True,
            )
            smoke.wait_for_driver(driver, log_path)
            session = client.create_session(app)
            print(f"SQLite smoke WebDriver session started: {session}", flush=True)
            smoke.wait_for(client, "document.querySelector('main.app')", "native app UI")
            initial_url = client.execute("return location.href")
            smoke.require("localhost:1420" not in initial_url, f"Native app loaded a development server: {initial_url}")

            print("Opening isolated workspace and indexing Markdown/Mermaid files", flush=True)
            click(client, smoke.button(client, "Workspace"))
            client.find("[aria-label='Workspace']")
            folder = client.find("[aria-label='Workspace folder']")
            client.element_command(folder, "/clear")
            client.send_keys(folder, str(workspace))
            click(client, smoke.button(client, "Open workspace"))
            smoke.wait_for(client, "document.querySelector('[aria-label=\"Workspace\"] .panel-status')?.innerText.includes('indexed')", "workspace indexing report")
            status = client.execute("return document.querySelector('[aria-label=\"Workspace\"] .panel-status').innerText")
            smoke.require("3 files" in status and "3 indexed" in status, f"Unexpected workspace index report: {status!r}")

            search = client.find("[aria-label='Search notes']")
            client.element_command(search, "/clear")
            client.send_keys(search, "Alpha")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] [aria-label=\\\"Open note: alpha.md\\\"]')", "Alpha search result")
            alpha_result = client.find("//button[@aria-label='Open note: alpha.md']", using="xpath")
            click(client, alpha_result)
            smoke.wait_for_active_tab(client, "alpha.md")
            smoke.require(smoke.editor_text(client).startswith("# Alpha"), "Workspace result did not open alpha.md")

            print("Checking task, tag, and backlink navigation", flush=True)
            click(client, client.find("//button[normalize-space(.)='Tasks']", using="xpath"))
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] [aria-label=\\\"Task: Review beta\\\"]')", "indexed task result")
            task_result = client.find("//button[@aria-label='Task: Review beta']", using="xpath")
            smoke.require(bool(task_result), "Indexed task was not available")
            click(client, client.find("//button[normalize-space(.)='Tags']", using="xpath"))
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] [aria-label=\\\"Tag: #beta\\\"]')", "indexed tag result")
            click(client, client.find("//button[@aria-label='Tag: #beta']", using="xpath"))
            smoke.wait_for(client, "document.querySelector('[aria-label=\"Search notes\"]').value === '#beta'", "tag filtering")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] [aria-label=\\\"Open note: beta.md\\\"]')", "Beta search result")
            click(client, client.find("//button[@aria-label='Open note: beta.md']", using="xpath"))
            smoke.wait_for_active_tab(client, "beta.md")
            click(client, client.find("//button[normalize-space(.)='Backlinks']", using="xpath"))
            smoke.wait_for(client, "Array.from(document.querySelectorAll('[aria-label=\\\"Workspace\\\"] [aria-label^=\\\"Open backlink: \\\"]')).some(e => e.getAttribute('aria-label').includes('alpha.md'))", "indexed backlink result")
            client.find("//button[contains(@aria-label,'Open backlink:') and contains(@aria-label,'alpha.md')]", using="xpath")
            print("Tasks, tags, and backlink results resolve to isolated workspace files", flush=True)

            print("Checking external edits and refresh", flush=True)
            alpha.write_text(alpha.read_text(encoding="utf-8") + "\nExternal refresh marker.\n", encoding="utf-8")
            click(client, client.find("//button[normalize-space(.)='Notes']", using="xpath"))
            smoke.wait_for(client, "document.querySelector('[aria-label=\"Workspace\"] .panel-status')?.innerText.includes('3 indexed')", "refreshed workspace index")
            search = client.find("[aria-label='Search notes']")
            client.element_command(search, "/clear")
            client.send_keys(search, "External refresh marker")
            click(client, smoke.button(client, "Refresh index"))
            try:
                smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] [aria-label=\\\"Open note: alpha.md\\\"]')", "externally refreshed search result")
            except AssertionError as error:
                diagnostics = client.execute(
                    "return {query: document.querySelector('[aria-label=\\\"Search notes\\\"]')?.value, "
                    "status: document.querySelector('[aria-label=\\\"Workspace\\\"] .panel-status')?.innerText, "
                    "errors: Array.from(document.querySelectorAll('[aria-label=\\\"Workspace\\\"] [role=\\\"alert\\\"]')).map(e => e.innerText), "
                    "results: document.querySelector('[aria-label=\\\"Workspace\\\"] .workspace-results')?.innerText}"
                )
                direct = invoke(client, "search_workspace", {"query": "External refresh marker", "limit": 50})
                screenshot = Path(__file__).resolve().parents[2] / "test-results" / "notation-sqlite-refresh-failure.png"
                screenshot.parent.mkdir(parents=True, exist_ok=True)
                client.screenshot(screenshot)
                raise AssertionError(f"{error}; UI={diagnostics!r}; direct search_workspace={direct!r}; screenshot={screenshot}") from error

            print("Saving/running a native script and applying its output", flush=True)
            click(client, smoke.button(client, "Scripts"))
            script_dialog = client.find("[role='dialog'][aria-label='Scripts']")
            client.element_command(client.find("[aria-label='Script name']"), "/clear")
            client.send_keys(client.find("[aria-label='Script name']"), "SQLite smoke")
            client.element_command(client.find("[aria-label='Working directory']"), "/clear")
            client.send_keys(client.find("[aria-label='Working directory']"), str(root))
            code = (
                "api.writeText('script-output.md', '# Script output'); "
                "const r = api.run('printf', ['sqlite run ok']); console.log(r.stdout); "
                "return '# Applied script result';"
            )
            client.element_command(client.find("[aria-label='Script code']"), "/clear")
            client.send_keys(client.find("[aria-label='Script code']"), code)
            click(client, smoke.button(client, "Save script"))
            smoke.wait_for(client, "Array.from(document.querySelectorAll('[aria-label=\\\"Saved script\\\"] option')).some(option => option.textContent === 'SQLite smoke')", "saved script entry")
            click(client, smoke.button(client, "Run script"))
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Scripts\\\"] [aria-label=\\\"Script output\\\"]')?.innerText.includes('Applied script result')", "native script result")
            smoke.require((root / "script-output.md").read_text(encoding="utf-8") == "# Script output",
                          "Native script API did not write into the isolated workspace")
            client.execute("document.querySelector('[aria-label=\"Scripts\"] details.script-runs summary')?.click()")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Scripts\\\"] [aria-label^=\\\"Run result \\\"]')", "saved script run history")
            click(client, smoke.button(client, "Close scripts"))

            print("Creating file revisions, restoring one without overwriting source", flush=True)
            document_path = str(beta)
            rev_a = "# Beta\n\nRevision A.\n"
            rev_b = "# Beta\n\nRevision B remains on disk.\n"
            client.element_command(smoke.button(client, "Source"), "/click")
            editor = smoke.active_editor(client)
            smoke.replace_editor_text(client, editor, rev_a)
            client.element_command(smoke.button(client, "Save"), "/click")
            smoke.wait_for(client, "document.querySelector('.save-state')?.innerText === 'Saved'", "first beta revision saved")
            editor = smoke.active_editor(client)
            smoke.replace_editor_text(client, editor, rev_b)
            client.element_command(smoke.button(client, "Save"), "/click")
            smoke.wait_for(client, "document.querySelector('.save-state')?.innerText === 'Saved'", "latest beta revision saved")
            smoke.require(beta.read_text(encoding="utf-8") == rev_b, "Latest explicit Save did not update the workspace source")
            click(client, smoke.button(client, "History"))
            smoke.wait_for(client, "document.querySelector('[aria-label=\"History\"] .revision-list button')", "stored revision history")
            revision_count = client.execute("return document.querySelectorAll('[aria-label=\\\"History\\\"] .revision-list button').length")
            smoke.require(revision_count >= 2, f"Expected at least two revisions, found {revision_count}")
            revision = client.find("//section[@aria-label='History']//div[@class='revision-list']/button[contains(.,'Revision A.')]", using="xpath")
            click(client, revision)
            smoke.wait_for(client, "document.querySelector('[aria-label=\"Revision comparison\"] details summary')", "revision source disclosure")
            click(client, client.find("[aria-label='Revision comparison'] details summary"))
            smoke.wait_for(client, "document.querySelector('[aria-label=\"Revision content\"]')?.innerText.includes('Revision')", "selected revision content")
            click(client, smoke.button(client, "Restore revision"))
            smoke.require(smoke.editor_text(client) == rev_a,
                          f"Restoring the selected older revision did not update editor text: {smoke.editor_text(client)!r}")
            smoke.require(beta.read_text(encoding="utf-8") == rev_b, "Revision restore overwrote the workspace source file")
            editor = smoke.active_editor(client)
            client.element_command(editor, "/click")
            client.send_keys(editor, "\ue009z\ue000")
            smoke.require(smoke.editor_text(client) == rev_b, "Revision restore could not be undone in the editor")

            print("Verifying app state and disposable index survive reindex", flush=True)
            click(client, smoke.button(client, "Workspace"))
            smoke.wait_for(client, "document.querySelector('[aria-label=\"Workspace\"]')", "workspace panel after history")
            search = client.find("[aria-label='Search notes']")
            client.element_command(search, "/clear")
            client.send_keys(search, "External refresh marker")
            click(client, smoke.button(client, "Refresh index"))
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"] [aria-label=\\\"Open note: alpha.md\\\"]')", "Alpha search result after reindex")
            click(client, smoke.button(client, "Scripts"))
            client.execute("document.querySelector('[aria-label=\"Scripts\"] details.script-runs summary')?.click()")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Scripts\\\"] [aria-label^=\\\"Run result \\\"]')", "script run after reindex")
            click(client, smoke.button(client, "Close scripts"))

            smoke.wait_for(client, "document.querySelector('.database-state')?.dataset.state === 'saved'", "app state saved before restart")
            database = data / "local.notation.app" / "state.sqlite3"
            with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
                old_draft = connection.execute("SELECT json FROM drafts WHERE id=1").fetchone()
            smoke.require(old_draft is not None and json.loads(old_draft[0]).get("content") == rev_b,
                          f"Expected current database draft {rev_b!r} before recovery simulation, got {old_draft!r}")
            cached_draft = {
                "id": "native-pending-recovery",
                "name": "recovery.md",
                "path": None,
                "content": "# Newer cached recovery",
                "savedContent": "",
                "savedName": "recovery.md",
                "updatedAt": int(time.time() * 1000),
            }
            client.execute(
                "localStorage.setItem('notation.pending-recovery', JSON.stringify(arguments[0]))",
                [{"draft": cached_draft, "failedAt": int(time.time() * 1000)}],
            )
            client.quit()
            print("Restarting the packaged app with pending recovery cached", flush=True)
            session = client.create_session(app)
            print(f"SQLite recovery restart session started: {session}", flush=True)
            smoke.wait_for(client, "document.querySelector('main.app')", "restarted native app UI")
            smoke.wait_for(client, "document.querySelector('.recovery-banner')?.innerText.includes('cached draft')", "pending recovery banner after restart")
            with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
                preserved = connection.execute("SELECT json FROM drafts WHERE id=1").fetchone()
            smoke.require(preserved is not None and json.loads(preserved[0]).get("content") == rev_b,
                          "Existing database draft was replaced before the user recovered the newer local cache")
            click(client, smoke.button(client, "Recover cached draft"))
            smoke.wait_for(client, "Array.from(document.querySelectorAll('.cm-content')).some(e => e.innerText.includes('Newer cached recovery'))", "cached recovery applied after restart")
            smoke.wait_for(client, "document.querySelector('.database-state')?.dataset.state === 'saved'", "recovered draft persisted")
            smoke.wait_for(client, "JSON.parse(localStorage.getItem('notation.pending-recovery') || 'null') === null", "pending recovery cache cleared after successful save")
            click(client, smoke.button(client, "Workspace"))
            smoke.wait_for(client, f"document.querySelector('[aria-label=\\\"Workspace folder\\\"]')?.value === {json.dumps(str(workspace))}", "workspace selection persisted across app restart")
            smoke.wait_for(client, "document.querySelectorAll('[aria-label=\\\"Workspace\\\"] .workspace-results button.note-result[aria-label^=\\\"Open note: \\\"]').length === 3", "workspace search results restored after restart")
            smoke.wait_for(client, "document.querySelector('[aria-label=\\\"Workspace\\\"]')?.getBoundingClientRect().width > 0", "visible workspace panel before screenshot")
            client.execute_async(
                "const done = arguments[arguments.length - 1]; "
                "requestAnimationFrame(() => requestAnimationFrame(done));"
            )
            screenshot = Path(__file__).resolve().parents[2] / "test-results" / "notation-sqlite-native.png"
            screenshot.parent.mkdir(parents=True, exist_ok=True)
            client.screenshot(screenshot)
            smoke.require(screenshot.is_file() and screenshot.stat().st_size > 1000,
                          f"Native SQLite screenshot is missing or too small: {screenshot}")
            print(f"Native SQLite screenshot saved to {screenshot}", flush=True)
            client.quit()
            print("Native window closed; checking the isolated SQLite database read-only", flush=True)
            smoke.require(database.is_file(), f"Native app did not create its SQLite database: {database}")
            with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
                tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                required = {"app_meta", "settings", "drafts", "scripts", "script_runs", "revisions", "recents", "workspaces",
                            "cache_files", "cache_fts", "cache_links", "cache_tags", "cache_tasks"}
                smoke.require(required <= tables, f"SQLite database lacks expected app/cache tables: {required - tables}")
                script_count = connection.execute("SELECT count(*) FROM scripts WHERE name='SQLite smoke'").fetchone()[0]
                run_count = connection.execute("SELECT count(*) FROM script_runs").fetchone()[0]
                revision_count = connection.execute("SELECT count(*) FROM revisions WHERE path=?", (document_path,)).fetchone()[0]
                indexed_files = connection.execute("SELECT count(*) FROM cache_files").fetchone()[0]
                cached_tasks = connection.execute("SELECT count(*) FROM cache_tasks").fetchone()[0]
                stored_workspace = connection.execute("SELECT path FROM workspaces WHERE id=1").fetchone()
                smoke.require(script_count == 1 and run_count >= 1, f"Native script state was not persisted: scripts={script_count}, runs={run_count}")
                smoke.require(revision_count >= 2, f"Expected two file revisions, found {revision_count}")
                smoke.require(indexed_files == 3, f"Expected three indexed source files, found {indexed_files}")
                smoke.require(cached_tasks == 2, f"Expected two indexed tasks after Beta was replaced with a task-free revision, found {cached_tasks}")
                smoke.require(stored_workspace == (str(workspace),), f"Workspace path was not persisted: {stored_workspace!r}")
                draft_state = connection.execute("SELECT json FROM drafts WHERE id=1").fetchone()
                smoke.require(draft_state is not None and json.loads(draft_state[0]).get("content") == "# Newer cached recovery",
                              "Recovered draft did not persist as authoritative app state")
                smoke.require(connection.execute("SELECT count(*) FROM recents").fetchone()[0] >= 2, "Opening workspace notes did not persist recents")
            print(f"SQLite native smoke passed: scripts={script_count}, runs={run_count}, revisions={revision_count}, indexed={indexed_files}, tasks={cached_tasks}")
        finally:
            try:
                client.quit()
            except Exception as error:
                print(f"WebDriver session cleanup failed: {error}", file=sys.stderr)
            if driver is not None and driver.poll() is None:
                try:
                    smoke.os.killpg(driver.pid, smoke.signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    driver.wait(timeout=5)
                except smoke.subprocess.TimeoutExpired:
                    try:
                        smoke.os.killpg(driver.pid, smoke.signal.SIGKILL)
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
    parser.add_argument(
        "--app",
        type=Path,
        default=Path(os.environ.get("NOTATION_APP", str(Path.home() / ".local/bin/notation"))),
        help="absolute staged launcher or AppImage path",
    )
    args = parser.parse_args()
    try:
        run(args.app.expanduser().resolve())
    except Exception as error:
        print(f"NATIVE SQLITE SMOKE FAILED: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
