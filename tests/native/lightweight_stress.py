#!/usr/bin/env python3
"""Bounded packaged stress test; all state and file requests use disposable profiles."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time
import smoke
from responsive_smoke import command
from media_graph_smoke import stop_profile_apps
from instance_smoke import rpc, owners, wait_until
from tooling_smoke import invoke


def resources(data):
    processes = {}
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            processes[int(path.name)] = {'pid': int(path.name), 'ppid': int(fields[1]),
                'cpuTicks': int(fields[11]) + int(fields[12]),
                'rssKiB': int(fields[21]) * os.sysconf('SC_PAGE_SIZE') // 1024,
                'name': (path / 'comm').read_text().strip()}
        except (OSError, ValueError):
            pass
    selected = set(owners(data))
    for _ in range(10):
        selected.update(pid for pid, row in processes.items() if row['ppid'] in selected)
    rows = []
    for pid in sorted(selected):
        if pid not in processes:
            continue
        row = processes[pid]
        try:
            lines = Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines()
            row['pssKiB'] = next(int(line.split()[1]) for line in lines if line.startswith('Pss:'))
        except (OSError, StopIteration):
            row['pssKiB'] = None
        rows.append(row)
    return {'processes': rows, 'rssKiB': sum(row['rssKiB'] for row in rows),
            'pssKiB': sum(row['pssKiB'] or 0 for row in rows), 'time': time.monotonic()}


def run(app, output):
    smoke.assert_ports_available()
    output.mkdir(parents=True, exist_ok=True)
    report = {'checks': {}, 'measurements': {}, 'resources': {}}
    driver = None
    client = smoke.Client(smoke.BASE_URL)
    with tempfile.TemporaryDirectory(prefix='nt-light-stress-') as temporary:
        root = Path(temporary)
        data = root / 'data'
        env = {**os.environ, 'TAURI_WEBVIEW_AUTOMATION': 'true'}
        for key, name in [('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache')]:
            (root / name).mkdir()
            env[key] = str(root / name)
        child_env = dict(env)
        child_env.pop('TAURI_WEBVIEW_AUTOMATION', None)
        files = root / 'files'
        files.mkdir()
        fixtures = [('md', '# Note\n\nA lightweight note with **formatting**.\n'),
                    ('ts', 'export const answer: number = 42;\n'),
                    ('svelte', '<script>let count = 0;</script>\n<p>{count}</p>\n'),
                    ('rs', 'fn main() { let answer = 42; }\n'), ('txt', 'A plain text document.\n')]
        paths = []
        for index in range(62):
            extension, content = fixtures[index % len(fixtures)]
            path = files / f'file-{index:02d}.{extension}'
            path.write_text(content * 20)
            paths.append(path)
        large = files / 'large.ts'
        large.write_text(''.join(f'export const value{index} = {index};\n' for index in range(60000)))
        paths.append(large)
        report['measurements']['largeCodeBytes'] = large.stat().st_size
        report['measurements']['largeCodeLines'] = 60000
        def launch(paths):
            result = subprocess.run([str(app), *map(str, paths)], env=child_env, capture_output=True, text=True, timeout=30)
            smoke.require(result.returncode == 0, 'File handoff failed: ' + result.stderr)
        def no_servers():
            smoke.require(invoke(client, 'lsp_status', {}) == [], 'Language servers started without opt-in')
            snapshot = resources(data)
            smoke.require(not any(row['name'] in ('node', 'rust-analyzer') for row in snapshot['processes']), 'Unexpected language process')
            return snapshot
        samples = []
        stop_sampling = threading.Event()
        def sample_resources():
            while not stop_sampling.wait(1):
                samples.append(resources(data))
        sampler = threading.Thread(target=sample_resources, daemon=True)
        sampler.start()
        with (output / 'driver.log').open('wb') as log:
            try:
                driver = subprocess.Popen([str(smoke.DRIVER), '--port', str(smoke.DRIVER_PORT), '--native-port', str(smoke.NATIVE_PORT), '--native-driver', str(smoke.WEBDRIVER)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                smoke.wait_for_driver(driver, output / 'driver.log')
                client.create_session(app)
                smoke.wait_for(client, "document.querySelector('main.app')", 'packaged app')
                report['resources']['startup'] = no_servers()
                started = time.monotonic()
                launch(paths)
                wait_until(lambda: len(rpc(data, 'list_tabs')['tabs']) == 64, '64 tabs', timeout=90)
                smoke.wait_for_active_tab(client, 'large.ts')
                report['measurements']['open63FilesSeconds'] = time.monotonic() - started
                smoke.require(client.execute('return document.querySelector(".preview-pane").hidden'), 'Code preview is visible')
                smoke.require(client.execute('return !document.querySelector(".code-heading")'), 'Prominent language toolbar remains')
                report['resources']['64tabs'] = no_servers()
                report['checks']['64MixedTabsWithoutServers'] = True
                client.execute("window.stressKeys=[];document.addEventListener('keydown',e=>{if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){const start=performance.now();requestAnimationFrame(()=>window.stressKeys.push(performance.now()-start));}},true)")
                started = time.monotonic()
                editor = smoke.active_editor(client)
                client.element_command(editor, '/click')
                client.send_keys(editor, '\ue009\ue011\ue000')
                client.send_keys(editor, '// stress edit')
                client.send_keys(editor, '\ue007')
                smoke.wait_for(client, 'document.querySelector(".editor-tab-host:not([hidden]) .cm-content")?.textContent.includes("stress edit")', 'typing in large source')
                report['measurements']['largeCodeTypingSeconds'] = time.monotonic() - started
                client.execute_async('const done=arguments[arguments.length-1];requestAnimationFrame(()=>done(true))')
                frames=sorted(client.execute('return window.stressKeys'))
                smoke.require(bool(frames), 'No real key/frame samples collected')
                report['measurements']['keyToNextFrameP50Ms'] = frames[len(frames)//2]
                report['measurements']['keyToNextFrameP95Ms'] = frames[min(len(frames)-1,int(len(frames)*.95))]
                command(client, 'Save')
                wait_until(lambda: large.read_text().startswith('// stress edit'), 'saved stress edit')
                extra = files / 'over-limit.txt'
                extra.write_text('extra')
                launch([extra])
                smoke.wait_for(client, 'document.body.textContent.includes("64-tab limit")', 'tab cap feedback')
                smoke.require(len(rpc(data, 'list_tabs')['tabs']) == 64, 'Tab cap exceeded')
                report['checks']['tabCapPreservesBuffers'] = True
                time.sleep(5)  # Allow parsing and recovery writes to settle before idle sampling.
                before = no_servers()
                time.sleep(5)
                after = no_servers()
                previous = {row['pid']: row['cpuTicks'] for row in before['processes']}
                ticks = sum(max(0, row['cpuTicks'] - previous.get(row['pid'], row['cpuTicks'])) for row in after['processes'])
                report['measurements']['idleCpuPercentOneCore'] = ticks / os.sysconf('SC_CLK_TCK') / (after['time'] - before['time']) * 100
                report['resources']['64tabsIdle'] = after
                client.screenshot(output / '64-tabs.png')
                started = time.monotonic()
                for _ in range(63):
                    command(client, 'Close tab')
                wait_until(lambda: len(rpc(data, 'list_tabs')['tabs']) == 1, 'all stress files closed')
                report['measurements']['close63TabsSeconds'] = time.monotonic() - started
                report['resources']['afterClosing'] = no_servers()
                for _ in range(12):
                    launch([paths[1]])
                    smoke.wait_for_active_tab(client, paths[1].name)
                    command(client, 'Close tab')
                report['checks']['12OpenCloseCycles'] = True
                report['resources']['afterCycles'] = no_servers()
                markdown = files / 'large.md'
                markdown.write_text('# Markdown stress\n\n' + '\n\n'.join(f'## Section {i}\n\nA paragraph with **bold text**, a [local link](note.md), and a few more words.\n\n- First item\n- Second item' for i in range(1200)))
                started = time.monotonic()
                launch([markdown])
                smoke.wait_for_active_tab(client, markdown.name)
                smoke.wait_for(client, 'document.querySelector(".preview-pane h2")', 'large Markdown preview')
                report['measurements']['markdownBytes'] = markdown.stat().st_size
                report['measurements']['markdownOpenAndPreviewSeconds'] = time.monotonic() - started
                report['resources']['markdownPreview'] = no_servers()
                client.screenshot(output / 'markdown.png')
                command(client, 'Close tab')
                near_limit = files / 'near-limit.txt'
                line = 'Plain text stays editable without language servers.\n'
                near_limit.write_text((line * ((4 * 1024 * 1024 - 128) // len(line))))
                started = time.monotonic()
                launch([near_limit])
                smoke.wait_for_active_tab(client, near_limit.name)
                report['measurements']['nearLimitBytes'] = near_limit.stat().st_size
                report['measurements']['nearLimitOpenSeconds'] = time.monotonic() - started
                oversized = files / 'too-large.txt'
                oversized.write_bytes(b'x' * (4 * 1024 * 1024 + 1))
                launch([oversized])
                smoke.wait_for(client, 'document.querySelector("[role=alert]")?.textContent.includes("4 MiB")', 'oversize error')
                smoke.require(len(rpc(data, 'list_tabs')['tabs']) == 2, 'Oversize file created a tab')
                report['checks']['fileSizeBoundary'] = True
                report['resources']['nearLimit'] = no_servers()
                command(client, 'Close tab')
                time.sleep(10)
                report['resources']['settledAfterClosingAllStressFiles'] = no_servers()
                # Enabling without acquiring the optional pack must remain actionable and safe.
                launch([paths[1]])
                smoke.wait_for_active_tab(client, paths[1].name)
                command(client, 'Settings')
                client.element_command(client.find('//*[@role="tab" and normalize-space(.)="Editor"]', using='xpath'), '/click')
                checkbox = client.find('//label[contains(.,"Language intelligence")]/input', using='xpath')
                smoke.require(not client.execute('return document.querySelector(".language-setup").previousElementSibling.previousElementSibling.querySelector("input").checked'), 'Default intelligence is enabled')
                client.element_command(checkbox, '/click')
                client.element_command(client.find('button[aria-label="Close settings"]'), '/click')
                smoke.wait_for(client, 'document.querySelector(".intelligence-status")?.textContent.includes("Tools unavailable")', 'missing package feedback')
                smoke.require(not any(item['running'] for item in invoke(client, 'lsp_status', {})), 'Missing pack spawned server')
                report['checks']['missingPackRemainsEditable'] = True
                report['checks']['passed'] = True
                print(json.dumps(report, indent=2), flush=True)
                client.execute("setTimeout(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'}),50);return true")
                time.sleep(1)
            except Exception as error:
                report['error'] = str(error)
                try:
                    client.screenshot(output / 'failure.png')
                    (output / 'failure.txt').write_text(client.execute('return document.body.innerText'))
                except Exception:
                    pass
                raise
            finally:
                stop_sampling.set()
                sampler.join(timeout=5)
                (output / 'process-samples.json').write_text(json.dumps(samples, indent=2))
                if samples:
                    report['measurements']['sampledPeakPssKiB'] = max(sample['pssKiB'] for sample in [*samples, *report['resources'].values()])
                    report['measurements']['sampledPeakRssKiB'] = max(sample['rssKiB'] for sample in [*samples, *report['resources'].values()])
                    cpu_samples = []
                    for before, after in zip(samples, samples[1:]):
                        prior = {row['pid']: row['cpuTicks'] for row in before['processes']}
                        ticks = sum(max(0, row['cpuTicks'] - prior.get(row['pid'], row['cpuTicks'])) for row in after['processes'])
                        cpu_samples.append(ticks / os.sysconf('SC_CLK_TCK') / (after['time'] - before['time']) * 100)
                    report['measurements']['sampledPeakCpuPercentOneCore'] = max(cpu_samples, default=0)
                (output / 'report.json').write_text(json.dumps(report, indent=2))
                if client.session_id:
                    try:
                        client.quit()
                    except smoke.WebDriverError:
                        pass
                stop_profile_apps(data)
                if driver and driver.poll() is None:
                    os.killpg(driver.pid, signal.SIGTERM)
                    try:
                        driver.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(driver.pid, signal.SIGKILL)
                        driver.wait(timeout=5)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    run(args.app.resolve(), args.output.resolve())
