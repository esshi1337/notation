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
  <p class="panel-note">{desktop ? 'Small notes that stay above your windows. Your writing saves automatically.' : 'Sticky notes require the desktop app: browsers cannot create independent always-on-top native windows.'}</p>
  <div class="panel-actions"><button class="new-note" disabled={!desktop || busy} onclick={create}>New sticky note</button><button disabled={!desktop || busy} onclick={() => action(refresh)}>Refresh notes</button></div>
  {#if error}<p role="alert" class="script-error">{error}</p>{/if}
  {#if desktop}<div class="list-heading"><strong>Saved notes</strong><span>{notes.length} / 64</span></div>{/if}
  <div class="notes-list">
  {#each notes as note (note.id)}
    <div class="sticky-row"><button disabled={busy} onclick={() => action(async () => { await invoke('open_sticky_note', { id: note.id }); })}>{note.title || 'Untitled sticky'}</button><button class="delete-note" disabled={busy} aria-label={`Delete ${note.title || 'Untitled sticky'}`} onclick={() => remove(note)}>Delete</button></div>
  {/each}
  </div>
  {#if desktop && !busy && !notes.length}<div class="empty-notes"><strong>No saved sticky notes.</strong><p>Keep a thought, a reminder, or your next step close at hand.</p></div>{/if}
  <p class="panel-note sticky-help">Closing a note keeps it saved here. Minimize Notation to keep notes on your desktop; close sticky windows before quitting.</p>
</section>
<style>
  .panel-note { line-height: 1.55; margin: 0; }
  .panel-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .panel-actions button { min-height: 30px; }
  .new-note { flex: 1; font-weight: 600; }
  .list-heading { display: flex; justify-content: space-between; align-items: center; padding-top: 8px; font-size: 11px; }
  .list-heading span { color: var(--muted); font-variant-numeric: tabular-nums; }
  .notes-list { display: flex; flex-direction: column; gap: 6px; }
  .notes-list:empty { display: none; }
  .sticky-row { display: flex; gap: 4px; padding: 5px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); }
  .sticky-row button:first-child { flex: 1; min-width: 0; overflow-wrap: anywhere; text-align: left; border-color: transparent; background: transparent; padding: 7px; line-height: 1.4; }
  .sticky-row button:first-child:hover { background: var(--hover); }
  .delete-note { align-self: center; color: var(--muted); border-color: transparent; font-size: 10px; }
  .delete-note:hover { color: var(--text); }
  .empty-notes { padding: 20px 12px; border: 1px dashed var(--border); border-radius: 6px; text-align: center; line-height: 1.5; }
  .empty-notes p { margin: 6px 0 0; color: var(--muted); }
  .sticky-help { border-top: 1px solid var(--border); padding-top: 12px; color: var(--muted); }
</style>
