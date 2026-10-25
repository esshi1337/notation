<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { ask } from '@tauri-apps/plugin-dialog';
  type Metadata = { id: string; title: string; updatedAt: number };
  let { close, createRequest = 0, created }: { close: () => void; createRequest?: number; created: () => void } = $props();
  const desktop = isTauri();
  let notes = $state<Metadata[]>([]), error = $state(''), busy = $state(false);
  let disposed = false, seen = 0;
  async function refresh() {
    const result = await invoke<Metadata[]>('list_sticky_notes');
    if (!disposed) notes = result;
  }
  async function action(operation: () => Promise<void>) {
    if (!desktop || busy || disposed) return;
    busy = true; error = '';
    try { await operation(); }
    catch (cause) { if (!disposed) error = String(cause); }
    finally { if (!disposed) busy = false; }
  }
  async function create() {
    await action(async () => {
      const note = await invoke<Metadata>('create_sticky_note');
      // Refresh first: a failed window build must still leave its saved row accessible.
      await refresh();
      if (!disposed) await invoke('open_sticky_note', { id: note.id });
    });
  }
  async function remove(note: Metadata) {
    await action(async () => {
      if (!await ask(`Delete “${note.title || 'Untitled sticky'}”? This cannot be undone.`, { title: 'Delete sticky note', kind: 'warning', okLabel: 'Delete', cancelLabel: 'Cancel' }) || disposed) return;
      await invoke('delete_sticky_note', { id: note.id });
      await refresh();
    });
  }
  onMount(() => { if (desktop && !createRequest) void action(refresh); return () => { disposed = true; }; });
  $effect(() => {
    if (createRequest > seen) { seen = createRequest; untrack(() => { created(); if (desktop) void create(); }); }
    if (!createRequest) seen = 0;
  });
</script>

<section class="utility-panel" aria-label="Sticky notes">
  <div class="scripts-heading"><strong>Sticky notes</strong><button aria-label="Close sticky notes" onclick={close}>×</button></div>
  <p class="panel-note">{desktop ? 'Independent always-on-top writing windows with bold, italic, bullets, and six paper colors. Closing a sticky keeps it saved. Close sticky windows before exiting Notation, or minimize Notation to keep them visible.' : 'Sticky notes require the desktop app: browsers cannot create independent always-on-top native windows.'}</p>
  <div class="panel-actions"><button disabled={!desktop || busy} onclick={create}>New sticky note</button><button disabled={!desktop || busy} onclick={() => action(refresh)}>Refresh notes</button></div>
  {#if error}<p role="alert" class="script-error">{error}</p>{/if}
  {#each notes as note (note.id)}
    <div class="sticky-row"><button disabled={busy} onclick={() => action(async () => { await invoke('open_sticky_note', { id: note.id }); })}>{note.title || 'Untitled sticky'}</button><button disabled={busy} aria-label={`Delete ${note.title || 'Untitled sticky'}`} onclick={() => remove(note)}>Delete</button></div>
  {/each}
  {#if desktop && !busy && !notes.length}<p class="panel-note">No saved sticky notes.</p>{/if}
  <p class="panel-note">Up to 64 saved notes.</p>
</section>
<style>.sticky-row { display: flex; gap: 6px; margin: 8px 0; }.sticky-row button:first-child { flex: 1; min-width: 0; overflow-wrap: anywhere; text-align: left; }</style>
