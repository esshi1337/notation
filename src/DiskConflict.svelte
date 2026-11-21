<script lang="ts">
  import { scrimExit } from './motion';
  import { onMount } from 'svelte';
  import { compareRevisions } from './revision-diff';
  let { path,content,read,reload,close }: {path:string;content:string;read:(path:string)=>Promise<string>;reload:(content:string)=>void;close:()=>void}=$props();
  let disk=$state<string|null>(null),error=$state(''),confirm=$state(false);
  let dialog:HTMLDialogElement;
  let diff=$derived(disk===null ? null : compareRevisions(disk,content,'On disk','Your buffer'));
  onMount(()=>{let disposed=false;dialog.showModal();void read(path).then(value=>{if(!disposed)disk=value;}).catch(cause=>{if(!disposed)error=String(cause);});return()=>{disposed=true;dialog.close();};});
</script>
<dialog class="disk-dialog" use:scrimExit aria-label="File changed on disk" bind:this={dialog} oncancel={(event)=>{event.preventDefault();close();}}>
  <div class="navigator-heading"><strong>File changed on disk</strong><button aria-label="Close comparison" onclick={close}>×</button></div>
  <p>{path}</p><p>Your buffer is preserved until you choose to reload. Use Save As to keep a separate copy.</p>
  {#if error}<p role="alert">{error}</p>{:else if diff}<pre>{diff.error ?? (diff.unchanged ? 'The buffer and disk file match.' : diff.text)}</pre>{:else}<p>Reading file…</p>{/if}
  {#if confirm}<p role="alert">Reload replaces your current buffer with the disk contents shown above.</p>{/if}
  <div class="dialog-actions"><button onclick={close}>Keep editing</button><button disabled={disk===null} onclick={()=>{if(!confirm)confirm=true;else if(disk!==null)reload(disk);}}>{confirm?'Replace buffer':'Reload from disk'}</button></div>
</dialog>
