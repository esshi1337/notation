<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { open } from '@tauri-apps/plugin-dialog';
  import { currentMetadata, metadataSummary, nativeStore } from './store';
  import type { SearchRequest, QueryResult } from './database-query';
  import type { Recent } from './store';

  type Note = { path: string; name: string; title: string; snippet: string; score: number };
  type Task = { path: string; line: number; text: string; checked: boolean };
  type Tag = { tag: string; count: number };
  type Backlink = { path: string; line: number; text: string };
  let { currentPath, openDocument, close }: { currentPath: string | null; openDocument: (path: string, line?: number) => Promise<boolean>; close: () => void } = $props();
  let folder = $state(currentMetadata().workspace || '');
  let workspace = $state(currentMetadata().workspace);
  let recents = $state<Recent[]>(currentMetadata().recents);
  let tab = $state<'Notes' | 'Tasks' | 'Tags' | 'Backlinks'>('Notes');
  let query = $state('');
  let filterFolder = $state(''), filterTags = $state(''), filterKey = $state(''), filterOp = $state('eq'), filterValue = $state(''), filterSort = $state('relevance'), filterDescending = $state(false), total = $state<number|null>(null);
  const filterState = $derived({ folder: filterFolder, tags: filterTags, key: filterKey, op: filterOp, value: filterValue, sort: filterSort, descending: filterDescending });
  let notes = $state<Note[]>([]);
  let tasks = $state<Task[]>([]);
  let tags = $state<Tag[]>([]);
  let backlinks = $state<Backlink[]>([]);
  let busy = $state(false);
  let message = $state(currentMetadata().workspace ? 'Workspace ready' : 'Choose a folder to index Markdown notes.');
  let error = $state('');
  let indexErrors = $state<string[]>([]);
  let serial = 0;

  async function load(term: string, mode: typeof tab, selected: string | null, ticket: number, filters = filterState) {
    if (!nativeStore || !workspace) return;
    try {
      if (mode === 'Notes') {
        const advanced = filters.folder || filters.tags || filters.key || filters.sort !== 'relevance' || filters.descending;
        if (advanced) {
          let value: unknown = filters.value; try { value = JSON.parse(filters.value); } catch { /* Unquoted text is a string. */ }
          const request: SearchRequest = { text: term, folder: filters.folder || undefined, tags: filters.tags.split(',').map(tag=>tag.trim()).filter(Boolean), tagMode: 'all', limit:50, descending:filters.descending };
          if (filters.key) request.properties=[{key:filters.key,op:filters.op as 'eq',...(filters.op==='exists'?{}:{value})}];
          if (['relevance','title','path'].includes(filters.sort)) request.sort=filters.sort as 'title'; else request.sortProperty=filters.sort;
          const result=await invoke<QueryResult>('search_workspace_advanced',{request}); if(ticket===serial){notes=result.results.map(note=>({...note,snippet:note.snippet??'',score:0}));total=result.total;error='';}
        } else { const result = await invoke<Note[]>('search_workspace', { query: term, limit: 50 }); if (ticket === serial) { notes = result; total=null; error=''; } }
      }
      else if (mode === 'Tasks') { const result = await invoke<Task[]>('get_tasks', { checked: null }); if (ticket === serial) tasks = result; }
      else if (mode === 'Tags') { const result = await invoke<Tag[]>('get_tags'); if (ticket === serial) tags = result; }
      else if (selected) { const result = await invoke<Backlink[]>('get_backlinks', { path: selected }); if (ticket === serial) backlinks = result; }
      else backlinks = [];
    } catch (cause) { if (ticket === serial) { notes=[]; error = 'Could not read workspace index: ' + String(cause); } }
  }
  $effect(() => {
    const term = query, mode = tab, selected = currentPath, selectedWorkspace = workspace, filters = filterState;
    const ticket = ++serial;
    const timer = setTimeout(() => { if (selectedWorkspace) void load(term, mode, selected, ticket, filters); }, 180);
    return () => clearTimeout(timer);
  });
  async function browse() {
    try { const selected = await open({ directory: true, multiple: false, title: 'Choose workspace folder' }); if (typeof selected === 'string') folder = selected; }
    catch (cause) { error = 'Could not choose folder: ' + String(cause); }
  }
  async function refresh() {
    if (!nativeStore || !workspace) return;
    busy = true; error = ''; indexErrors = []; message = 'Indexing Markdown files…';
    try {
      const result = await invoke<{ files: number; indexed: number; skipped: number; errors: string[] }>('index_workspace');
      indexErrors = result.errors;
      message = result.files + ' files · ' + result.indexed + ' indexed · ' + result.skipped + ' skipped';
      await load(query, tab, currentPath, ++serial);
    } catch (cause) { error = 'Could not refresh index. Check the folder path and permissions. ' + String(cause); }
    finally { busy = false; }
  }
  async function openWorkspace() {
    if (!nativeStore || !folder.trim()) return;
    busy = true; error = '';
    try { const result = await invoke<{ path: string }>('set_workspace', { path: folder.trim() }); workspace = result.path; folder = result.path; currentMetadata().workspace = result.path; await refresh(); }
    catch (cause) { error = 'Could not open workspace: ' + String(cause); }
    finally { busy = false; }
  }
  async function openNote(path: string, line?: number) {
    if (await openDocument(path, line)) {
      try { recents = (await metadataSummary()).recents; } catch { /* Existing recents remain usable. */ }
    }
  }
  onMount(() => {
    if (nativeStore) void metadataSummary().then((value) => { recents = value.recents; }).catch((cause: unknown) => error = 'Could not load recent files: ' + String(cause));
  });
</script>

<section class="utility-panel workspace-panel" aria-label="Workspace">
  <div class="scripts-heading"><strong>Workspace</strong><button aria-label="Close workspace" onclick={close}>×</button></div>
  {#if !nativeStore}<p class="panel-note">Workspace files and indexing require the desktop app. Notes remain plain Markdown files.</p>{/if}
  <label>Workspace folder<input aria-label="Workspace folder" bind:value={folder} placeholder="Choose a folder" spellcheck="false" /></label>
  <div class="panel-actions"><button onclick={browse} disabled={!nativeStore || busy}>Browse workspace</button><button onclick={openWorkspace} disabled={!nativeStore || busy || !folder.trim()}>Open workspace</button><button onclick={refresh} disabled={!nativeStore || busy || !workspace}>Refresh index</button></div>
  <div class="panel-status" role="status">{message}</div>
  {#if error}<div class="script-error" role="alert">{error}</div>{/if}
  {#if indexErrors.length}<div class="script-error" role="alert">Some files could not be indexed:<ul>{#each indexErrors as item}<li>{item}</li>{/each}</ul></div>{/if}
  <div class="panel-tabs" role="group" aria-label="Workspace views">{#each ['Notes', 'Tasks', 'Tags', 'Backlinks'] as item}<button aria-pressed={tab === item} onclick={() => tab = item as typeof tab}>{item}</button>{/each}</div>
  {#if tab === 'Notes'}
  <label>Search notes<input aria-label="Search notes" bind:value={query} disabled={!nativeStore || !workspace} placeholder="Text, title, or #tag" /></label>
  <details class="search-filters"><summary>Search filters</summary>
    <label>Folder<input aria-label="Search folder filter" bind:value={filterFolder} placeholder="Relative workspace folder" /></label>
    <label>Tags<input aria-label="Search tags filter" bind:value={filterTags} placeholder="work, planning (all)" /></label>
    <label>Property<input aria-label="Search property key" bind:value={filterKey} placeholder="status" /></label>
    <label>Condition<select aria-label="Search property operator" bind:value={filterOp}>{#each ['eq','ne','gt','gte','lt','lte','contains','exists'] as op}<option value={op}>{{eq:'Equals',ne:'Does not equal',gt:'Greater than',gte:'At least',lt:'Less than',lte:'At most',contains:'Contains',exists:'Exists'}[op]}</option>{/each}</select></label>
    {#if filterOp!=='exists'}<label>Value<input aria-label="Search property value" bind:value={filterValue} placeholder="Text, number, true/false, or JSON" /></label>{/if}
    <label>Sort<input aria-label="Search sort" bind:value={filterSort} placeholder="relevance, title, path, or property" /></label>
    <label class="search-descending"><input type="checkbox" aria-label="Search descending" bind:checked={filterDescending} /> Descending</label>
    <button onclick={()=>{filterFolder='';filterTags='';filterKey='';filterOp='eq';filterValue='';filterSort='relevance';filterDescending=false;}}>Clear search filters</button>
  </details>
  {/if}
  <div class="workspace-results" aria-live="polite">
    {#if tab === 'Notes'}
      {#if total!==null}<p class="panel-note" role="status">{notes.length} of {total} matching notes</p>{/if}
      {#each notes as note}<button class="note-result" aria-label={'Open note: ' + note.name} onclick={() => openNote(note.path)}><strong>{note.title || note.name}</strong><span class="result-path">{note.path}</span><span>{note.snippet}</span></button>{/each}
      {#if nativeStore && workspace && !notes.length}<p class="panel-note">No matching notes. Refresh the index after changing files.</p>{/if}
    {:else if tab === 'Tasks'}
      {#each tasks as task}<button class="note-result" aria-label={'Task: ' + task.text} onclick={() => openNote(task.path, task.line)}><strong>{task.checked ? '☑' : '☐'} {task.text}</strong><span class="result-path">{task.path}:{task.line}</span></button>{/each}
      {#if !tasks.length}<p class="panel-note">No indexed tasks.</p>{/if}
    {:else if tab === 'Tags'}
      {#each tags as tag}<button class="tag-result" aria-label={'Tag: ' + (tag.tag.startsWith('#') ? tag.tag : '#' + tag.tag)} onclick={() => { query = tag.tag.startsWith('#') ? tag.tag : '#' + tag.tag; tab = 'Notes'; }}>{tag.tag.startsWith('#') ? tag.tag : '#' + tag.tag}<span>{tag.count}</span></button>{/each}
      {#if !tags.length}<p class="panel-note">No indexed tags.</p>{/if}
    {:else}
      {#each backlinks as link}<button class="note-result" aria-label={'Open backlink: ' + link.path} onclick={() => openNote(link.path, link.line)}><strong>{link.text}</strong><span class="result-path">{link.path}:{link.line}</span></button>{/each}
      {#if !currentPath}<p class="panel-note">Open a file to see its backlinks.</p>{:else if !backlinks.length}<p class="panel-note">No indexed backlinks to this file.</p>{/if}
    {/if}
  </div>
  {#if recents.length}<div class="recent-files"><h3>Recent files</h3>{#each recents.slice(0, 8) as recent}<button aria-label={'Recent: ' + (recent.name || recent.path.split('/').pop())} onclick={() => openNote(recent.path)}>{recent.name || recent.path.split('/').pop()}<span class="result-path">{recent.path}</span></button>{/each}</div>{/if}
</section>

<style>
  .workspace-panel .panel-tabs { flex-wrap: wrap; }
  .search-filters { margin: 0; }
  .search-filters summary { cursor: pointer; color: var(--muted); padding: 3px 0; }
  .search-filters label { display: grid; gap: 5px; margin-top: 10px; color: var(--muted); }
  .search-filters .search-descending { display: flex; flex-direction: row; align-items: center; gap: 7px; margin: 12px 0; }
  .search-descending input { flex: 0 0 12px; width: 12px; height: 12px; padding: 0; }
</style>
