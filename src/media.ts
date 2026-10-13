import { invoke, isTauri } from '@tauri-apps/api/core';
import { mediaKind } from './media-path';
import type { MediaKind } from './media-path';
export function prepareMedia(html:string):string{
  const template=document.createElement('template');template.innerHTML=html;
  for(const element of template.content.querySelectorAll('[style]'))element.removeAttribute('style');
  for(const element of template.content.querySelectorAll('script,style,link,meta,iframe,object,embed'))element.remove();
  for(const element of template.content.querySelectorAll<HTMLImageElement|HTMLMediaElement>('img,audio,video')){
    const src=element.getAttribute('src')||element.querySelector('source')?.getAttribute('src');if(!src)continue;
    const placeholder=document.createElement('span');placeholder.className='media-embed';placeholder.dataset.mediaSource=src;
    placeholder.dataset.mediaKind=element.getAttribute('data-media-kind')||(element.tagName==='AUDIO'?'audio':element.tagName==='VIDEO'?'video':mediaKind(src)||'image');
    placeholder.dataset.mediaAlt=element.getAttribute('alt')||element.getAttribute('title')||src;placeholder.textContent=placeholder.dataset.mediaAlt;element.replaceWith(placeholder);
  }
  for(const element of template.content.querySelectorAll('[src],[srcset],[poster],[background],[ping]'))for(const attribute of ['src','srcset','poster','background','ping'])element.removeAttribute(attribute);
  return template.innerHTML;
}
export async function loadLocalMedia(source:string,sourcePath?:string):Promise<{dataUrl:string;mime:string}>{
  if(/^data:(?:image|audio|video)\/|^data:application\/pdf/iu.test(source)){if(source.length>28*1024*1024)throw new Error('Media exceeds 20 MiB.');return{dataUrl:source,mime:source.slice(5,source.indexOf(';'))};}
  if(/^[a-z][a-z0-9+.-]*:|^\/\//iu.test(source))throw new Error('This resource is not a local media file.');
  if(!isTauri())throw new Error('Local media requires a desktop workspace.');
  let path=source.split(/[?#]/u)[0];try{path=decodeURIComponent(path);}catch{/* Keep literal malformed escapes. */}
  return invoke('read_workspace_asset',{path,sourcePath:sourcePath?.startsWith('/')?sourcePath:undefined});
}
export async function renderMedia(target:HTMLElement,sourcePath:string|undefined,current:()=>boolean):Promise<()=>void>{
  const source=target.dataset.mediaSource??'',kind=(target.dataset.mediaKind??'image') as MediaKind,alt=target.dataset.mediaAlt??source;
  const remote=/^(?:https?:)?\/\//iu.test(source);let disposed=false,cleanup=()=>{},loading=false;
  const valid=()=>!disposed&&current();
  target.setAttribute('role','region');target.setAttribute('aria-label','Media: '+alt);
  const load=async()=>{
    if(loading||!valid())return;loading=true;target.textContent='Loading '+alt+'…';
    try{
      const url=remote?new URL(source.startsWith('//')?'https:'+source:source,location.href).href:(await loadLocalMedia(source,sourcePath)).dataUrl;
      if(!valid())return;
      if(kind==='pdf'){
        const pdfjs=await import('pdfjs-dist');const worker=await import('pdfjs-dist/build/pdf.worker.min.mjs?url');pdfjs.GlobalWorkerOptions.workerSrc=worker.default;
        if(!valid())return;
        const assets=new URL('pdfjs/',document.baseURI).href;
        const task=pdfjs.getDocument({...(remote?{url}:{data:Uint8Array.from(atob(url.slice(url.indexOf(',')+1)),char=>char.charCodeAt(0))}),enableXfa:false,cMapUrl:assets+'cmaps/',standardFontDataUrl:assets+'standard_fonts/',wasmUrl:assets+'wasm/',iccUrl:assets+'iccs/',useWorkerFetch:false});
        cleanup=()=>{void task.destroy();};const pdf=await task.promise;if(!valid()){cleanup();return;}
        const controls=document.createElement('div');controls.className='pdf-controls';const previous=document.createElement('button'),next=document.createElement('button'),label=document.createElement('span');previous.textContent='Previous page';next.textContent='Next page';
        const canvas=document.createElement('canvas');canvas.setAttribute('aria-label','PDF page');controls.append(previous,label,next);target.replaceChildren(controls,canvas);
        let pageNumber=Math.max(1,Math.min(pdf.numPages,Number(/#page=(\d+)/iu.exec(source)?.[1]??1))),rendering=false;
        const draw=async()=>{if(rendering||!valid())return;rendering=true;previous.disabled=next.disabled=true;try{const page=await pdf.getPage(pageNumber);if(!valid())return;const initial=page.getViewport({scale:1});const viewport=page.getViewport({scale:Math.min(1.5,900/initial.width,1800/initial.height)});canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);await page.render({canvas,viewport}).promise;label.textContent=`Page ${pageNumber} of ${pdf.numPages}`;}catch(error){if(valid())label.textContent='PDF error: '+String(error);}finally{rendering=false;previous.disabled=pageNumber===1;next.disabled=pageNumber===pdf.numPages;}};
        previous.onclick=event=>{event.stopPropagation();if(!rendering&&pageNumber>1){pageNumber--;void draw();}};next.onclick=event=>{event.stopPropagation();if(!rendering&&pageNumber<pdf.numPages){pageNumber++;void draw();}};await draw();
      }else if(kind==='image'){
        const image=document.createElement('img');image.alt=alt;image.dataset.originalSrc=source;image.referrerPolicy='no-referrer';image.src=url;image.onerror=()=>{if(valid())target.textContent='Could not load image: '+alt;};target.replaceChildren(image);
      }else if(kind==='audio'||kind==='video'){
        const media=document.createElement(kind);media.controls=true;media.preload='metadata';media.src=url;media.setAttribute('aria-label',alt);target.replaceChildren(media);cleanup=()=>{media.pause();media.removeAttribute('src');media.load();};
      }else{
        const frame=document.createElement('iframe');frame.title=alt;frame.sandbox.add('allow-scripts','allow-forms');frame.referrerPolicy='no-referrer';frame.src=url;target.replaceChildren(frame);const link=document.createElement('a');link.textContent='Open external resource';link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.onclick=event=>{if(isTauri()){event.preventDefault();void invoke('open_external',{url}).catch(error=>{if(valid()){const message=document.createElement('span');message.textContent=String(error);target.append(message);}});}};target.append(link);
      }
    }catch(error){if(valid()){target.textContent=error instanceof Error?error.message:String(error);target.setAttribute('role','alert');}}
    finally{loading=false;}
  };
  if(remote){const button=document.createElement('button');button.textContent='Load external media: '+alt;button.onclick=event=>{event.stopPropagation();void load();};target.replaceChildren(button);}
  else await load();
  return()=>{disposed=true;cleanup();};
}
