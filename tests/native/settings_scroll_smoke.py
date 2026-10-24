#!/usr/bin/env python3
"""Packaged Settings geometry, scroll containment, toggle and frame diagnostics."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import smoke
from settings_controls import segment
from responsive_smoke import command
from media_graph_smoke import stop_profile_apps


def run(app):
    smoke.assert_ports_available()
    output = Path(__file__).resolve().parents[2] / 'test-results/native-settings-scroll'
    output.mkdir(parents=True, exist_ok=True)
    client = smoke.Client(smoke.BASE_URL)
    driver = None
    with tempfile.TemporaryDirectory(prefix='notation-settings-scroll-') as temporary:
        root = Path(temporary)
        env = {**os.environ, 'TAURI_WEBVIEW_AUTOMATION': 'true'}
        for key, name in [('XDG_DATA_HOME','data'),('XDG_CONFIG_HOME','config'),('XDG_CACHE_HOME','cache')]:
            folder = root / name
            folder.mkdir()
            env[key] = str(folder)
        with (output / 'driver.log').open('wb') as log:
            try:
                driver = subprocess.Popen([str(smoke.DRIVER),'--port',str(smoke.DRIVER_PORT),'--native-port',str(smoke.NATIVE_PORT),'--native-driver',str(smoke.WEBDRIVER)],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                smoke.wait_for_driver(driver,output/'driver.log')
                client.create_session(app)
                smoke.wait_for(client,"document.querySelector('main.app')",'packaged app')
                command(client,'Settings')
                segment(client, 'Density', 'Comfortable')
                baseline = client.execute("return document.querySelector('.settings-dialog').getBoundingClientRect().toJSON()")
                for section in ['Shortcuts','Agents','Editor','Appearance','Shortcuts']:
                    client.element_command(client.find('[data-section="'+section+'"]'),'/click')
                    smoke.wait_for(client,"document.querySelector('.settings-content').getAttribute('aria-label') === "+json.dumps(section),'section '+section)
                    box = client.execute("return document.querySelector('.settings-dialog').getBoundingClientRect().toJSON()")
                    smoke.require(all(abs(box[k]-baseline[k])<=1 for k in ['x','y','width','height']),f'{section} moved Settings: {baseline} -> {box}')
                close_shape = client.execute("const e=document.querySelector('[aria-label=\"Close settings\"]'),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {width:r.width,height:r.height,radius:s.borderRadius,border:s.borderTopWidth}")
                smoke.require(close_shape['width']==close_shape['height'] and close_shape['width']>=24 and 0 < float(close_shape['radius'].removesuffix('px')) < close_shape['width']/2 and close_shape['border']=='1px',f'Close is not a squircle: {close_shape}')
                before = client.execute("return {page:document.documentElement.scrollTop,preview:document.querySelector('.preview-scroll')?.scrollTop||0,header:document.querySelector('.settings-heading').getBoundingClientRect().top}")
                idle = client.execute_async("""
const done=arguments[arguments.length-1],gaps=[];let last=performance.now();
function step(now){gaps.push(now-last);last=now;if(gaps.length<60){requestAnimationFrame(step);return;}
 const sorted=gaps.slice(1).sort((a,b)=>a-b);done({medianMs:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:sorted.at(-1)});}
requestAnimationFrame(step);
""")
                frames = client.execute_async("""
const done=arguments[arguments.length-1],list=document.querySelector('.shortcut-list');
list.scrollTop=0;const gaps=[];let last=performance.now(),frame=0,consumed=0;
function step(now){gaps.push(now-last);last=now;
 if(frame<36 && frame%4===0){const e=new WheelEvent('wheel',{deltaY:80,bubbles:true,cancelable:true});list.dispatchEvent(e);if(e.defaultPrevented)consumed++;}
 if(++frame<60){requestAnimationFrame(step);return;}
 const sorted=gaps.slice(1).sort((a,b)=>a-b);done({frames:sorted.length,medianMs:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:sorted.at(-1),consumed,scrollTop:list.scrollTop,maxScroll:list.scrollHeight-list.clientHeight});}
requestAnimationFrame(step);
""")
                smoke.require(frames['consumed']>0 and frames['scrollTop']>0,'Smooth wheel did not move shortcuts: '+str(frames))
                after = client.execute("return {page:document.documentElement.scrollTop,preview:document.querySelector('.preview-scroll')?.scrollTop||0,header:document.querySelector('.settings-heading').getBoundingClientRect().top}")
                smoke.require(before==after,f'Scrolling list moved underlying UI: {before} -> {after}')
                small_wheel = client.execute_async("""
const done=arguments[arguments.length-1],list=document.querySelector('.shortcut-list');list.scrollTop=0;
const input=list.querySelector('input'),event=new WheelEvent('wheel',{deltaY:15.8,bubbles:true,cancelable:true});
input.dispatchEvent(event);const initial=list.scrollTop;
setTimeout(()=>done({consumed:event.defaultPrevented,initial,settled:list.scrollTop}),250);
""")
                smoke.require(small_wheel['consumed'] and small_wheel['initial']==0 and abs(small_wheel['settled']-15.8)<=1,'Small wheel over shortcut input bypassed smoothing: '+str(small_wheel))
                client.screenshot(output/'shortcuts.png')
                client.element_command(client.find('[data-section="Editor"]'),'/click')
                checkboxes = client.execute("""
return [...document.querySelectorAll('.settings-checkbox')].map(label=>{
 const input=label.querySelector('input'),mark=label.querySelector('.settings-checkbox-mark'),box=mark.getBoundingClientRect(),hit=input.getBoundingClientRect();
 return {checked:input.checked,width:box.width,height:box.height,aligned:Math.abs(box.y-hit.y)<1,checkVisible:getComputedStyle(mark.querySelector('svg')).visibility==='visible'};
});
""")
                smoke.require(all(c['width']==14 and c['height']==14 and c['aligned'] and c['checked']==c['checkVisible'] for c in checkboxes),'Settings checkbox geometry/mark mismatch: '+str(checkboxes))
                toggle = client.find('//label[contains(normalize-space(.),"Smooth scrolling")]/input',using='xpath')
                client.element_command(toggle,'/click')
                smoke.wait_for(client,"!document.evaluate('//label[contains(normalize-space(.),\"Smooth scrolling\")]/input',document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue.checked",'smooth scrolling disabled')
                client.element_command(client.find('[aria-label="Close settings"]'),'/click')
                smoke.wait_for(client,"document.querySelector('.database-state')?.dataset.state === 'saved'",'preference persisted')
                command(client,'Settings')
                client.element_command(client.find('[data-section="Editor"]'),'/click')
                smoke.require(client.execute("return !document.evaluate('//label[contains(normalize-space(.),\"Smooth scrolling\")]/input',document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue.checked"),'Disabled preference lost')
                client.execute_async("const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));")
                client.screenshot(output/'editor.png')
                client.element_command(client.find('[data-section="Shortcuts"]'),'/click')
                consumed = client.execute("const list=document.querySelector('.shortcut-list');list.scrollTop=0;const e=new WheelEvent('wheel',{deltaY:80,bubbles:true,cancelable:true});list.dispatchEvent(e);return e.defaultPrevented")
                smoke.require(not consumed,'Disabled smoothing still intercepted wheel input')
                errors = client.execute("return [...document.querySelectorAll('.settings-dialog [role=alert]')].map(e=>e.textContent)")
                smoke.require(not errors,str(errors))
                report={'dialog':baseline,'close':close_shape,'idleFrames':idle,'scrollFrames':frames,'backgroundUnchanged':before==after,'disabledUsesNativeWheel':not consumed,'smallWheel':small_wheel,'checkboxes':checkboxes}
                (output/'metrics.json').write_text(json.dumps(report,indent=2))
                print('PASS: stable Settings sections, squircle close, contained scrolling, persisted toggle; frame timings '+json.dumps({'idle':idle,'scroll':frames}),flush=True)
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
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app',type=Path,required=True)
    run(parser.parse_args().app.resolve())
