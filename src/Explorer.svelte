<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { nativeStore } from './store';
  import ExplorerNode from './ExplorerNode.svelte';
  import type { Entry } from './ExplorerNode.svelte';
  type Directory = { root: string; path: string; parent: string | null; entries: Entry[]; truncated: boolean };
  let { currentPath, openFile, configure, close }: { currentPath: string | null; openFile: (path: string) => void; configure: () => void; close: () => void } = $props();
  let entries = $state<Entry[]>([]), root = $state(''), error = $state(''), truncated = $state(false), busy = $state(false);
  let generation = $state(0);
  async function load(path: string): Promise<Entry[]> {
    try { const result = await invoke<Directory>('list_directory', { path }); if (result.truncated) truncated = true; return result.entries; }
    catch (cause) { error = 'Could not read folder: ' + String(cause); return []; }
  }
  async function refresh() {
    if (!nativeStore) return;
    busy = true; error = ''; truncated = false;
    try { const result = await invoke<Directory>('list_directory', { path: null }); entries = result.entries; root = result.root; truncated = result.truncated; generation++; }
    catch (cause) { error = 'Choose a workspace folder to browse its files. ' + String(cause); }
    finally { busy = false; }
  }
  onMount(() => { void refresh(); });
</script>
<section class="explorer-panel" aria-label="Explorer">
  <div class="scripts-heading"><strong>Explorer</strong><div><button aria-label="Refresh explorer" onclick={refresh} disabled={!nativeStore || busy}>↻</button><button aria-label="Close explorer" onclick={close}>×</button></div></div>
  {#if !nativeStore}<p class="panel-note">The directory explorer requires the desktop app. Use Open to import a browser document.</p>{/if}
  <button class="explorer-workspace" onclick={configure} title={root}>{root ? root.split('/').pop() : 'Choose workspace'}</button>
  {#if error}<div class="script-error" role="alert">{error}</div>{/if}
  {#if truncated}<p class="panel-note">Folder listing is limited. Open a more specific workspace for a smaller view.</p>{/if}
  <div class="explorer-tree" role="tree" aria-label="Workspace files">{#key generation}{#each entries as entry (entry.path)}<ExplorerNode {entry} {currentPath} {load} {openFile} />{/each}{/key}</div>
</section>
