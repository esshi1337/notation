#!/usr/bin/env python3
"""Packaged WebKit playback and graph regression using disposable files/state."""
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import signal
import struct
import subprocess
import tempfile
import wave
import smoke
from tooling_smoke import invoke
from responsive_smoke import command
from workspaces_smoke import create,click,open_note


def stop_profile_apps(data_home):
    # WebDriver quit can leave a blank Tauri shell. Only stop this test's app.
    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        try:
            if (process / 'comm').read_text().strip() != 'notation':
                continue
            environment = (process / 'environ').read_bytes().split(bytes([0]))
            if ('XDG_DATA_HOME=' + str(data_home)).encode() in environment:
                os.kill(int(process.name), signal.SIGTERM)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass


def run(app):
    smoke.assert_ports_available()
    output = Path(__file__).resolve().parents[2] / 'test-results/native-media-graph'
    output.mkdir(parents=True, exist_ok=True)
    client = smoke.Client(smoke.BASE_URL)
    driver = None
    with tempfile.TemporaryDirectory(prefix='notation-media-graph-') as temporary:
        root = Path(temporary)
        data = root / 'data'
        notes = root / 'notes'
        notes.mkdir()
        sound = notes / 'chime.wav'
        with wave.open(str(sound), 'wb') as audio:
            audio.setparams((1, 2, 22050, 0, 'NONE', 'not compressed'))
            audio.writeframes(b''.join(struct.pack('<h', int(1200 * math.sin(i * 2 * math.pi * 440 / 22050))) for i in range(44100)))
        video = notes / 'playback.mp4'
        shutil.copyfile(Path(__file__).parent / 'fixtures/playback.mp4', video)
        media = notes / 'Media.md'
        media.write_text('# Playback\n\n![[chime.wav]]\n\n![[playback.mp4]]\n')
        paths = [sound, video, media]
        for index in range(24):
            note = notes / f'Note {index:02}.md'
            note.write_text(f'---\ntitle: Research note {index:02}\ntags: [demo]\n---\n# Research note {index:02}\n\n[[Note {(index + 1) % 24:02}]]\n\n[[Note 00]]\n')
            paths.append(note)
        env = {**os.environ, 'TAURI_WEBVIEW_AUTOMATION': 'true'}
        for key, folder in [('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache')]:
            directory = root / folder
            directory.mkdir(exist_ok=True)
            env[key] = str(directory)
        log_path = output / 'driver.log'
        with log_path.open('wb') as log:
            try:
                driver = subprocess.Popen([str(smoke.DRIVER), '--port', str(smoke.DRIVER_PORT), '--native-port', str(smoke.NATIVE_PORT), '--native-driver', str(smoke.WEBDRIVER)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                smoke.wait_for_driver(driver, log_path)
                client.create_session(app)
                smoke.wait_for(client, "document.querySelector('main.app')", 'packaged application')
                command(client, 'Workspace')
                identity = create(client, 'Playback and graph test')
                invoke(client, 'add_workspace_files', {'id': identity, 'paths': list(map(str, paths))})
                click(client, 'Refresh index')
                open_note(client, 'Media.md')
                command(client, 'Preview')
                if client.execute("return !!document.querySelector('.workspace-panel')"):
                    client.element_command(client.find('[aria-label="Close workspace"]'), '/click')
                smoke.wait_for(client, "document.querySelector('audio')?.readyState >= 1 && document.querySelector('video')?.readyState >= 1", 'audio and video metadata', timeout=30)
                # Metadata alone passes while WebKit still shows a loading spinner
                # and --:--. Local files are already in memory: finish buffering
                # before any play() call can hide this initial-controls regression.
                smoke.wait_for(client, "[...document.querySelectorAll('audio,video')].every(m => m.readyState === 4 && m.networkState === 1)", 'local media finishes loading before playback', timeout=15)
                initial = client.execute("return [...document.querySelectorAll('audio,video')].map(m => ({kind:m.tagName,duration:m.duration,paused:m.paused,time:m.currentTime,ready:m.readyState,network:m.networkState}))")
                smoke.require(all(m['paused'] and m['time'] == 0 and m['duration'] > 1 for m in initial), f'Media must be ready without autoplay: {initial}')
                client.screenshot(output / 'before-play.png')
                print('before-play: PASS ' + json.dumps(initial), flush=True)
                for kind in ['audio', 'video']:
                    result = client.execute_async("const done=arguments[arguments.length-1],m=document.querySelector(arguments[0]); m.muted=true; m.play().then(()=>done({playing:true})).catch(e=>done({error:String(e)}));", [kind])
                    smoke.require(result.get('playing'), f'{kind} could not play: {result}')
                    smoke.wait_for(client, f"document.querySelector('{kind}').currentTime > 0.25", kind + ' playback progresses')
                    result = client.execute("const m=document.querySelector(arguments[0]);const result={duration:m.duration,time:m.currentTime,ready:m.readyState,error:m.error?.message||null,width:m.videoWidth||null,height:m.videoHeight||null};m.pause();return result;", [kind])
                    smoke.require(result['error'] is None and result['duration'] > 1, f'{kind} invalid decode: {result}')
                    if kind == 'video':
                        smoke.require(result['width'] == 160 and result['height'] == 90, 'Video frame was not decoded')
                    print(kind + ': PASS ' + json.dumps(result), flush=True)
                client.screenshot(output / 'playback.png')
                for mode in ['Split', 'Live Preview']:
                    # Split can retain the existing Preview player and its play
                    # position. Unmount it first to check a genuinely fresh load.
                    command(client, 'Source')
                    smoke.wait_for(client, "document.querySelectorAll('audio,video').length === 0", 'previous media unmounted')
                    command(client, mode)
                    smoke.wait_for(client, "document.querySelectorAll('audio,video').length === 2 && [...document.querySelectorAll('audio,video')].every(m => m.readyState === 4 && m.networkState === 1 && m.paused && m.currentTime === 0 && m.duration > 1)", mode + ' media ready without autoplay', timeout=15)
                    client.screenshot(output / (mode.lower().replace(' ', '-') + '-ready.png'))
                    print(mode + ': PASS local media ready without autoplay', flush=True)
                command(client, 'Preview')
                command(client, 'Workspace')
                open_note(client, 'Note 00.md')
                command(client, 'Note graph')
                smoke.wait_for(client, "document.querySelectorAll('[data-graph-node]').length === 25", 'indexed native graph')
                graph = client.execute("const v=document.querySelector('.graph-viewport').getBoundingClientRect();const labels=[...document.querySelectorAll('.note-label')].map(e=>e.getBoundingClientRect());return {nodes:labels.length,minLabelHeight:Math.min(...labels.map(r=>r.height)),viewportWidth:v.width,alerts:[...document.querySelectorAll('.graph-panel [role=alert]')].map(e=>e.textContent)}")
                smoke.require(graph['minLabelHeight'] >= 10 and not graph['alerts'], f'Graph labels are unreadable: {graph}')
                client.screenshot(output / 'graph.png')
                smoke.fill_control(client, '[aria-label="Graph filter"]', 'Research note 05')
                smoke.wait_for(client, "document.querySelectorAll('[data-graph-node]').length === 1", 'filtered graph')
                smoke.wait_for(client, "(()=>{const n=document.querySelector('.note-card').getBoundingClientRect(),v=document.querySelector('.graph-viewport').getBoundingClientRect();return n.left>=v.left && n.right<=v.right && n.top>=v.top && n.bottom<=v.bottom})()", 'filtered node framed')
                node = client.find('[data-graph-node] .note-card')
                client.element_command(node, '/click')
                smoke.wait_for_active_tab(client, 'Note 05.md')
                print('graph: PASS ' + json.dumps(graph), flush=True)
                print('PASS: native WAV/H.264 decoding and progressing playback, contained readable graph, filtering and opening a note', flush=True)
            finally:
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
    run(parser.parse_args().app.resolve())
