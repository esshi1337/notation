import { invoke, isTauri } from '@tauri-apps/api/core';
import { safeSVG } from './safe-svg';
let queue:Promise<void>=Promise.resolve();
const cache=new Map<string,string>();
async function graphviz(source:string,dark:boolean):Promise<string>{
  const worker=new Worker(new URL('./diagram-worker.ts',import.meta.url),{type:'module'});
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{worker.terminate();reject(new Error('Diagram timed out after 15 seconds.'));},15000);
    const finish=()=>{clearTimeout(timer);worker.terminate();};
    worker.onmessage=event=>{finish();if(event.data.error)reject(new Error(event.data.error));else resolve(event.data.svg);};worker.onerror=event=>{finish();reject(new Error(event.message||'Graphviz worker failed.'));};worker.postMessage({source,dark});
  });
}
export async function advancedSVG(engine:string,source:string,dark:boolean):Promise<string>{
  if(source.length>128*1024)throw new Error('Diagram source exceeds 128 KiB.');
  const key=engine+'\0'+dark+'\0'+source,cached=cache.get(key);if(cached)return cached;
  let svg:string;
  if(engine==='dot')svg=await graphviz(source,dark);
  else {if(!isTauri())throw new Error(engine+' uses the bundled desktop renderer.');svg=await invoke<string>('render_diagram',{engine,source});}
  if(svg.length>4*1024*1024)throw new Error('Rendered diagram exceeds 4 MiB.');
  if(cache.size>=16)cache.delete(cache.keys().next().value!);cache.set(key,svg);return svg;
}
export async function renderAdvancedInto(target:HTMLElement,engine:string,source:string,dark:boolean,current:()=>boolean){
  target.setAttribute('aria-busy','true');
  const run=queue.catch(()=>{}).then(async()=>{
    if(!current())return;
    try{
      const svg=await advancedSVG(engine,source,dark);if(!current())return;
      target.replaceChildren(safeSVG(svg));
    }catch(error){if(current()){target.textContent=engine+' error: '+(error instanceof Error?error.message:String(error));target.setAttribute('role','alert');}}
    finally{if(current())target.setAttribute('aria-busy','false');}
  });queue=run;await run;
}
