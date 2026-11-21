<script lang="ts">
  import { scrimExit } from './motion';
  import { onMount } from 'svelte';
  let { mode, files, label, read, open, close }: { mode:'files'|'search'; files:string[]; label:(path:string)=>string; read:(path:string)=>Promise<string>; open:(path:string,line?:number)=>Promise<void>; close:()=>void } = $props();
  let query=$state(''), results=$state<{path:string;line?:number;text?:string}[]>([]), pending=$state(false), error=$state('');
  let dialog:HTMLDialogElement, input:HTMLInputElement;
  let serial=0;
  let matches=$derived(mode==='files' ? files.filter(path=>(label(path)+' '+path).toLowerCase().includes(query.toLowerCase())).slice(0,100).map(path=>({path,line:undefined,text:undefined})) : results);
  async function search() {
    const ticket=++serial, term=query;
    results=[];error='';if(!term)return;
    pending=true;
    let bytes=0, skipped=0; const found:typeof results=[];
    try {
      for(const path of files.slice(0,500)) {
        if(ticket!==serial)return;
        try {
          const content=await read(path); bytes+=content.length;
          if(bytes>16*1024*1024){error='Search reached the 16 MiB limit. Narrow your workspace.';break;}
          const lines=content.split(/\r?\n/u);
          for(let i=0;i<lines.length && found.length<200;i++)if(lines[i].toLowerCase().includes(term.toLowerCase()))found.push({path,line:i+1,text:lines[i].trim().slice(0,250)});
          if(found.length>=200){error='Showing the first 200 matches.';break;}
        }catch{skipped++;}
      }
      if(ticket===serial){results=found;if(skipped)error+=` ${skipped} unreadable files skipped.`;if(files.length>500)error+=' Only the first 500 files were searched.';}
    }finally{if(ticket===serial)pending=false;}
  }
  async function choose(path:string,line?:number){serial++;close();await open(path,line);}
  onMount(()=>{dialog.showModal();input.focus();return()=>{serial++;dialog.close();};});
</script>
<dialog class="file-navigator" use:scrimExit aria-label={mode==='files'?'Go to file':'Search workspace files'} bind:this={dialog} oncancel={(event)=>{event.preventDefault();close();}}>
  <form onsubmit={(event)=>{event.preventDefault();if(mode==='search')void search();else if(matches[0])void choose(matches[0].path);}}>
    <div class="navigator-heading"><strong>{mode==='files'?'Go to file':'Search workspace files'}</strong><button type="button" aria-label="Close file navigator" onclick={close}>×</button></div>
    <p>Open tabs and files referenced by this workspace.</p>
    <div class="navigator-query"><input aria-label={mode==='files'?'File name':'Search text'} bind:this={input} bind:value={query} placeholder={mode==='files'?'Type a filename…':'Find text…'} oninput={()=>{if(mode==='search'){serial++;results=[];pending=false;}}} />{#if mode==='search'}<button disabled={pending} type="submit">{pending?'Searching…':'Search'}</button>{/if}</div>
    {#if error}<p role="status">{error}</p>{/if}
    <div class="navigator-results">{#each matches as match}<button type="button" onclick={()=>void choose(match.path,match.line)}><strong>{label(match.path)}{match.line ? ':'+match.line : ''}</strong><small>{match.path}</small>{#if match.text}<code>{match.text}</code>{/if}</button>{:else}<p>{pending?'Searching…':'No matches'}</p>{/each}</div>
  </form>
</dialog>
