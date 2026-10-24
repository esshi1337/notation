#!/usr/bin/env python3
"""Verify packaged Svelte completion/formatting bypass executable project config."""
import argparse
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import tempfile
import time


def run(resources):
    for configuration in ['javascript', 'plugin']:
        with tempfile.TemporaryDirectory(prefix='nt-lsp-trust-') as temporary:
            root=Path(temporary);marker=root/'executed';component=root/'App.svelte'
            source='<script lang="ts">let person=$state({name:"Ada"});person.name;</script><p>{person.name}</p>'
            component.write_text(source)
            (root/'package.json').write_text('{"type":"module"}')
            payload='import fs from "node:fs"; fs.writeFileSync('+json.dumps(str(marker))+', "executed"); export default {};'
            if configuration=='javascript': (root/'prettier.config.js').write_text(payload)
            else:
                (root/'plugin.mjs').write_text(payload)
                (root/'.prettierrc.json').write_text(json.dumps({'plugins':['./plugin.mjs']}))
            with (root/'stderr.log').open('wb') as log:
                process=subprocess.Popen([str(resources/'node'),str(resources/'node_modules/svelte-language-server/bin/server.js'),'--stdio'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,start_new_session=True)
                buffer=b''
                def send(message):
                    data=json.dumps({'jsonrpc':'2.0',**message}).encode()
                    process.stdin.write(f'Content-Length: {len(data)}\r\n\r\n'.encode()+data);process.stdin.flush()
                def response(request):
                    nonlocal buffer
                    deadline=time.monotonic()+30
                    while time.monotonic()<deadline:
                        split=buffer.find(b'\r\n\r\n')
                        if split>=0:
                            length=int(next(line.split(b':',1)[1] for line in buffer[:split].split(b'\r\n') if line.lower().startswith(b'content-length:')))
                            if len(buffer)>=split+4+length:
                                value=json.loads(buffer[split+4:split+4+length]);buffer=buffer[split+4+length:]
                                if value.get('id')==request and 'method' not in value:
                                    assert 'error' not in value,value
                                    return value.get('result')
                                if 'method' in value and 'id' in value:send({'id':value['id'],'result':None})
                                continue
                        if select.select([process.stdout],[],[],1)[0]:
                            chunk=os.read(process.stdout.fileno(),65536)
                            if not chunk:raise AssertionError('Svelte server exited: '+(root/'stderr.log').read_text())
                            buffer+=chunk
                    raise AssertionError('Svelte request timed out')
                try:
                    send({'id':1,'method':'initialize','params':{'processId':None,'rootUri':root.as_uri(),'capabilities':{},'initializationOptions':{'isTrusted':False}}});response(1)
                    send({'method':'initialized','params':{}})
                    send({'method':'textDocument/didOpen','params':{'textDocument':{'uri':component.as_uri(),'languageId':'svelte','version':1,'text':source}}})
                    send({'id':2,'method':'textDocument/completion','params':{'textDocument':{'uri':component.as_uri()},'position':{'line':0,'character':source.index('person.name')+len('person.')},'context':{'triggerKind':1}}})
                    completion=response(2)
                    assert completion and (completion if isinstance(completion,list) else completion.get('items')),completion
                    assert not marker.exists(),'Completion executed '+configuration
                    send({'id':3,'method':'textDocument/formatting','params':{'textDocument':{'uri':component.as_uri()},'options':{'tabSize':2,'insertSpaces':True}}})
                    assert response(3),'Formatter returned no edits'
                    assert not marker.exists(),'Formatting executed '+configuration
                    print('PASS: Svelte completion and formatting ignore project Prettier '+configuration,flush=True)
                finally:
                    os.killpg(process.pid,signal.SIGTERM)
                    try:process.wait(timeout=3)
                    except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait()

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--resources',type=Path,default=Path('src-tauri/resources/language-servers'));args=parser.parse_args();run(args.resources.resolve())
