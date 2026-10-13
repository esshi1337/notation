#!/usr/bin/env python3
"""Verify graceful close of an isolated native Notation window.

The test sends Hyprland's real close-window dispatcher to only the window
created by this run. It never targets an existing Notation window.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time

import smoke


def hyprland_clients() -> list[dict[str, object]]:
    result = subprocess.run(["hyprctl", "-j", "clients"], capture_output=True, text=True)
    if result.returncode:
        raise smoke.WebDriverError(f"hyprctl clients failed: {result.stderr.strip()}")
    value = json.loads(result.stdout)
    if not isinstance(value, list):
        raise smoke.WebDriverError(f"hyprctl clients returned unexpected JSON: {value!r}")
    return [client for client in value if isinstance(client, dict)]


def client_for(address: str) -> dict[str, object] | None:
    return next((client for client in hyprland_clients() if client.get("address") == address), None)


def active_window() -> dict[str, object]:
    result = subprocess.run(["hyprctl", "-j", "activewindow"], capture_output=True, text=True)
    if result.returncode:
        raise smoke.WebDriverError(f"hyprctl activewindow failed: {result.stderr.strip()}")
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise smoke.WebDriverError(f"hyprctl activewindow returned unexpected JSON: {value!r}")
    return value


def wait_for_window(address: str, present: bool, timeout: float = 10) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if (client_for(address) is not None) is present:
            return True
        time.sleep(0.1)
    return (client_for(address) is not None) is present


def target_pid_is_isolated(pid: int, data_home: Path) -> bool:
    try:
        environment = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    except OSError:
        return False
    expected = b"XDG_DATA_HOME=" + os.fsencode(data_home)
    return expected in environment


def run(app: Path, expected: str) -> None:
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
    new_address: str | None = None
    test_pid: int | None = None
    with tempfile.TemporaryDirectory(prefix="notation-close-smoke-") as temporary:
        root = Path(temporary)
        data, config = root / "data", root / "config"
        data.mkdir(); config.mkdir()
        environment = os.environ.copy()
        environment["XDG_DATA_HOME"] = str(data)
        environment["XDG_CONFIG_HOME"] = str(config)
        environment["TAURI_WEBVIEW_AUTOMATION"] = "true"
        log_path = root / "tauri-driver.log"
        driver_log = log_path.open("wb")
        before = {str(window.get("address")) for window in hyprland_clients()}
        try:
            driver = subprocess.Popen(
                [str(smoke.DRIVER), "--port", str(smoke.DRIVER_PORT), "--native-port", str(smoke.NATIVE_PORT),
                 "--native-driver", str(smoke.WEBDRIVER)],
                stdin=subprocess.DEVNULL, stdout=driver_log, stderr=subprocess.STDOUT,
                env=environment, start_new_session=True,
            )
            smoke.wait_for_driver(driver, log_path)
            session = client.create_session(app)
            print(f"Close smoke WebDriver session started: {session}", flush=True)
            smoke.wait_for(client, "document.querySelector('main.app')", "isolated Notation window")
            smoke.wait_for(client, "document.querySelector('.database-state')?.dataset.state === 'saved'",
                           "isolated app state committed")
            deadline = time.monotonic() + 10
            new_window = None
            while time.monotonic() < deadline:
                new_window = next((window for window in hyprland_clients()
                                   if str(window.get("address")) not in before
                                   and ("notation" in str(window.get("title", "")).lower()
                                        or "notation" in str(window.get("class", "")).lower()
                                        or "notation" in str(window.get("initialClass", "")).lower())), None)
                if new_window is not None:
                    break
                time.sleep(0.1)
            smoke.require(new_window is not None,
                          "Could not identify the newly created Notation Hyprland client without selecting existing windows")
            new_address = str(new_window["address"])
            test_pid = int(new_window.get("pid", 0))
            smoke.require(target_pid_is_isolated(test_pid, data),
                          f"New window PID {test_pid} does not carry the isolated XDG_DATA_HOME; refusing to target it")
            print(f"Identified isolated window address={new_address} pid={test_pid}", flush=True)

            client.execute("""
window.__notationCloseErrors = [];
window.addEventListener('unhandledrejection', event => {
  const item = { type: 'unhandledrejection', message: String(event.reason), stack: event.reason?.stack || null };
  window.__notationCloseErrors.push(item);
  try { localStorage.setItem('notation.close-smoke-errors', JSON.stringify(window.__notationCloseErrors)); } catch {}
});
window.addEventListener('error', event => {
  const item = { type: 'error', message: event.message, stack: event.error?.stack || null };
  window.__notationCloseErrors.push(item);
  try { localStorage.setItem('notation.close-smoke-errors', JSON.stringify(window.__notationCloseErrors)); } catch {}
});
""")
            # Focusing the active editor ensures the tested window is selected.
            # The Lua assertion and close run in one command so a stale focus can
            # never send the real Super+Q binding to an existing user window.
            client.element_command(smoke.active_editor(client), "/click")
            active_pid = active_window().get("pid")
            smoke.require(active_pid == test_pid,
                          f"Refusing to close: test PID {test_pid} is not active (active PID={active_pid!r})")
            print(f"Sending live Super+Q close binding to active isolated PID {test_pid}", flush=True)
            command = (f"local w=hl.get_active_window(); assert(w and w.pid=={test_pid}, "
                       "'refusing to close a non-test window'); hl.dispatch(hl.dsp.window.close())")
            dispatched = subprocess.run(["hyprctl", "eval", command], capture_output=True, text=True)
            smoke.require(dispatched.returncode == 0,
                          f"Hyprland close Lua binding failed: {dispatched.stderr.strip()} {dispatched.stdout.strip()}")
            closed = wait_for_window(new_address, False, 8)
            if closed:
                smoke.require(expected == "closed",
                              "Window closed successfully, but this run expected the pre-fix failure")
                print("Hyprland close removed the isolated app window.", flush=True)
                try:
                    client.quit()
                except Exception:
                    pass

                # A second run writes a dirty, multi-tab session immediately
                # before Super+Q. The native close handler must flush pending
                # session state before destroying the real window.
                before = {str(window.get("address")) for window in hyprland_clients()}
                session = client.create_session(app)
                print(f"Pending-session close WebDriver session started: {session}", flush=True)
                smoke.wait_for(client, "document.querySelector('main.app')", "second native app window")
                deadline = time.monotonic() + 10
                new_window = None
                while time.monotonic() < deadline:
                    new_window = next((window for window in hyprland_clients()
                                       if str(window.get("address")) not in before
                                       and ("notation" in str(window.get("title", "")).lower()
                                            or "notation" in str(window.get("class", "")).lower()
                                            or "notation" in str(window.get("initialClass", "")).lower())), None)
                    if new_window is not None:
                        break
                    time.sleep(0.1)
                smoke.require(new_window is not None, "Could not identify the second isolated app window")
                new_address = str(new_window["address"])
                test_pid = int(new_window.get("pid", 0))
                smoke.require(target_pid_is_isolated(test_pid, data),
                              f"Second app PID {test_pid} is not isolated; refusing to target it")
                client.execute("""
window.__notationCloseErrors = [];
window.addEventListener('unhandledrejection', event => {
  const item = { type: 'unhandledrejection', message: String(event.reason), stack: event.reason?.stack || null };
  window.__notationCloseErrors.push(item);
  try { localStorage.setItem('notation.close-smoke-errors', JSON.stringify(window.__notationCloseErrors)); } catch {}
});
window.addEventListener('error', event => {
  const item = { type: 'error', message: event.message, stack: event.error?.stack || null };
  window.__notationCloseErrors.push(item);
  try { localStorage.setItem('notation.close-smoke-errors', JSON.stringify(window.__notationCloseErrors)); } catch {}
});
""")
                def wait_for_tabs(count: int) -> None:
                    expression = "document.querySelectorAll('[role=\"tablist\"][aria-label=\"Documents\"] [role=\"tab\"]').length === " + str(count)
                    smoke.wait_for(client, expression, f"{count} restored tabs")
                wait_for_tabs(1)
                client.element_command(smoke.button(client, "New"), "/click")
                pending_text = "pending close flush"
                client.send_keys(smoke.active_editor(client), pending_text)
                current_save = client.execute("return document.querySelector('.database-state')?.innerText")
                smoke.require(current_save == "Saving app state…",
                              f"Expected app state to be pending at close time, got {current_save!r}")
                client.element_command(smoke.active_editor(client), "/click")
                active_pid = active_window().get("pid")
                smoke.require(active_pid == test_pid,
                              f"Refusing to close: pending-session PID {test_pid} is not active (active PID={active_pid!r})")
                command = (f"local w=hl.get_active_window(); assert(w and w.pid=={test_pid}, "
                           "'refusing to close a non-test window'); hl.dispatch(hl.dsp.window.close())")
                dispatched = subprocess.run(["hyprctl", "eval", command], capture_output=True, text=True)
                smoke.require(dispatched.returncode == 0, f"Pending-session Super+Q failed: {dispatched.stderr.strip()}")
                smoke.require(wait_for_window(new_address, False, 10),
                              "Pending dirty session did not close after its state flush")
                try:
                    client.quit()
                except Exception:
                    pass
                database = data / "local.notation.app" / "state.sqlite3"
                with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
                    stored = connection.execute("SELECT json FROM sessions WHERE id=1").fetchone()
                smoke.require(stored is not None, "Close flush did not persist a tab session to SQLite")
                persisted = json.loads(stored[0])
                persisted_tabs = persisted.get("tabs", [])
                smoke.require(len(persisted_tabs) == 2 and
                              any(tab.get("content") == pending_text and tab.get("savedContent") != pending_text
                                  for tab in persisted_tabs),
                              f"Close flush lost the pending dirty tab: {persisted!r}")
                smoke.require(persisted.get("activeTabId") in {tab.get("id") for tab in persisted_tabs},
                              f"Close flush persisted an invalid active tab id: {persisted!r}")

                # Restart the actual app against the same isolated profile and
                # check both the active selection and inactive draft content.
                before = {str(window.get("address")) for window in hyprland_clients()}
                session = client.create_session(app)
                print(f"Session-restart WebDriver session started: {session}", flush=True)
                smoke.wait_for(client, "document.querySelector('main.app')", "app after pending-session restart")
                deadline = time.monotonic() + 10
                new_window = None
                while time.monotonic() < deadline:
                    new_window = next((window for window in hyprland_clients()
                                       if str(window.get("address")) not in before
                                       and ("notation" in str(window.get("title", "")).lower()
                                            or "notation" in str(window.get("class", "")).lower()
                                            or "notation" in str(window.get("initialClass", "")).lower())), None)
                    if new_window is not None:
                        break
                    time.sleep(0.1)
                smoke.require(new_window is not None, "Could not identify the restarted isolated app window")
                new_address = str(new_window["address"])
                test_pid = int(new_window.get("pid", 0))
                smoke.require(target_pid_is_isolated(test_pid, data),
                              f"Restarted app PID {test_pid} is not isolated; refusing to target it")
                wait_for_tabs(2)
                smoke.wait_for(client, "Array.from(document.querySelectorAll('[role=tab]')).some(e => e.getAttribute('aria-selected') === 'true' && document.querySelector('.editor-tab-host:not([hidden]) .cm-content')?.innerText.includes('pending close flush'))",
                               "active pending close tab after restart")
                smoke.require(smoke.editor_text(client) == pending_text,
                              "Dirty tab contents did not survive the graceful close and restart")

                # Force both persistence stores to fail, make another dirty
                # edit, and choose Discard and close in the actual close dialog.
                database_lock = sqlite3.connect(database, timeout=0, isolation_level=None)
                database_lock.execute("BEGIN IMMEDIATE")
                client.execute("window.__notationOriginalSetItem = Storage.prototype.setItem; "
                               "Storage.prototype.setItem = function(){ throw new DOMException('Storage full', 'QuotaExceededError'); }")
                storage_probe = client.execute("try { localStorage.setItem('close-smoke-probe', 'x'); return 'unexpected success'; } catch (error) { return String(error); }")
                smoke.require("QuotaExceededError" in storage_probe,
                              f"Could not force localStorage failure: {storage_probe!r}")
                discarded_text = pending_text + "This edit will be discarded.\n"
                smoke.replace_editor_text(client, smoke.active_editor(client), discarded_text)
                smoke.wait_for(client, "document.querySelector('[role=alert]')?.innerText.toLowerCase().includes('recovery')",
                               "visible local-recovery failure", timeout=10)
                app_error = client.execute("return document.querySelector('[role=alert]')?.innerText")
                smoke.require(app_error and "recovery" in app_error.lower(),
                              f"Storage failure was not exposed before close: {app_error!r}")
                client.element_command(smoke.active_editor(client), "/click")
                active_pid = active_window().get("pid")
                smoke.require(active_pid == test_pid,
                              f"Refusing to close: discard-branch PID {test_pid} is not active (active PID={active_pid!r})")
                command = (f"local w=hl.get_active_window(); assert(w and w.pid=={test_pid}, "
                           "'refusing to close a non-test window'); hl.dispatch(hl.dsp.window.close())")
                dispatched = subprocess.run(["hyprctl", "eval", command], capture_output=True, text=True)
                smoke.require(dispatched.returncode == 0, f"Discard-branch Super+Q failed: {dispatched.stderr.strip()}")
                smoke.wait_for(client, "Array.from(document.querySelectorAll('dialog')).some(d => d.getAttribute('aria-label') === 'Unsaved recovery' && d.open)",
                               "discard-on-close dialog", timeout=20)
                close_dialog = client.find("dialog[aria-label='Unsaved recovery']")
                try:
                    client.element_command(smoke.button(client, "Discard and close"), "/click")
                except smoke.WebDriverError as error:
                    # The successful button action destroys this native window
                    # before WebKitWebDriver can answer the click request.
                    if wait_for_window(new_address, False, 10):
                        print(f"Discard-and-close click ended with the expected session teardown: {error}", flush=True)
                    else:
                        raise
                smoke.require(wait_for_window(new_address, False, 10),
                              "Explicit Discard and close did not destroy the test window")
                database_lock.rollback()
                database_lock.close()
                try:
                    client.quit()
                except Exception:
                    pass
                with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
                    final_session = connection.execute("SELECT json FROM sessions WHERE id=1").fetchone()
                smoke.require(final_session is not None and json.loads(final_session[0]) == persisted,
                              "Discard and close changed the last committed SQLite session")
                print("Clean close, pending dirty-session flush/restart, and explicit recovery discard all closed only their isolated windows", flush=True)
            else:
                evidence = client.execute(
                    "return {title: document.title, visible: document.visibilityState, "
                    "inert: document.querySelector('main.app')?.inert, "
                    "alerts: Array.from(document.querySelectorAll('[role=\\\"alert\\\"]')).map(e => e.innerText), "
                    "errors: window.__notationCloseErrors || JSON.parse(localStorage.getItem('notation.close-smoke-errors') || '[]'), "
                    "active: document.activeElement?.outerHTML}"
                )
                screenshot = Path(__file__).resolve().parents[2] / "test-results" / "notation-close-failure.png"
                screenshot.parent.mkdir(parents=True, exist_ok=True)
                client.screenshot(screenshot)
                print(f"Close failure evidence: {json.dumps(evidence, ensure_ascii=False)}", flush=True)
                print(f"Close failure screenshot: {screenshot}", flush=True)
                smoke.require(expected == "remains",
                              f"Hyprland close left the isolated app window open: {evidence!r}")
                print("Expected pre-fix close failure reproduced: isolated window remained mapped.", flush=True)
        finally:
            try:
                client.quit()
            except Exception as error:
                print(f"WebDriver session cleanup failed: {error}", file=sys.stderr)
            if new_address and client_for(new_address) is not None and test_pid and target_pid_is_isolated(test_pid, data):
                # Only reap this run's process, after any failure evidence was captured.
                try:
                    os.kill(test_pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
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
                        default=Path(os.environ.get("NOTATION_APP", str(Path.home() / ".local/bin/notation"))))
    parser.add_argument("--expect", choices=("closed", "remains"), default="closed",
                        help="require the target window to close, or to remain for pre-fix reproduction")
    args = parser.parse_args()
    try:
        run(args.app.expanduser().resolve(), args.expect)
    except Exception as error:
        print(f"NATIVE CLOSE SMOKE FAILED: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
