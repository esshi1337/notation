<script lang="ts">
  import { compareRevisions } from './revision-diff';
  import { invoke } from '@tauri-apps/api/core';
  import { flushPersistence, nativeStore } from './store';
  type Revision = { id: number; documentKey: string; name: string; path: string | null; createdAt: number; reason: string; preview: string; content?: string };
  type Snapshot = { text: string; documentId: number };
  let { lockedReason = '', currentContent, documentKey, snapshot, restore, close }: { lockedReason?: string; currentContent: string; documentKey: string; snapshot: () => Snapshot; restore: (text: string, source: Snapshot) => boolean; close: () => void } = $props();
  let revisions = $state<Revision[]>([]);
  let selected = $state<Revision | null>(null);
  let error = $state('');
  let message = $state('');
  let busy = $state(false);
  let selectedSnapshot: Snapshot | null = null;
  let serial = 0, selectionSerial = 0, compareSerial = 0;
  let compareId = $state('current'), comparison = $state<Revision | null>(null), context = $state(3), comparing = $state(false);
  let diff = $derived(selected?.content === undefined ? null : compareRevisions(selected.content, compareId === 'current' ? currentContent : comparison?.content ?? '', label(selected), compareId === 'current' ? 'Current draft' : comparison ? label(comparison) : 'Revision', context));
  function label(revision: Revision) { return 'Revision ' + new Date(revision.createdAt).toLocaleString(); }
  async function load(key: string, ticket: number) {
    if (!nativeStore) return;
    busy = true; error = '';
    try { await flushPersistence(); const result = await invoke<Revision[]>('list_revisions', { documentKey: key }); if (ticket === serial) revisions = result; }
    catch (cause) { if (ticket === serial) error = 'Could not load revision history: ' + String(cause); }
    finally { if (ticket === serial) busy = false; }
  }
  $effect(() => { const key = documentKey; selected = null; selectedSnapshot = null; compareId = 'current'; comparison = null; selectionSerial++; compareSerial++; message = ''; void load(key, ++serial); });
  async function select(revision: Revision) {
    const ticket = serial, selectionTicket = ++selectionSerial, source = snapshot();
    try { const result = await invoke<Revision>('get_revision', { id: revision.id }); if (ticket === serial && selectionTicket === selectionSerial) { selected = result; selectedSnapshot = source; } }
    catch (cause) { if (ticket === serial && selectionTicket === selectionSerial) error = 'Could not read revision: ' + String(cause); }
  }
  async function compareWith(value: string) {
    compareId = value; comparison = null; const ticket = ++compareSerial, documentTicket = serial;
    if (value === 'current') { comparing = false; return; }
    comparing = true;
    try { const result = await invoke<Revision>('get_revision', { id: Number(value) }); if (ticket === compareSerial && documentTicket === serial) comparison = result; }
    catch (cause) { if (ticket === compareSerial && documentTicket === serial) error = 'Could not compare revision: ' + String(cause); }
    finally { if (ticket === compareSerial) comparing = false; }
  }
  function apply() {
    if (lockedReason) { error = lockedReason; return; }
    if (!selected || selected.content === undefined || !selectedSnapshot) return;
    if (!restore(selected.content, selectedSnapshot)) error = 'Document changed while viewing history. Select the revision again before restoring.';
    else { error = ''; message = 'Revision restored to the editor. Save to update the Markdown file.'; }
  }
</script>

<section class="utility-panel history-panel" aria-label="History">
  <div class="scripts-heading"><strong>History</strong><button aria-label="Close history" onclick={close}>×</button></div>
  {#if !nativeStore}<p class="panel-note">Revision history requires the desktop app. Your browser draft still uses local recovery storage.</p>{/if}
  <div class="panel-actions"><button onclick={() => load(documentKey, ++serial)} disabled={!nativeStore || busy}>Refresh history</button><button onclick={apply} disabled={!!lockedReason || !selected || selected.content === undefined || busy}>Restore revision</button></div>
  {#if lockedReason}<p class="panel-note" role="status">{lockedReason}</p>{/if}
  {#if error}<div class="script-error" role="alert">{error}</div>{/if}
  {#if message}<div class="panel-status" role="status">{message}</div>{/if}
  <div class="revision-list">{#each revisions as revision}<button class:active={selected?.id === revision.id} aria-label={label(revision)} onclick={() => select(revision)}><strong>{new Date(revision.createdAt).toLocaleString()}</strong><span>{revision.reason}</span><span class="revision-snippet">{revision.preview}</span></button>{/each}</div>
  {#if nativeStore && !busy && !revisions.length}<p class="panel-note">No revisions yet. Edits are captured as app state is saved.</p>{/if}
  {#if selected}
    <section class="revision-comparison" aria-label="Revision comparison">
      <label>Compare against<select aria-label="Compare against" value={compareId} onchange={(event) => void compareWith(event.currentTarget.value)}><option value="current">Current draft</option>{#each revisions as revision}<option value={String(revision.id)}>{label(revision)}</option>{/each}</select></label>
      <label>Diff context<input type="number" aria-label="Diff context" min="0" max="20" value={context} oninput={(event) => context = Math.max(0, Math.min(20, Number(event.currentTarget.value) || 0))} /></label>
      {#if comparing}<p class="panel-note">Loading comparison…</p>{:else if diff && (compareId === 'current' || comparison)}
        {#if diff.error}<div role="alert" class="script-error">{diff.error}</div>{:else}<p class="diff-counts" role="status">{diff.unchanged ? 'No changes' : '+' + diff.added + ' added · −' + diff.removed + ' removed'}</p><pre class="revision-content unified-diff" aria-label="Unified diff">{diff.text}</pre>{/if}
      {/if}
      <details><summary>Revision source</summary><pre class="revision-content" aria-label="Revision content">{selected.content}</pre></details>
    </section>
  {/if}
</section>
