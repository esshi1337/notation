<script lang="ts">
  import '@fontsource/source-sans-3/latin-400-italic.css';
  import '@fontsource/source-sans-3/latin-600-italic.css';
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { legacyStickyText, sanitizeSticky, stickyColors, stickyTitle, validateSticky, type StickyColor, type StickyContent } from './sticky-format';
  let { id }: { id: string } = $props();
  let loaded = $state(false), loading = $state(false), closing = $state(false);
  let editor: HTMLDivElement;
  let color = $state<StickyColor>('yellow');
  let selection: Range | undefined;
  let bold = $state(false), italic = $state(false), bullets = $state(false);
  let content = { title: '', text: '', html: '' };
  let message = $state('Loading…'), error = $state('');
  let empty = $state(true);
  let disposed = false, destroying = false, revision = 0, saved = 0, closeAttempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, worker: Promise<void> | null = null;
  let unclose = $state<(() => void) | undefined>();
  const current = getCurrentWindow();
  function rememberSelection() {
    const range = window.getSelection();
    if (range?.rangeCount && editor?.contains(range.anchorNode) && editor.contains(range.focusNode)) {
      selection = range.getRangeAt(0).cloneRange();
      bold = document.queryCommandState('bold'); italic = document.queryCommandState('italic'); bullets = document.queryCommandState('insertUnorderedList');
    }
  }
  function restoreSelection() {
    editor.focus();
    if (selection && editor.contains(selection.commonAncestorContainer)) {
      const currentSelection = window.getSelection();
      currentSelection?.removeAllRanges(); currentSelection?.addRange(selection);
    }
  }
  function format(command: 'bold' | 'italic' | 'insertUnorderedList') {
    if (!loaded || closing) return;
    // Native undo may replace DOM nodes and adjust its range synchronously,
    // before selectionchange fires. Prefer that live range while still focused.
    if (document.activeElement === editor) rememberSelection();
    restoreSelection();
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand(command);
    rememberSelection(); changed();
  }
  function keydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'b' || key === 'i') { event.preventDefault(); format(key === 'b' ? 'bold' : 'italic'); }
      // Keep the browser's native undo/redo. No other formatting shortcuts.
      else if (['u', 'k'].includes(key) || (event.shiftKey && ['x', '7', '8', '9', 'e', 'l', 'r', 'j'].includes(key))) event.preventDefault();
    }
  }
  function beforeinput(event: InputEvent) {
    const allowed = /^(insertText|insertCompositionText|insertFromComposition|insertReplacementText|insertParagraph|insertLineBreak|delete\w+|historyUndo|historyRedo|formatBold|formatItalic|insertUnorderedList)$/;
    if (!allowed.test(event.inputType)) event.preventDefault();
  }
  function plainInsert(event: ClipboardEvent | DragEvent) {
    event.preventDefault();
    if (!loaded || closing) return;
    const data = 'clipboardData' in event ? event.clipboardData : event.dataTransfer;
    // Never pass HTML, URLs, or files to the browser's default insertion path.
    const text = data?.getData('text/plain');
    if (text) { restoreSelection(); document.execCommand('insertText', false, text); changed(); rememberSelection(); }
  }
  function cancelTimer() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function changed() {
    if (!loaded || closing) return;
    const text = editor.innerText.replace(/\r\n?/g, '\n');
    empty = text.trim().length === 0;
    content = { title: stickyTitle(text), text, html: sanitizeSticky(editor.innerHTML) };
    revision++; message = 'Unsaved'; error = ''; cancelTimer();
    timer = setTimeout(() => { timer = undefined; void flush().catch(() => {}); }, 350);
  }
  function flush(): Promise<void> {
    cancelTimer();
    if (worker) return worker;
    worker = (async () => {
      while (!disposed && saved < revision) {
        const version = revision, snapshot = { id, ...content, color };
        if (!destroying) { message = 'Saving…'; error = ''; }
        try { validateSticky(snapshot.text, snapshot.html); await invoke('update_sticky_note', snapshot); }
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
    closing = true; closeAttempt++; cancelTimer();
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
    const initialCloseAttempt = closeAttempt;
    try {
      const note = await invoke<StickyContent>('read_sticky_note', { id });
      if (!disposed && !destroying && unclose) {
        if (note.html != null) editor.innerHTML = sanitizeSticky(note.html);
        else editor.textContent = legacyStickyText(note);
        color = stickyColors.includes(note.color as StickyColor) ? note.color as StickyColor : 'yellow';
        empty = editor.innerText.trim().length === 0;
        loaded = true;
        // A later close failure must remain visible when this earlier read finishes.
        if (closeAttempt === initialCloseAttempt) { message = 'Saved'; error = ''; }
        // Reading never writes or truncates a legacy title/body combination.
        try { validateSticky(editor.innerText, sanitizeSticky(editor.innerHTML)); }
        catch (cause) { error = String(cause); }
      }
    } catch (cause) { if (!disposed && !destroying) { error = String(cause); message = 'Could not load'; } }
    // A failed close can return to this window after a read settled during destruction.
    finally { if (!disposed) loading = false; }
  }
  onMount(() => {
    document.addEventListener('selectionchange', rememberSelection);
    void (async () => {
      try {
        const stop = await current.onCloseRequested((event) => { event.preventDefault(); void closeNote(); });
        if (disposed) { stop(); return; }
        unclose = stop;
        await load();
      } catch (cause) { if (!disposed) { error = String(cause); message = 'Close protection unavailable — editing disabled'; } }
    })();
    return () => { disposed = true; cancelTimer(); unclose?.(); document.removeEventListener('selectionchange', rememberSelection); selection = undefined; };
  });
</script>

<svelte:window ondragover={(event) => event.preventDefault()} ondrop={(event) => event.preventDefault()} />

<main class="sticky-note" data-color={color} aria-label="Sticky note">
  <header>
    <span class="note-label">Sticky note</span>
    <div class="formats" role="group" aria-label="Formatting">
      <button aria-label="Bold" title="Bold (Ctrl+B)" aria-pressed={bold} disabled={!loaded || closing} onpointerdown={(event) => event.preventDefault()} onclick={() => format('bold')}><b>B</b></button>
      <button aria-label="Italic" title="Italic (Ctrl+I)" aria-pressed={italic} disabled={!loaded || closing} onpointerdown={(event) => event.preventDefault()} onclick={() => format('italic')}><i>I</i></button>
      <button aria-label="Bullets" title="Bullet list" aria-pressed={bullets} disabled={!loaded || closing} onpointerdown={(event) => event.preventDefault()} onclick={() => format('insertUnorderedList')}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4h8M6 8h8M6 12h8" stroke="currentColor" stroke-width="1.5"/><circle cx="2" cy="4" r="1" fill="currentColor"/><circle cx="2" cy="8" r="1" fill="currentColor"/><circle cx="2" cy="12" r="1" fill="currentColor"/></svg></button>
    </div>
    <button class="close" aria-label="Close sticky" title="Close note — your writing stays saved" disabled={closing} onclick={closeNote}>×</button>
  </header>
  <div class="colors" role="group" aria-label="Note color">
    <span class="color-label">Paper</span>
    {#each stickyColors as swatch}
      <button class="swatch" title={`${swatch[0].toUpperCase() + swatch.slice(1)} paper`} data-color={swatch} aria-label={`${swatch[0].toUpperCase() + swatch.slice(1)} paper`} aria-pressed={color === swatch} disabled={!loaded || closing} onclick={() => { color = swatch; changed(); }}></button>
    {/each}
  </div>
  <div class="paper" class:empty={loaded && empty} data-placeholder="Write something worth keeping…" bind:this={editor} role="textbox" aria-label="Sticky text" aria-multiline="true" aria-disabled={!loaded || closing} tabindex="0" contenteditable={loaded && !closing} spellcheck="true" oninput={changed} onbeforeinput={beforeinput} onkeydown={keydown} onpaste={plainInsert} ondrop={plainInsert} ondragover={(event) => event.preventDefault()}></div>
  <footer><span class:error={!!error} role="status" aria-live="polite"><span class="status-dot" aria-hidden="true"></span>{message}</span><span class="save-hint">Autosave</span></footer>
  {#if error}<div role="alert">{error}<button disabled={closing || loading || !unclose} onclick={() => loaded ? void flush().catch(() => {}) : void load()}>Retry</button></div>{/if}
</main>
<style>
  [data-color="yellow"] { --paper: #fff3b0; } [data-color="green"] { --paper: #d9edbd; } [data-color="blue"] { --paper: #cde8fa; } [data-color="pink"] { --paper: #f9d4df; } [data-color="purple"] { --paper: #e5d8f5; } [data-color="gray"] { --paper: #e5e5e2; }
  .sticky-note { box-sizing: border-box; height: 100dvh; display: flex; flex-direction: column; padding: 12px 16px 10px; background: var(--paper); color: #302b17; font-family: 'Source Sans 3', ui-sans-serif, sans-serif; }
  header { display: flex; align-items: center; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid #302b1726; }
  .note-label { flex: 1; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .formats, .colors { display: flex; align-items: center; gap: 4px; }
  .formats { padding-right: 8px; border-right: 1px solid #302b1726; }
  button { display: inline-grid; place-items: center; height: 28px; min-width: 28px; padding: 2px 5px; background: transparent; color: #302b17; border: 1px solid transparent; border-radius: 4px; cursor: pointer; }
  button:hover:not(:disabled), button[aria-pressed="true"] { border-color: #615735; background: #ffffff55; }
  button:disabled { opacity: .4; cursor: default; }
  button:focus-visible, .paper:focus-visible { outline: 2px solid #514a32; outline-offset: 2px; }
  .close { font-size: 22px; } .colors { padding: 10px 0 6px; gap: 6px; }
  .color-label { margin-right: 4px; font-size: 11px; color: #615735; }
  .swatch { background: var(--paper); min-width: 22px; width: 22px; height: 22px; border: 1px solid #302b1755; border-radius: 50%; }
  .swatch:hover:not(:disabled) { background: var(--paper); }
  .swatch[aria-pressed="true"] { background: var(--paper); box-shadow: inset 0 0 0 3px var(--paper), inset 0 0 0 5px #514a32; }
  .paper { position: relative; flex: 1; min-height: 40px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px 2px; font: 17px/1.55 'Source Sans 3', ui-sans-serif, sans-serif; outline: none; }
  .paper.empty::before { content: attr(data-placeholder); position: absolute; inset: 12px 2px auto; color: #615735; pointer-events: none; }
  .paper :global(p), .paper :global(div) { margin: 0; } .paper :global(ul) { margin: 0; padding-left: 24px; }
  footer { display: flex; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid #302b1726; font-size: 11px; color: #615735; }
  [role="status"] { display: flex; align-items: center; gap: 5px; }
  .status-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
  .error, [role="alert"] { color: #8c221b; }
  [role="alert"] { max-height: 30vh; overflow: auto; overflow-wrap: anywhere; font-size: 13px; padding-top: 8px; } [role="alert"] button { border-color: currentColor; margin-left: 6px; }
  @media (max-width: 300px) { .sticky-note { padding: 10px; } .note-label { font-size: 11px; } header { gap: 4px; } .formats { padding-right: 4px; } .save-hint { display: none; } }
</style>
