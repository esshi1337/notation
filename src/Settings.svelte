<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { nativeStore } from './store';
  import { DEFAULT_UI_PREFERENCES } from './preferences';
  import type { UIPreferences } from './preferences';
  import { COMMANDS, formatShortcut, normalizeShortcut, shortcutFor, shortcutFromEvent, validateShortcut } from './shortcuts';
  import type { CommandId, ShortcutOverrides } from './shortcuts';
  type Layout = 'split' | 'source' | 'preview' | 'live';
  type Section = 'Appearance' | 'Editor' | 'Shortcuts' | 'Agents';
  type AgentStatus = { available: boolean; ready: boolean; socketPath?: string; command?: string; args?: string[]; error?: string };
  let { theme = $bindable(), fontSize = $bindable(), wrap = $bindable(), layout = $bindable(), prefs = $bindable(), shortcuts = $bindable(), agentEditsEnabled = $bindable(), close }: { theme: 'dark' | 'light'; fontSize: number; wrap: boolean; layout: Layout; prefs: UIPreferences; shortcuts: ShortcutOverrides; agentEditsEnabled: boolean; close: () => void } = $props();
  const sections: Section[] = ['Appearance', 'Editor', 'Shortcuts', 'Agents'];
  const mac = /Mac|iPhone|iPad/u.test(navigator.platform);
  let section = $state<Section>('Appearance');
  let status = $state<AgentStatus | null>(null), error = $state(''), copied = $state(false);
  let appearanceError = $state(''), shortcutError = $state(''), shortcutQuery = $state('');
  let filteredCommands = $derived(COMMANDS.filter(item => (item.label + ' ' + item.group).toLowerCase().includes(shortcutQuery.trim().toLowerCase())));
  let accentDraft = $state('');
  let drafts = $state<Record<string, string>>({});
  let dialog: HTMLDialogElement;
  let previousFocus: HTMLElement | null = null;
  let command = $derived(status?.command ? [status.command, ...(status.args ?? [])].map((part) => "'" + part.replaceAll("'", "'\\''") + "'").join(' ') : '');
  async function refresh() { if (nativeStore) try { status = await invoke<AgentStatus>('agent_status'); } catch (cause) { error = 'Could not read MCP connection: ' + String(cause); } }
  async function copy() { try { await navigator.clipboard.writeText(command); copied = true; } catch { error = 'Select the command below and copy it manually.'; } }
  function updateFont(event: Event, commit = false) { const input = event.currentTarget as HTMLInputElement, value = Number(input.value); if (value >= 10 && value <= 24) fontSize = value; else if (commit) { fontSize = Math.max(10, Math.min(24, value || 14)); input.value = String(fontSize); } }
  function numeric(field: 'lineHeight' | 'readingWidth' | 'sidebarWidth', event: Event, commit = false) {
    const ranges = { lineHeight: [1.3, 2.2], readingWidth: [480, 1200], sidebarWidth: [180, 420] };
    const input = event.currentTarget as HTMLInputElement, value = Number(input.value), [min, max] = ranges[field];
    if (Number.isFinite(value) && value >= min && value <= max) prefs[field] = field === 'lineHeight' ? Math.round(value * 10) / 10 : Math.round(value);
    else if (commit) { prefs[field] = Math.max(min, Math.min(max, value || DEFAULT_UI_PREFERENCES[field])); input.value = String(prefs[field]); }
  }
  function accent(event: Event) {
    accentDraft = (event.currentTarget as HTMLInputElement).value;
    if (/^#[\da-f]{6}$/iu.test(accentDraft)) { prefs.accentColor = accentDraft.toLowerCase(); appearanceError = ''; }
    else appearanceError = 'Use a six-digit hex color, such as #d8d8df.';
  }
  function resetAppearance() {
    theme = 'dark'; prefs.darkPreset = DEFAULT_UI_PREFERENCES.darkPreset; prefs.accentColor = DEFAULT_UI_PREFERENCES.accentColor;
    prefs.density = DEFAULT_UI_PREFERENCES.density; prefs.sidebarWidth = DEFAULT_UI_PREFERENCES.sidebarWidth;
    prefs.showStatusBar = DEFAULT_UI_PREFERENCES.showStatusBar; prefs.focusMode = false;
    accentDraft = prefs.accentColor; appearanceError = '';
  }
  function resetEditor() {
    fontSize = 14; wrap = true; layout = 'split';
    prefs.editorFont = DEFAULT_UI_PREFERENCES.editorFont; prefs.lineHeight = DEFAULT_UI_PREFERENCES.lineHeight;
    prefs.readingWidth = DEFAULT_UI_PREFERENCES.readingWidth; prefs.showLineNumbers = DEFAULT_UI_PREFERENCES.showLineNumbers;
  }
  function resetDrafts() { drafts = Object.fromEntries(COMMANDS.map((item) => [item.id, shortcutFor(item.id, shortcuts)])); }
  function commitShortcut(id: CommandId) {
    const value = drafts[id] ?? '', invalid = validateShortcut(id, value, shortcuts);
    if (invalid) { shortcutError = invalid; return; }
    const binding = normalizeShortcut(value)!;
    const next = { ...shortcuts };
    if (binding === COMMANDS.find((item) => item.id === id)!.defaultShortcut) delete next[id]; else next[id] = binding;
    shortcuts = next; drafts[id] = binding; shortcutError = '';
  }
  function capture(id: CommandId, event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); drafts[id] = shortcutFor(id, shortcuts); shortcutError = ''; (event.currentTarget as HTMLElement).blur(); return; }
    if (event.key === 'Enter') { event.preventDefault(); commitShortcut(id); (event.currentTarget as HTMLElement).blur(); return; }
    const value = shortcutFromEvent(event);
    if (value && ['Mod+A', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+Z', 'Mod+Shift+Z', 'Mod+Y'].includes(value)) return;
    if (value !== null) { event.preventDefault(); event.stopPropagation(); drafts[id] = value; commitShortcut(id); }
  }
  function resetShortcut(id: CommandId) {
    const next = { ...shortcuts }; delete next[id];
    const invalid = validateShortcut(id, shortcutFor(id, next), next);
    if (invalid) { shortcutError = invalid; return; }
    shortcuts = next; drafts[id] = shortcutFor(id, next); shortcutError = '';
  }
  function sectionKey(event: KeyboardEvent, index: number) {
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key)) return;
    event.preventDefault();
    const next = (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : sections.length - 1)) % sections.length;
    section = sections[next]; queueMicrotask(() => dialog.querySelector<HTMLElement>('[data-section="' + section + '"]')?.focus());
  }
  function trapFocus(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')).filter((element) => !element.hasAttribute('disabled') && element.tabIndex >= 0 && element.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); dialog.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  onMount(() => { accentDraft = prefs.accentColor; resetDrafts(); previousFocus = document.activeElement as HTMLElement; dialog.showModal(); dialog.querySelector<HTMLElement>('[data-section="Appearance"]')?.focus(); void refresh(); });
  onDestroy(() => { if (dialog?.open) dialog.close(); previousFocus?.focus(); });
</script>
<dialog class="settings-dialog settings-workbench" aria-label="Settings" bind:this={dialog} onkeydown={trapFocus} oncancel={(event) => { event.preventDefault(); close(); }}>
  <div class="settings-heading"><strong>Settings</strong><button aria-label="Close settings" onclick={close}>×</button></div>
  <div class="settings-body">
    <div class="settings-sections" role="tablist" aria-label="Settings sections" aria-orientation="vertical">{#each sections as item, index}<button role="tab" data-section={item} aria-selected={section === item} tabindex={section === item ? 0 : -1} onclick={() => section = item} onkeydown={(event) => sectionKey(event, index)}>{item}</button>{/each}</div>
    <div class="settings-content" role="tabpanel" aria-label={section} tabindex="-1">
      {#if section === 'Appearance'}
        <div class="settings-fields">
          <label>Theme<select aria-label="Theme" bind:value={theme}><option value="dark">Dark</option><option value="light">Light</option></select></label>
          <label>Dark preset<select aria-label="Dark preset" disabled={theme !== 'dark'} bind:value={prefs.darkPreset}><option value="midnight">Midnight</option><option value="charcoal">Charcoal</option></select></label>
          <label>Accent color<div class="accent-control"><input type="color" aria-label="Pick accent color" value={prefs.accentColor} oninput={(event) => { prefs.accentColor = event.currentTarget.value; accentDraft = prefs.accentColor; appearanceError = ''; }} /><input aria-label="Accent color" bind:value={accentDraft} oninput={accent} spellcheck="false" /></div></label>
          <label>Density<select aria-label="Density" bind:value={prefs.density}><option value="compact">Compact</option><option value="comfortable">Comfortable</option></select></label>
          <label>Sidebar width (px)<input type="number" aria-label="Sidebar width" min="180" max="420" step="10" value={prefs.sidebarWidth} oninput={(event) => numeric('sidebarWidth', event)} onchange={(event) => numeric('sidebarWidth', event, true)} /></label>
          <div class="settings-toggle-group"><label class="settings-checkbox"><input type="checkbox" bind:checked={prefs.showStatusBar} /> Show status bar</label>
          <label class="settings-checkbox"><input type="checkbox" bind:checked={prefs.focusMode} /> Focus mode</label></div>
        </div>
        {#if appearanceError}<div role="alert" class="script-error">{appearanceError}</div>{/if}
        <button class="settings-reset" onclick={resetAppearance}>Reset appearance</button>
      {:else if section === 'Editor'}
        <div class="settings-fields">
          <label>Editor font<select aria-label="Editor font" bind:value={prefs.editorFont}><option value="mono">Geist Mono</option><option value="sans">Geist</option></select></label>
          <label>Font size (px)<input aria-label="Font size" type="number" min="10" max="24" value={fontSize} oninput={updateFont} onchange={(event) => updateFont(event, true)} /></label>
          <label>Line height<input aria-label="Line height" type="number" min="1.3" max="2.2" step=".1" value={prefs.lineHeight} oninput={(event) => numeric('lineHeight', event)} onchange={(event) => numeric('lineHeight', event, true)} /></label>
          <label>Reading width (px)<input aria-label="Reading width" type="number" min="480" max="1200" step="20" value={prefs.readingWidth} oninput={(event) => numeric('readingWidth', event)} onchange={(event) => numeric('readingWidth', event, true)} /></label>
          <label>Layout<select aria-label="Layout" bind:value={layout}><option value="source">Source</option><option value="split">Split</option><option value="preview">Preview</option><option value="live">Live Preview</option></select></label>
          <div class="settings-toggle-group"><label class="settings-checkbox"><input type="checkbox" bind:checked={wrap} /> Word wrap</label>
          <label class="settings-checkbox"><input type="checkbox" bind:checked={prefs.showLineNumbers} /> Show line numbers</label></div>
        </div>
        <button class="settings-reset" onclick={resetEditor}>Reset editor</button>
      {:else if section === 'Shortcuts'}
        <p class="settings-help">Focus a field and press a shortcut, or type Ctrl/Cmd with a key. Clear a field to remove its app shortcut. Standard text-editing shortcuts still work in text fields. Desktop shortcuts may take precedence; change those in your system settings.</p>
        {#if shortcutError}<div class="script-error shortcut-error" role="alert">{shortcutError}</div>{/if}
        <input class="shortcut-search" type="search" aria-label="Search shortcuts" placeholder="Search commands or groups…" bind:value={shortcutQuery} />
        <div class="shortcut-list">{#each filteredCommands as item}<div class="shortcut-row"><label for={'shortcut-' + item.id}>{item.label}<span>{item.group}</span></label><input id={'shortcut-' + item.id} data-shortcut-capture aria-label={'Shortcut for ' + item.label} bind:value={drafts[item.id]} placeholder="Unassigned" spellcheck="false" onkeydown={(event) => capture(item.id, event)} onchange={() => commitShortcut(item.id)} /><button aria-label={'Reset shortcut: ' + item.label} title={'Default: ' + formatShortcut(item.defaultShortcut, mac)} onclick={() => resetShortcut(item.id)}>↺</button></div>{/each}{#if !filteredCommands.length}<p class="panel-note">No matching shortcuts.</p>{/if}</div>
        <button class="settings-reset" onclick={() => { shortcuts = {}; resetDrafts(); shortcutError = ''; }}>Reset shortcuts</button>
      {:else}
        <div class="settings-mcp"><h3>MCP for agents</h3><p class="panel-note">Read open documents and apply guarded, undoable edits. Agent edits stay in the editor until you save.</p><label class="settings-checkbox"><input type="checkbox" bind:checked={agentEditsEnabled} /> Agent edits enabled</label>
          {#if !nativeStore}<p class="panel-note">MCP connections require the desktop app.</p>{:else}<div class="panel-status" role="status">{status?.ready ? 'MCP ready' : status?.available ? 'MCP connecting…' : 'MCP unavailable'}</div>{#if command}<label>MCP command<input aria-label="MCP command" readonly value={command} /></label><button onclick={copy}>{copied ? 'Copied command' : 'Copy MCP command'}</button>{/if}{#if status?.socketPath}<div class="result-path">{status.socketPath}</div>{/if}<button onclick={refresh}>Refresh MCP status</button>{/if}
          {#if error || status?.error}<div class="script-error" role="alert">{error || status?.error}</div>{/if}
        </div>
      {/if}
    </div>
  </div>
</dialog>
