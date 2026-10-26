<script lang="ts">
  import '@fontsource/source-sans-3/latin-400-italic.css';
  import '@fontsource/source-sans-3/latin-600-italic.css';
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { legacyStickyText, sanitizeSticky, stickyColors, stickyTitle, validateSticky, type StickyColor, type StickyContent } from './sticky-format';
  let { id }: { id: string } = $props();
  let loaded = $state(false), loading = $state(false), closing = $state(false), creating = $state(false);
  let editor: HTMLDivElement;
  let color = $state<StickyColor>('black');
  let selection: Range | undefined;
  let bold = $state(false), italic = $state(false), underline = $state(false), strike = $state(false), bullets = $state(false);
  let menu = $state(false), toolbar = $state(true), preferenceError = $state('');
  const toolbarKey = 'notation.sticky.toolbar';
  let preferenceOperation: 'read' | 'write' = 'read';
  type Failure = 'load' | 'save' | 'close' | 'create' | 'drag' | 'protection';
  let content = { title: '', text: '', html: '' };
  let errors = $state<Partial<Record<Failure, string>>>({});
  let empty = $state(true);
  let disposed = false, destroying = false, connecting = false, revision = 0, saved = 0, closeAttempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, worker: Promise<void> | null = null;
  let unclose = $state<(() => void) | undefined>();
  const current = getCurrentWindow();
  function report(cause: unknown, kind: Failure) { errors[kind] = String(cause); }
  function clearFailure(kind: Failure) { delete errors[kind]; }
  function toolbarPreference(operation: 'read' | 'write') {
    preferenceOperation = operation;
    try {
      if (operation === 'read') toolbar = localStorage.getItem(toolbarKey) !== 'hidden';
      else localStorage.setItem(toolbarKey, toolbar ? 'visible' : 'hidden');
      preferenceError = '';
    } catch { preferenceError = 'Could not remember the toolbar preference. Your writing is unaffected.'; }
  }
  function toggleToolbar() { toolbar = !toolbar; menu = false; toolbarPreference('write'); }
  function rememberSelection() {
    const range = window.getSelection();
    if (range?.rangeCount && editor?.contains(range.anchorNode) && editor.contains(range.focusNode)) {
      selection = range.getRangeAt(0).cloneRange();
      bold = document.queryCommandState('bold'); italic = document.queryCommandState('italic');
      underline = document.queryCommandState('underline'); strike = document.queryCommandState('strikeThrough');
      bullets = document.queryCommandState('insertUnorderedList');
    }
  }
  function restoreSelection() {
    editor.focus();
    if (selection && editor.contains(selection.commonAncestorContainer)) {
      const currentSelection = window.getSelection();
      currentSelection?.removeAllRanges(); currentSelection?.addRange(selection);
    }
  }
  function format(command: 'bold' | 'italic' | 'underline' | 'strikeThrough' | 'insertUnorderedList') {
    if (!loaded || closing) return;
    // Native undo may replace DOM nodes before selectionchange fires.
    if (document.activeElement === editor) rememberSelection();
    restoreSelection();
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand(command);
    rememberSelection(); changed();
  }
  function keydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      // Ctrl/Cmd+Shift+8 is the bullet shortcut. Use code because key is '*'.
      const command = event.shiftKey
        ? ['Digit8', 'Numpad8'].includes(event.code) ? 'insertUnorderedList' : key === 'x' ? 'strikeThrough' : undefined
        : key === 'b' ? 'bold' : key === 'i' ? 'italic' : key === 'u' ? 'underline' : undefined;
      if (command) { event.preventDefault(); format(command); }
      // Preserve native undo/redo and block unsupported rich formatting.
      else if (key === 'k' || (event.shiftKey && ['7', '9', 'e', 'l', 'r', 'j'].includes(key))) event.preventDefault();
    }
  }
  function beforeinput(event: InputEvent) {
    const allowed = /^(insertText|insertCompositionText|insertFromComposition|insertReplacementText|insertParagraph|insertLineBreak|delete\w+|historyUndo|historyRedo|formatBold|formatItalic|formatUnderline|formatStrikeThrough|insertUnorderedList)$/;
    if (!allowed.test(event.inputType)) event.preventDefault();
  }
  function plainInsert(event: ClipboardEvent | DragEvent) {
    event.preventDefault();
    if (!loaded || closing) return;
    const data = 'clipboardData' in event ? event.clipboardData : event.dataTransfer;
    const text = data?.getData('text/plain');
    if (text) { restoreSelection(); document.execCommand('insertText', false, text); changed(); rememberSelection(); }
  }
  function cancelTimer() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function changed() {
    if (!loaded || closing) return;
    const text = editor.innerText.replace(/\r\n?/g, '\n');
    empty = text.trim().length === 0;
    content = { title: stickyTitle(text), text, html: sanitizeSticky(editor.innerHTML) };
    revision++; cancelTimer();
    timer = setTimeout(() => { timer = undefined; void flush().catch(() => {}); }, 350);
  }
  function flush(): Promise<void> {
    cancelTimer();
    if (worker) return worker;
    worker = (async () => {
      while (!disposed && saved < revision) {
        const version = revision, snapshot = { id, ...content, color };
        try { validateSticky(snapshot.text, snapshot.html); await invoke('update_sticky_note', snapshot); }
        catch (cause) {
          if (disposed || destroying) return;
          report(cause, 'save');
          // A timer may already have joined this worker. Do not strand newer edits
          // when the older snapshot fails; attempt the latest snapshot once.
          if (revision > version) continue;
          throw cause;
        }
        if (disposed || destroying) return;
        saved = version;
      }
      if (!disposed && !destroying) clearFailure('save');
    })().finally(() => { worker = null; });
    return worker;
  }
  async function closeNote() {
    if (closing || disposed || destroying || creating) return;
    closing = true; closeAttempt++; cancelTimer();
    let phase: Failure = 'save';
    try {
      if (loaded) await flush();
      if (disposed) return;
      destroying = true; phase = 'close';
      await invoke('close_sticky_note', { id });
    } catch (cause) {
      destroying = false;
      if (!disposed) { closing = false; report(cause, phase); }
    }
  }
  async function newNote() {
    if (creating || closing || disposed) return;
    creating = true;
    try { await invoke('new_sticky_note', { id }); if (!disposed) { clearFailure('create'); menu = false; } }
    catch (cause) { if (!disposed) report(cause, 'create'); }
    finally { if (!disposed) creating = false; }
  }
  async function drag() {
    try { await invoke('drag_sticky_note', { id }); if (!disposed) clearFailure('drag'); }
    catch (cause) { if (!disposed) report(cause, 'drag'); }
  }
  function dragBar(event: PointerEvent) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button') || closing) return;
    event.preventDefault(); void drag();
  }
  async function load() {
    if (loading || closing || disposed || destroying || loaded) return;
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
        if (closeAttempt === initialCloseAttempt) { clearFailure('load'); clearFailure('protection'); }
        try { validateSticky(editor.innerText, sanitizeSticky(editor.innerHTML)); }
        catch (cause) { report(cause, 'save'); }
      }
    } catch (cause) { if (!disposed && !destroying) report(cause, 'load'); }
    finally { if (!disposed) loading = false; }
  }
  async function connect() {
    if (connecting || disposed) return;
    connecting = true;
    try {
      const stop = await current.onCloseRequested((event) => { event.preventDefault(); void closeNote(); });
      if (disposed) { stop(); return; }
      unclose = stop;
      clearFailure('protection');
      await load();
    } catch (cause) { if (!disposed) report(`Close protection unavailable — editing disabled. ${cause}`, 'protection'); }
    finally { connecting = false; }
  }
  function retry(kind: Failure) {
    if (!unclose) void connect();
    else if (!loaded) void load();
    else if (kind === 'close') void closeNote();
    else if (kind === 'create') void newNote();
    else if (kind === 'drag') void drag();
    else void flush().catch(() => {});
  }
  onMount(() => {
    toolbarPreference('read');
    document.addEventListener('selectionchange', rememberSelection);
    void connect();
    return () => { disposed = true; cancelTimer(); unclose?.(); document.removeEventListener('selectionchange', rememberSelection); selection = undefined; };
  });
</script>

<svelte:window ondragover={(event) => event.preventDefault()} ondrop={(event) => event.preventDefault()} onkeydown={(event) => { if (event.key === 'Escape') menu = false; }} />

<main class="sticky-note" data-color={color} aria-label="Sticky note">
  <header role="toolbar" tabindex="-1" aria-label="Note controls" onpointerdown={dragBar}>
    <button aria-label="New sticky note" title="New note" disabled={creating || closing} onclick={newNote}><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg></button>
    <span class="drag-space" aria-hidden="true"></span>
    <button aria-label="Note options" title="More options" aria-expanded={menu} aria-controls="note-options" onclick={() => menu = !menu}><svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="4" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="16" cy="10" r="1.5" /></svg></button>
    <button aria-label="Close sticky" title="Close note" disabled={closing || creating} onclick={closeNote}><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg></button>
  </header>
  {#if menu}
    <div id="note-options" class="options" role="group" aria-label="Note options">
      <div class="colors" role="group" aria-label="Note color">
        {#each stickyColors as swatch}
          <button class="swatch" title={`${swatch[0].toUpperCase() + swatch.slice(1)} paper`} data-color={swatch} aria-label={`${swatch[0].toUpperCase() + swatch.slice(1)} paper`} aria-pressed={color === swatch} disabled={!loaded || closing} onclick={() => { color = swatch; changed(); }}></button>
        {/each}
      </div>
      <button class="toolbar-option" onclick={toggleToolbar}>{toolbar ? 'Hide' : 'Show'} formatting toolbar</button>
    </div>
  {/if}
  <div class="paper" class:empty={loaded && empty} data-placeholder="Write something…" bind:this={editor} role="textbox" aria-label="Sticky text" aria-multiline="true" aria-disabled={!loaded || closing} tabindex="0" contenteditable={loaded && !closing} spellcheck="true" oninput={changed} onbeforeinput={beforeinput} onkeydown={keydown} onpaste={plainInsert} ondrop={plainInsert} ondragover={(event) => event.preventDefault()}></div>
  {#if toolbar}
    <div class="formats" role="toolbar" aria-label="Formatting">
      <button aria-label="Bold" title="Bold (Ctrl/Cmd+B)" aria-pressed={bold} disabled={!loaded || closing} onpointerdown={(event) => event.preventDefault()} onclick={() => format('bold')}><b>B</b></button>
      <button aria-label="Italic" title="Italic (Ctrl/Cmd+I)" aria-pressed={italic} disabled={!loaded || closing} onpointerdown={(event) => event.preventDefault()} onclick={() => format('italic')}><i>I</i></button>
      <button aria-label="Underline" title="Underline (Ctrl/Cmd+U)" aria-pressed={underline} disabled={!loaded || closing} onpointerdown={(event) => event.preventDefault()} onclick={() => format('underline')}><u>U</u></button>
      <button aria-label="Strikethrough" title="Strikethrough (Ctrl/Cmd+Shift+X)" aria-pressed={strike} disabled={!loaded || closing} onpointerdown={(event) => event.preventDefault()} onclick={() => format('strikeThrough')}><s>S</s></button>
      <button aria-label="Bullets" title="Bullet list (Ctrl/Cmd+Shift+8)" aria-pressed={bullets} disabled={!loaded || closing} onpointerdown={(event) => event.preventDefault()} onclick={() => format('insertUnorderedList')}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4h8M6 8h8M6 12h8" stroke="currentColor" stroke-width="1.5"/><circle cx="2" cy="4" r="1" fill="currentColor"/><circle cx="2" cy="8" r="1" fill="currentColor"/><circle cx="2" cy="12" r="1" fill="currentColor"/></svg></button>
    </div>
  {/if}
  {#if Object.keys(errors).length || preferenceError}
    <div class="errors" role="region" aria-label="Note errors">
  {#each Object.entries(errors) as [kind, error] (kind)}
    <div role="alert">{error}<button disabled={closing || loading || creating} onclick={() => retry(kind as Failure)}>Retry</button></div>
  {/each}
  {#if preferenceError}<div role="alert">{preferenceError}<button onclick={() => toolbarPreference(preferenceOperation)}>Retry toolbar preference</button></div>{/if}
    </div>
  {/if}
</main>
<style>
  [data-color="black"] { --paper: #000000; }
  [data-color="yellow"] { --paper: #fff3b0; } [data-color="green"] { --paper: #d9edbd; } [data-color="blue"] { --paper: #cde8fa; } [data-color="pink"] { --paper: #f9d4df; } [data-color="purple"] { --paper: #e5d8f5; } [data-color="gray"] { --paper: #e5e5e2; }
  .sticky-note { --ink: #302b17; --muted: #615735; --bar: #0000000c; --hover: #00000012; --error: #8c221b; box-sizing: border-box; height: 100dvh; position: relative; display: flex; flex-direction: column; background: var(--paper); color: var(--ink); font-family: 'Source Sans 3', ui-sans-serif, sans-serif; }
  .sticky-note[data-color="black"] { --ink: #f3f3f3; --muted: #bababa; --bar: #000000; --hover: #ffffff20; --error: #ffb4ab; }
  header { display: flex; align-items: center; height: 34px; flex-shrink: 0; background: var(--bar); user-select: none; }
  .drag-space { flex: 1; align-self: stretch; }
  button { display: inline-grid; place-items: center; height: 32px; min-width: 34px; padding: 2px 8px; background: transparent; color: inherit; border: 0; border-radius: 0; cursor: pointer; font: inherit; }
  button:hover:not(:disabled), button[aria-pressed="true"] { background: var(--hover); }
  button:disabled { opacity: .4; cursor: default; }
  button:focus-visible { outline: 2px solid var(--muted); outline-offset: -2px; }
  header button { width: 34px; padding: 0; flex-shrink: 0; }
  header svg { display: block; width: 20px; height: 20px; }
  .options { position: absolute; z-index: 1; top: 34px; right: 0; max-width: 100%; padding: 8px; box-sizing: border-box; background: var(--paper); box-shadow: 0 3px 8px #0005; }
  .sticky-note[data-color="black"] .options { border: 1px solid #ffffff20; }
  .colors { display: flex; gap: 6px; padding: 4px 0 8px; }
  .swatch { background: var(--paper); min-width: 24px; width: 24px; height: 24px; padding: 0; border: 1px solid #888; }
  .swatch:hover:not(:disabled), .swatch[aria-pressed="true"] { background: var(--paper); outline: 2px solid var(--muted); outline-offset: -4px; }
  .toolbar-option { width: 100%; text-align: left; font-size: 14px; }
  .paper { position: relative; flex: 1; min-height: 24px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 16px; font: 17px/1.55 'Source Sans 3', ui-sans-serif, sans-serif; outline: none; }
  .paper.empty::before { content: attr(data-placeholder); position: absolute; inset: 16px 16px auto; color: var(--muted); pointer-events: none; }
  .paper :global(p), .paper :global(div) { margin: 0; } .paper :global(ul) { margin: 0; padding-left: 24px; }
  .formats { display: flex; flex-shrink: 0; align-items: center; padding: 3px 8px; background: var(--bar); }
  .errors { flex-shrink: 0; max-height: 35vh; overflow: auto; }
  [role="alert"] { color: var(--error); min-height: 32px; overflow-wrap: anywhere; font-size: 13px; padding: 4px 8px; }
  [role="alert"] button { min-height: 28px; height: auto; text-decoration: underline; }
</style>
