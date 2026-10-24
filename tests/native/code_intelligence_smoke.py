#!/usr/bin/env python3
"""Real packaged-WebKit acceptance for code editing and local language servers."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import smoke
from responsive_smoke import command
from media_graph_smoke import stop_profile_apps
from tooling_smoke import invoke
from instance_smoke import rpc, owners


def run(app, output):
    smoke.assert_ports_available(); output.mkdir(parents=True, exist_ok=True)
    client=smoke.Client(smoke.BASE_URL); driver=None
    with tempfile.TemporaryDirectory(prefix='nt-code-') as temporary:
        root=Path(temporary); project=root/'typescript'; project.mkdir()
        (project/'tsconfig.json').write_text(json.dumps({'compilerOptions':{'strict':True,'target':'ES2022','module':'ESNext'},'include':['*.ts','*.svelte']}))
        (project/'package.json').write_text('{"type":"module"}')
        (project/'svelte.config.js').write_text('import fs from "node:fs"; fs.writeFileSync('+json.dumps(str(root/'svelte-config-executed'))+', "unsafe"); export default {};')
        (project/'prettier.config.cjs').write_text('require("fs").writeFileSync('+json.dumps(str(root/'prettier-config-executed'))+', "unsafe"); module.exports = {};')
        fake_ts=project/'node_modules/typescript/lib';fake_ts.mkdir(parents=True)
        (fake_ts.parent/'package.json').write_text('{"name":"typescript","version":"5.9.3","main":"lib/typescript.js"}')
        (fake_ts/'tsserver.js').write_text('require("fs").writeFileSync('+json.dumps(str(root/'project-typescript-executed'))+', "unsafe"); process.exit(1);')
        (project/'helper.ts').write_text('export function greet(name: string) { return "Hi " + name; }\n')
        main=project/'main.ts';main.write_text('import { greet } from "./helper";\nconst broken: string = 123;\nconsole.log(greet("reader"));\n')
        component=project/'App.svelte';component.write_text('<script lang="ts">\n  let count: string = $state(123);\n</script>\n<p>{count}</p>\n')
        rust=root/'rust';(rust/'src').mkdir(parents=True)
        (rust/'Cargo.toml').write_text('[package]\nname="notation_lsp_smoke"\nversion="0.1.0"\nedition="2021"\n')
        rustfile=rust/'src/main.rs';rustfile.write_text('fn greet() -> i32 { 1 }\nfn main() { let count: i32 = "bad"; greet(); }\n')
        env={**os.environ,'TAURI_WEBVIEW_AUTOMATION':'true'}
        for key,name in [('XDG_DATA_HOME','data'),('XDG_CONFIG_HOME','config'),('XDG_CACHE_HOME','cache')]:
            (root/name).mkdir();env[key]=str(root/name)
        child_env=dict(env);child_env.pop('TAURI_WEBVIEW_AUTOMATION',None)
        logpath=output/'driver.log'
        with logpath.open('wb') as log:
            try:
                driver=subprocess.Popen([str(smoke.DRIVER),'--port',str(smoke.DRIVER_PORT),'--native-port',str(smoke.NATIVE_PORT),'--native-driver',str(smoke.WEBDRIVER)],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                smoke.wait_for_driver(driver,logpath);client.create_session(app)
                smoke.wait_for(client,"document.querySelector('main.app')",'packaged UI')
                client.execute_async("const done=arguments[arguments.length-1];window.lspMessages=[];window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'notation:lsp-message',target:{kind:'Any'},handler:window.__TAURI_INTERNALS__.transformCallback(event=>window.lspMessages.push(event.payload))}).then(done)")
                def open_file(path):
                    result=subprocess.run([str(app),str(path)],env=child_env,capture_output=True,text=True,timeout=30)
                    smoke.require(result.returncode==0,'File launch failed: '+result.stderr)
                    smoke.wait_for(client,'document.querySelector("[role=tab][aria-selected=true]")?.textContent.includes('+json.dumps(path.name)+')','code file opened')
                def ready(server):
                    smoke.wait_for(client,'document.querySelector(".code-heading [role=status]")?.textContent.includes('+json.dumps(server+' ready')+')',server+' ready')
                def diagnostics():
                    smoke.wait_for(client,'document.querySelector(".editor-tab-host:not([hidden]) .cm-lintRange-error")','live diagnostic')
                open_file(main);ready('typescript-language-server');diagnostics()
                smoke.require(client.execute('return document.querySelector(".preview-pane").hidden'),'Code opened in preview')
                command(client,'Format document');smoke.wait_for(client,'document.querySelector(".status-message")?.textContent.includes("formatted")','TypeScript formatting')
                smoke.replace_editor_text(client,smoke.active_editor(client),'import { greet } from "./helper";\nconsole.log(greet("reader"));\n')
                command(client,'Find')
                smoke.fill_control(client, '.editor-tab-host:not([hidden]) .cm-search input[name=search]', 'greet')
                client.send_keys(client.find('.editor-tab-host:not([hidden]) .cm-search input[name=search]'), "\ue007\ue00c")
                snapshot=rpc(root/'data','list_tabs'); selected=rpc(root/'data','read_tab',{'tabId':snapshot['activeTabId']}); smoke.require(selected['content'][selected['selection']['anchor']:selected['selection']['head']]=='greet','Find did not select the intended symbol')
                command(client,'Go to definition')
                smoke.wait_for(client,'document.querySelector("[role=tab][aria-selected=true]")?.textContent.includes("helper.ts")','definition navigation')
                ready('typescript-language-server'); command(client,'Find references')
                smoke.wait_for(client, '''document.querySelector('[aria-label="Reference list"]')''', 'references panel')
                command(client,'Rename symbol')
                smoke.fill_control(client,'[aria-label="Symbol name"]','welcome')
                client.element_command(client.find('.rename-dialog button[type=submit]'),'/click')
                smoke.wait_for(client,'document.querySelector(".status-message")?.textContent.includes("Renamed symbol in 2 files")','cross-file symbol rename')
                smoke.require('greet' in main.read_text(),'Rename wrote to disk without Save')
                client.screenshot(output/'typescript.png')
                smoke.replace_editor_text(client,smoke.active_editor(client),'const person = {name: "Ada", age: 1};\nperson')
                client.element_command(smoke.active_editor(client), '/value', {'text':'.na','value':['.','n','a']})
                smoke.wait_for(client, 'document.querySelector(".cm-tooltip-autocomplete")?.textContent.includes("name")', 'TypeScript completion')
                client.send_keys(smoke.active_editor(client), '\ue015\ue007')
                smoke.wait_for(client,'document.querySelector(".editor-tab-host:not([hidden]) .cm-content")?.textContent.includes("person.name")','accepted TypeScript completion')
                open_file(component);ready('svelte-language-server');diagnostics();command(client,'Format document')
                smoke.wait_for(client,'document.querySelector(".status-message")?.textContent.includes("formatted")','Svelte formatting')
                client.screenshot(output/'svelte.png')
                open_file(rustfile);ready('rust-analyzer');diagnostics();command(client,'Format document')
                smoke.wait_for(client,'document.querySelector(".status-message")?.textContent.includes("formatted")','Rust formatting')
                client.screenshot(output/'rust.png')
                smoke.require(not (root/'project-typescript-executed').exists(), 'Project TypeScript executed')
                smoke.require(not (root/'svelte-config-executed').exists(), 'Svelte project config executed')
                smoke.require(not (root/'prettier-config-executed').exists(), 'Prettier project config executed')
                servers=invoke(client,'lsp_status',{})
                (output/'servers.json').write_text(json.dumps(servers,indent=2))
                smoke.require(len([s for s in servers if s['running']])==3,'Expected one server per root/kind')
                # Existing-file guard is checked through the packaged command.
                original=rustfile.read_text();rustfile.write_text('external change\n')
                result=client.execute_async('const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke("write_document_checked",{path:arguments[0],content:"overwrite",expectedContent:arguments[1]}).then(()=>done("unexpected success"),error=>done(String(error)))',[str(rustfile),original])
                smoke.require('changed on disk' in result,'Stale save was not rejected: '+str(result))
                smoke.require(rustfile.read_text()=='external change\n','External change was overwritten')
                process_rows = subprocess.check_output(['ps','-eo','pid=,ppid=,rss=,comm='],text=True).splitlines()
                process_map = {int(parts[0]): {'pid':int(parts[0]),'ppid':int(parts[1]),'rssKiB':int(parts[2]),'name':parts[3]} for row in process_rows if len(parts:=row.split(None,3))==4}
                selected=set(owners(root/'data'))
                for _ in range(10):
                    selected.update(pid for pid,row in process_map.items() if row['ppid'] in selected)
                (output/'process-baseline.json').write_text(json.dumps([process_map[pid] for pid in sorted(selected) if pid in process_map],indent=2))
                open_file(component); command(client,'Save'); command(client,'Close tab')
                deadline=time.time()+8
                while time.time()<deadline and len([item for item in invoke(client,'lsp_status',{}) if item['running']])!=2: time.sleep(.1)
                smoke.require(len([item for item in invoke(client,'lsp_status',{}) if item['running']])==2,'Last document did not release its Svelte server')
                client.execute("setTimeout(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'}),50);return true")
                time.sleep(2)
                print('PASS: packaged TS/Svelte/Rust startup, diagnostics, format, definitions/references, cross-file unsaved rename, shared sessions, guarded save',flush=True)
            except Exception:
                try:
                    (output/'lsp-messages.json').write_text(json.dumps(client.execute('return window.lspMessages'),indent=2))
                    client.screenshot(output/'failure.png')
                    (output/'failure.txt').write_text(client.execute('return document.body.innerText'))
                    (output/'failure-servers.json').write_text(json.dumps(invoke(client,'lsp_status',{}),indent=2))
                except Exception: pass
                raise
            finally:
                if client.session_id:
                    try:client.quit()
                    except smoke.WebDriverError:pass
                stop_profile_apps(root/'data')
                if driver and driver.poll() is None:
                    os.killpg(driver.pid,signal.SIGTERM)
                    try:driver.wait(timeout=5)
                    except subprocess.TimeoutExpired:os.killpg(driver.pid,signal.SIGKILL);driver.wait(timeout=5)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--app',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args();run(args.app.resolve(),args.output.resolve())
