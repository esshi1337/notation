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
  let disposed = false, destroying = false, revision = 0, saved = 0;
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
      const note = await invoke<StickyContent>('read_sticky_note', { id });
      if (!disposed && !destroying && unclose) {
        if (note.html != null) editor.innerHTML = sanitizeSticky(note.html);
        else editor.textContent = legacyStickyText(note);
        color = stickyColors.includes(note.color as StickyColor) ? note.color as StickyColor : 'yellow';
        loaded = true; message = 'Saved'; error = '';
        // Reading never writes or truncates a legacy title/body combination.
        try { validateSticky(editor.innerText, sanitizeSticky(editor.innerHTML)); }
        catch (cause) { error = String(cause); }
      }
    } catch (cause) { if (!disposed && !destroying) { error = String(cause); message = 'Could not load'; } }
    finally { if (!disposed && !destroying) loading = false; }
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
    <div class="formats" role="group" aria-label="Formatting">
      <button aria-label="Bold" aria-pressed={bold} disabled={!loaded || closing} onpointerdown={(event) => event.preventDefault()} onclick={() => format('bold')}><b>B</b></button>
      <button aria-label="Italic" aria-pressed={italic} disabled={!loaded || closing} onpointerdown={(event) => event.preventDefault()} onclick={() => format('italic')}><i>I</i></button>
      <button aria-label="Bullets" aria-pressed={bullets} disabled={!loaded || closing} onpointerdown={(event) => event.preventDefault()} onclick={() => format('insertUnorderedList')}>• ≡</button>
    </div>
    <button class="close" aria-label="Close sticky" disabled={closing} onclick={closeNote}>×</button>
  </header>
  <div class="colors" role="group" aria-label="Note color">
    {#each stickyColors as swatch}
      <button class="swatch" data-color={swatch} aria-label={`${swatch[0].toUpperCase() + swatch.slice(1)} paper`} aria-pressed={color === swatch} disabled={!loaded || closing} onclick={() => { color = swatch; changed(); }}></button>
    {/each}
  </div>
  <div class="paper" bind:this={editor} role="textbox" aria-label="Sticky text" aria-multiline="true" aria-disabled={!loaded || closing} tabindex="0" contenteditable={loaded && !closing} spellcheck="true" oninput={changed} onbeforeinput={beforeinput} onkeydown={keydown} onpaste={plainInsert} ondrop={plainInsert} ondragover={(event) => event.preventDefault()}></div>
  {#if !loaded}<span role="status">{message}</span>{/if}
  {#if error}<div role="alert">{error}<button disabled={closing || loading || !unclose} onclick={() => loaded ? void flush().catch(() => {}) : void load()}>Retry</button></div>{/if}
</main>
<style>
  [data-color="yellow"] { --paper: #fff3b0; } [data-color="green"] { --paper: #d9edbd; } [data-color="blue"] { --paper: #cde8fa; } [data-color="pink"] { --paper: #f9d4df; } [data-color="purple"] { --paper: #e5d8f5; } [data-color="gray"] { --paper: #e5e5e2; }
  .sticky-note { box-sizing: border-box; height: 100dvh; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; background: var(--paper); color: #302b17; }
  header { display: flex; align-items: center; justify-content: space-between; } .formats, .colors { display: flex; gap: 4px; }
  button { display: inline-grid; place-items: center; height: 28px; min-width: 28px; padding: 2px 5px; background: transparent; color: #302b17; border: 1px solid transparent; border-radius: 4px; cursor: pointer; }
  button:hover, button[aria-pressed="true"] { border-color: #615735; background: #ffffff55; } button:focus-visible, .paper:focus-visible { outline: 2px solid #514a32; outline-offset: 2px; }
  .close { font-size: 22px; } .colors { padding: 2px 0 4px; } .swatch { background: var(--paper); min-width: 22px; width: 22px; height: 22px; border: 1px solid #302b1755; border-radius: 50%; }
  .swatch[aria-pressed="true"] { background: var(--paper); box-shadow: inset 0 0 0 3px var(--paper), inset 0 0 0 5px #514a32; }
  .paper { flex: 1; min-height: 40px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 6px 2px; font: 16px/1.5 'Source Sans 3', ui-sans-serif, sans-serif; outline: none; }
  .paper :global(p), .paper :global(div) { margin: 0; } .paper :global(ul) { margin: 0; padding-left: 24px; }
  [role="alert"] { overflow-wrap: anywhere; color: #8c221b; font-size: 13px; } [role="alert"] button { border-color: currentColor; margin-left: 6px; }
</style>
