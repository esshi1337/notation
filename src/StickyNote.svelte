<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  let { id }: { id: string } = $props();
  let title = $state(''), text = $state(''), loaded = $state(false), loading = $state(false), closing = $state(false);
  let message = $state('Loading…'), error = $state('');
  let disposed = false, destroying = false, revision = 0, saved = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, worker: Promise<void> | null = null;
  let unclose = $state<(() => void) | undefined>();
  const current = getCurrentWindow();
  function cancelTimer() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function changed() {
    revision++; message = 'Unsaved'; error = ''; cancelTimer();
    timer = setTimeout(() => { timer = undefined; void flush().catch(() => {}); }, 350);
  }
  function flush(): Promise<void> {
    cancelTimer();
    if (worker) return worker;
    worker = (async () => {
      while (!disposed && saved < revision) {
        const version = revision, snapshot = { id, title, text };
        if (!destroying) { message = 'Saving…'; error = ''; }
        try { await invoke('update_sticky_note', snapshot); }
        catch (cause) {
          if (!disposed && !destroying) { error = String(cause); message = 'Not saved'; }
          throw cause;
        }
        if (disposed || destroying) return;
        saved = version;
      }
      if (!disposed && !destroying) { message = 'Saved'; error = ''; }
    })().finally(() => { worker = null; });
    return worker;
  }
  async function closeNote() {
    if (closing || disposed || destroying) return;
    closing = true; cancelTimer();
    try {
      if (loaded) await flush();
      if (disposed) return;
      destroying = true;
      await invoke('close_sticky_note', { id });
      // Do not update reactive state after native destruction.
    } catch (cause) {
      destroying = false;
      if (!disposed) { closing = false; error = String(cause); message = 'Not closed — retry saving'; }
    }
  }
  async function load() {
    if (loading || closing || disposed || destroying) return;
    loading = true;
    try {
      const note = await invoke<{ title: string; text: string }>('read_sticky_note', { id });
      if (!disposed && !destroying && unclose) { title = note.title; text = note.text; loaded = true; message = 'Saved'; error = ''; }
    } catch (cause) { if (!disposed && !destroying) { error = String(cause); message = 'Could not load'; } }
    finally { if (!disposed && !destroying) loading = false; }
  }
  onMount(() => {
    void (async () => {
      try {
        const stop = await current.onCloseRequested((event) => { event.preventDefault(); void closeNote(); });
        if (disposed) { stop(); return; }
        unclose = stop;
        await load();
      } catch (cause) { if (!disposed) { error = String(cause); message = 'Close protection unavailable — editing disabled'; } }
    })();
    return () => { disposed = true; cancelTimer(); unclose?.(); };
  });
</script>

<main class="sticky-note" aria-label="Sticky note">
  <label>Title<input aria-label="Sticky title" bind:value={title} oninput={changed} disabled={!loaded || closing} /></label>
  <label class="body">Note<textarea aria-label="Sticky text" bind:value={text} oninput={changed} disabled={!loaded || closing} spellcheck="true"></textarea></label>
  <footer><span role="status">{message}</span><button disabled={closing} onclick={closeNote}>Close sticky</button></footer>
  {#if error}<div role="alert">{error}<button disabled={closing || loading || !unclose} onclick={() => loaded ? void flush().catch(() => {}) : void load()}>Retry</button></div>{/if}
</main>
<style>
  .sticky-note { box-sizing: border-box; height: 100dvh; display: flex; flex-direction: column; gap: 10px; padding: 14px; background: #fff3b0; color: #302b17; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; } .body { flex: 1; min-height: 50px; }
  input, textarea { box-sizing: border-box; width: 100%; background: #fff9d8; color: #302b17; border: 1px solid #9a864b; border-radius: 4px; padding: 8px; font: inherit; }
  textarea { flex: 1; resize: none; font-size: 15px; } footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; } [role="alert"] { overflow-wrap: anywhere; color: #8c221b; } button { background: #fff9d8; color: #302b17; border: 1px solid #9a864b; }
</style>
