<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { nativeStore } from './store';
  import { DEFAULT_UI_PREFERENCES } from './preferences';
  import type { UIPreferences } from './preferences';
  import Icon from './Icon.svelte';
  import SegmentedControl from './SegmentedControl.svelte';
  import SelectControl from './SelectControl.svelte';
  import NumberControl from './NumberControl.svelte';
  import ThemeEditor from './ThemeEditor.svelte';
  import type { UserTheme } from './themes';
  import { COMMANDS, formatShortcut, normalizeShortcut, shortcutFor, shortcutFromEvent, validateShortcut } from './shortcuts';
  import type { CommandId, ShortcutOverrides } from './shortcuts';

  type Layout = 'split' | 'source' | 'preview' | 'live';
  type Section = 'Appearance' | 'Editor' | 'Shortcuts' | 'Agents';
  type AgentStatus = { available: boolean; ready: boolean; socketPath?: string; command?: string; args?: string[]; error?: string };
  let { builtInTheme = $bindable(), theme, fontSize = $bindable(), wrap = $bindable(), layout = $bindable(), prefs = $bindable(), shortcuts = $bindable(), agentEditsEnabled = $bindable(), close, onpreview, disableTheme, themeImportReset }: { builtInTheme: 'dark' | 'light'; theme: 'dark' | 'light'; fontSize: number; wrap: boolean; layout: Layout; prefs: UIPreferences; shortcuts: ShortcutOverrides; agentEditsEnabled: boolean; close: () => void; onpreview: (theme: UserTheme | null) => void; disableTheme: () => void; themeImportReset: { generation: number } } = $props();

  const sections: Section[] = ['Appearance', 'Editor', 'Shortcuts', 'Agents'];
  const themeOptions = [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }];
  const densityOptions = [{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }];
  const sidebarRailWidthOptions = [{ value: 'narrow', label: 'Narrow' }, { value: 'standard', label: 'Standard' }, { value: 'wide', label: 'Wide' }];
  const sidebarPositionOptions = [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }];
  const darkPresetOptions = [{ value: 'midnight', label: 'Midnight' }, { value: 'charcoal', label: 'Charcoal' }, { value: 'amoled', label: 'AMOLED' }, { value: 'forest', label: 'Forest' }, { value: 'dusk', label: 'Dusk' }];
  const lightPresetOptions = [{ value: 'default', label: 'Default' }, { value: 'paper', label: 'Paper' }];
  const editorFontOptions = [{ value: 'mono', label: 'IBM Plex Mono' }, { value: 'sans', label: 'Source Sans 3' }];
  const layoutOptions = [{ value: 'source', label: 'Source' }, { value: 'split', label: 'Split' }, { value: 'preview', label: 'Preview' }, { value: 'live', label: 'Live Preview' }];
  const toolPanelWidthPresets = [
    { value: '220', numeric: 220, label: 'Narrow', hint: '220 px' },
    { value: '260', numeric: 260, label: 'Standard', hint: '260 px' },
    { value: '340', numeric: 340, label: 'Wide', hint: '340 px' },
  ];
  const specimenLines = [
    '# Field notes',
    '',
    'Keep ideas close.',
    '',
    '- Observe',
    '- Connect',
  ];
  const mac = /Mac|iPhone|iPad/u.test(navigator.platform);
  let section = $state<Section>('Appearance');
  let status = $state<AgentStatus | null>(null);
  let refreshing = $state(false);
  let error = $state('');
  let copied = $state(false);
  let copyError = $state('');
  let shortcutError = $state(''), shortcutQuery = $state('');
  let filteredCommands = $derived(COMMANDS.filter((item) => (item.label + ' ' + item.group).toLowerCase().includes(shortcutQuery.trim().toLowerCase())));
  let drafts = $state<Record<string, string>>({});
  let dialog: HTMLDialogElement;
  let previousFocus: HTMLElement | null = null;
  let command = $derived(status?.command ? [status.command, ...(status.args ?? [])].map((part) => "'" + part.replaceAll("'", "'\\''") + "'").join(' ') : '');
  let agentError = $derived(error || status?.error || '');
  let agentState = $derived(refreshing ? 'checking' : agentError ? 'error' : status?.ready ? 'ready' : 'unavailable');
  let agentHeading = $derived(agentState === 'checking' ? 'Checking connection' : agentState === 'ready' ? 'MCP ready' : agentState === 'error' ? 'Connection error' : 'MCP unavailable');
  let agentDescription = $derived(agentState === 'checking'
    ? 'Reading the local MCP connection…'
    : agentState === 'ready'
      ? 'The local agent connection is ready.'
      : agentState === 'error'
        ? 'The last connection check failed. Review the details and try again.'
        : nativeStore
          ? 'The desktop MCP connection is not ready yet.'
          : 'MCP connections require the desktop app.');
  let specimenLayout = $derived(prefs.performanceMode ? 'source' : layout);
  let layoutLabel = $derived(layoutOptions.find((option) => option.value === specimenLayout)?.label ?? specimenLayout);
  let specimenStyle = $derived(`--specimen-font:${prefs.editorFont === 'sans' ? "'Source Sans 3', sans-serif" : "'IBM Plex Mono', monospace"};--specimen-size:${fontSize}px;--specimen-leading:${prefs.lineHeight};--specimen-width:${Math.max(40, Math.min(100, prefs.readingWidth / 12))}%`);

  function toolPanelWidthOptions(width: number) {
    const options: { value: string; label: string; hint?: string }[] = toolPanelWidthPresets.map(({ value, label, hint }) => ({ value, label, hint }));
    if (!toolPanelWidthPresets.some((preset) => preset.numeric === width)) options.unshift({ value: 'custom', label: `Custom (${width} px)` });
    return options;
  }
  function toolPanelWidthValue(width: number) {
    return toolPanelWidthPresets.some((preset) => preset.numeric === width) ? String(width) : 'custom';
  }
  function selectToolPanelWidth(value: string) {
    const preset = toolPanelWidthPresets.find((option) => option.value === value);
    if (preset) prefs.sidebarWidth = preset.numeric;
  }
  async function refresh() {
    if (!nativeStore || refreshing) return;
    refreshing = true;
    error = '';
    try {
      status = await invoke<AgentStatus>('agent_status');
      error = '';
    } catch (cause) {
      error = 'Could not read MCP connection: ' + String(cause);
    } finally {
      refreshing = false;
    }
  }
  async function copyCommand() {
    if (!command) return;
    copied = false;
    copyError = '';
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(command);
      copied = true;
    } catch {
      copyError = 'Could not copy automatically. Select the command and copy it manually.';
    }
  }
  $effect(() => {
    command;
    copied = false;
    copyError = '';
  });
  function resetAppearance() {
    disableTheme();
    builtInTheme = 'dark';
    prefs.darkPreset = DEFAULT_UI_PREFERENCES.darkPreset;
    prefs.lightPreset = DEFAULT_UI_PREFERENCES.lightPreset;
    prefs.density = DEFAULT_UI_PREFERENCES.density;
    prefs.sidebarWidth = DEFAULT_UI_PREFERENCES.sidebarWidth;
    prefs.sidebarRailWidth = DEFAULT_UI_PREFERENCES.sidebarRailWidth;
    prefs.sidebarPosition = DEFAULT_UI_PREFERENCES.sidebarPosition;
    prefs.showStatusBar = DEFAULT_UI_PREFERENCES.showStatusBar;
    prefs.focusMode = DEFAULT_UI_PREFERENCES.focusMode;
  }
  function resetEditor() {
    fontSize = 14; wrap = true; layout = 'split';
    prefs.editorFont = DEFAULT_UI_PREFERENCES.editorFont; prefs.lineHeight = DEFAULT_UI_PREFERENCES.lineHeight;
    prefs.tabSize = DEFAULT_UI_PREFERENCES.tabSize; prefs.indentWithTabs = DEFAULT_UI_PREFERENCES.indentWithTabs; prefs.languageIntelligenceEnabled = DEFAULT_UI_PREFERENCES.languageIntelligenceEnabled;
    prefs.readingWidth = DEFAULT_UI_PREFERENCES.readingWidth; prefs.showLineNumbers = DEFAULT_UI_PREFERENCES.showLineNumbers;
    prefs.smoothScrolling = DEFAULT_UI_PREFERENCES.smoothScrolling;
    prefs.performanceMode = DEFAULT_UI_PREFERENCES.performanceMode;
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
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, a[href], [tabindex]')).filter((element) => !element.hasAttribute('disabled') && element.tabIndex >= 0 && element.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); dialog.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  onMount(() => { resetDrafts(); previousFocus = document.activeElement as HTMLElement; dialog.showModal(); dialog.querySelector<HTMLElement>('[data-section="Appearance"]')?.focus(); void refresh(); });
  onDestroy(() => {
    if (dialog?.open) dialog.close();
    if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus();
    else document.querySelector<HTMLElement>('.commands-trigger')?.focus();
  });
</script>

<dialog class="settings-dialog settings-workbench" aria-label="Settings" bind:this={dialog} onkeydown={trapFocus} oncancel={(event) => { event.preventDefault(); close(); }}>
  <div class="settings-heading"><strong>Settings</strong><button type="button" class="settings-close" aria-label="Close settings" onclick={close}><Icon name="close" size={14} {theme} /></button></div>
  <div class="settings-body">
    <div class="settings-sections" role="tablist" aria-label="Settings sections" aria-orientation="vertical">{#each sections as item, index}<button type="button" role="tab" data-section={item} aria-selected={section === item} tabindex={section === item ? 0 : -1} onclick={() => section = item} onkeydown={(event) => sectionKey(event, index)}>{item}</button>{/each}</div>
    <div class="settings-content" class:settings-shortcuts={section === 'Shortcuts'} class:settings-editor={section === 'Editor'} role="tabpanel" aria-label={section} tabindex="-1">
      {#if section === 'Appearance'}
        <div class="settings-intro"><strong>Make room for your thoughts.</strong><p>A quiet workspace, adjusted to you.</p></div>
        <div class="settings-fields">
          <SegmentedControl label="Theme" options={themeOptions} value={builtInTheme} onchange={(value) => builtInTheme = value as 'dark' | 'light'} />
          {#if builtInTheme === 'dark'}
            <SelectControl label="Dark preset" options={darkPresetOptions} value={prefs.darkPreset} onchange={(value) => prefs.darkPreset = value as UIPreferences['darkPreset']} {theme} />
          {:else}
            <SelectControl label="Light preset" options={lightPresetOptions} value={prefs.lightPreset} onchange={(value) => prefs.lightPreset = value as UIPreferences['lightPreset']} {theme} />
          {/if}
          <SegmentedControl label="Density" options={densityOptions} value={prefs.density} onchange={(value) => prefs.density = value as UIPreferences['density']} />
          <SegmentedControl label="Sidebar position" options={sidebarPositionOptions} value={prefs.sidebarPosition} onchange={(value) => prefs.sidebarPosition = value as UIPreferences['sidebarPosition']} />
          <SelectControl label="Sidebar width" options={sidebarRailWidthOptions} value={prefs.sidebarRailWidth} onchange={(value) => prefs.sidebarRailWidth = value as UIPreferences['sidebarRailWidth']} {theme} />
          <SelectControl label="Tool panel width" options={toolPanelWidthOptions(prefs.sidebarWidth)} value={toolPanelWidthValue(prefs.sidebarWidth)} onchange={selectToolPanelWidth} {theme} />
          <div class="settings-toggle-group">
            <label class="settings-checkbox"><input type="checkbox" bind:checked={prefs.showStatusBar} /><span class="settings-checkbox-mark" aria-hidden="true"><Icon name="checkbox-check" size={12} {theme} /></span> Show status bar</label>
            <label class="settings-checkbox"><input type="checkbox" bind:checked={prefs.focusMode} /><span class="settings-checkbox-mark" aria-hidden="true"><Icon name="checkbox-check" size={12} {theme} /></span> Focus mode</label>
          </div>
        </div>
        <ThemeEditor bind:prefs base={`${builtInTheme}/${builtInTheme === 'dark' ? prefs.darkPreset : prefs.lightPreset}`} {onpreview} disable={disableTheme} {themeImportReset} />
        <button type="button" class="settings-reset" onclick={resetAppearance}>Reset appearance</button>
      {:else if section === 'Editor'}
        <div class="settings-editor-controls">
        <div class="settings-intro"><strong>Shape your writing space.</strong><p>Typography and layout, with a live specimen.</p></div>
        <label class="settings-checkbox"><input type="checkbox" bind:checked={prefs.performanceMode} /><span class="settings-checkbox-mark" aria-hidden="true"><Icon name="checkbox-check" size={12} {theme} /></span> Performance mode</label>
        <p class="settings-help">For low-memory PCs: source-only editing, with syntax parsing, language intelligence and smooth scrolling paused. Your usual settings and undo history are preserved. Turn off to restore rendered views.</p>
        <div class="settings-fields">
          <SelectControl label="Editor font" options={editorFontOptions} value={prefs.editorFont} onchange={(value) => prefs.editorFont = value as UIPreferences['editorFont']} {theme} />
          <NumberControl label="Font size" bind:value={fontSize} min={10} max={24} step={1} defaultValue={14} unit="px" />
          <NumberControl label="Line height" bind:value={prefs.lineHeight} min={1.3} max={2.2} step={0.1} precision={1} defaultValue={DEFAULT_UI_PREFERENCES.lineHeight} sliderStep={0.1} />
          <NumberControl label="Indent size" bind:value={prefs.tabSize} min={1} max={8} step={1} defaultValue={DEFAULT_UI_PREFERENCES.tabSize} />
          <label class="settings-checkbox"><input type="checkbox" bind:checked={prefs.indentWithTabs} /><span class="settings-checkbox-mark" aria-hidden="true"><Icon name="checkbox-check" size={12} {theme} /></span> Indent with tabs</label>
          <label class="settings-checkbox"><input type="checkbox" bind:checked={prefs.languageIntelligenceEnabled} disabled={prefs.performanceMode} /><span class="settings-checkbox-mark" aria-hidden="true"><Icon name="checkbox-check" size={12} {theme} /></span> Language intelligence</label>
          <p class="settings-help">Off by default. Install the optional TypeScript / Svelte language pack or Rust tooling first, then enable intelligence. Syntax highlighting works without it.</p>
          <details class="language-setup"><summary>Set up language tools</summary><p>From the Notation source checkout, run <code>npm run desktop:languages</code> to install the optional TypeScript / Svelte pack. This is a separate download, stored in your Notation data directory.</p><p>For Rust, install <code>rust-analyzer</code> and <code>rustfmt</code> with your Rust toolchain. After installation, turn intelligence on. No tools are downloaded automatically.</p></details>
          <NumberControl label="Reading width" bind:value={prefs.readingWidth} min={480} max={1200} step={10} sliderStep={1} defaultValue={DEFAULT_UI_PREFERENCES.readingWidth} unit="px" />
          <SelectControl label="Layout" options={layoutOptions} disabled={prefs.performanceMode} value={prefs.performanceMode ? 'source' : layout} onchange={(value) => layout = value as Layout} {theme} />
          <div class="settings-toggle-group">
            <label class="settings-checkbox"><input type="checkbox" bind:checked={wrap} /><span class="settings-checkbox-mark" aria-hidden="true"><Icon name="checkbox-check" size={12} {theme} /></span> Word wrap</label>
            <label class="settings-checkbox"><input type="checkbox" bind:checked={prefs.showLineNumbers} /><span class="settings-checkbox-mark" aria-hidden="true"><Icon name="checkbox-check" size={12} {theme} /></span> Show line numbers</label>
          </div>
          <label class="settings-checkbox"><input type="checkbox" bind:checked={prefs.smoothScrolling} disabled={prefs.performanceMode} /><span class="settings-checkbox-mark" aria-hidden="true"><Icon name="checkbox-check" size={12} {theme} /></span> Smooth scrolling</label>
        </div>

        <p class="settings-help settings-scroll-help">Smooth mouse-wheel scrolling in documents and panels. Turn off for immediate scrolling. Your system’s reduced-motion preference takes priority.</p>
        <button type="button" class="settings-reset" onclick={resetEditor}>Reset editor</button>
        </div>
        <section class="settings-preview-card" aria-label="Editor preview" style={specimenStyle}>
          <div class="settings-preview-heading"><strong>Preview</strong><span>{layoutLabel} · {fontSize} px · {prefs.lineHeight}×</span></div>
          <div class="settings-specimen-stage" data-layout={specimenLayout} data-wrap={wrap}>
            <div class="settings-specimen-page">
              {#if specimenLayout !== 'preview'}
                <div class="settings-specimen-editor" class:with-line-numbers={prefs.showLineNumbers}>
                  {#each specimenLines as line, index}
                    <div class="settings-specimen-line">
                      {#if prefs.showLineNumbers}<span class="settings-specimen-line-number" aria-hidden="true">{index + 1}</span>{/if}
                      <span class="settings-specimen-text">{line || ' '}</span>
                    </div>
                  {/each}
                </div>
              {/if}
              {#if specimenLayout === 'preview' || specimenLayout === 'split'}
                <div class="settings-specimen-reading"><strong>A quieter place to write</strong><p>Thoughts become clear when the workspace gets out of the way.</p><span>Draft with intention.</span></div>
              {/if}
            </div>
          </div>
          <div class="settings-preview-meta"><span>{prefs.readingWidth} px reading width</span><span>{wrap ? 'Wrap on' : 'Wrap off'} · {prefs.showLineNumbers ? 'Line numbers on' : 'Line numbers off'}</span></div>
        </section>
      {:else if section === 'Shortcuts'}
        <p class="settings-help">Focus a field and press a shortcut, or type Ctrl/Cmd with a key. Clear a field to remove its app shortcut. Standard text-editing shortcuts still work in text fields. Desktop shortcuts may take precedence; change those in your system settings.</p>
        {#if shortcutError}<div class="script-error shortcut-error" role="alert">{shortcutError}</div>{/if}
        <input class="shortcut-search" type="search" aria-label="Search shortcuts" placeholder="Search commands or groups…" bind:value={shortcutQuery} />
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable list needs keyboard access.) -->
        <div class="shortcut-list" role="region" aria-label="Keyboard shortcuts" tabindex="0">{#each filteredCommands as item}<div class="shortcut-row"><label for={'shortcut-' + item.id}>{item.label}<span>{item.group}</span></label><input id={'shortcut-' + item.id} data-shortcut-capture aria-label={'Shortcut for ' + item.label} bind:value={drafts[item.id]} placeholder="Unassigned" spellcheck="false" onkeydown={(event) => capture(item.id, event)} onchange={() => commitShortcut(item.id)} /><button type="button" aria-label={'Reset shortcut: ' + item.label} title={'Default: ' + formatShortcut(item.defaultShortcut, mac)} onclick={() => resetShortcut(item.id)}>↺</button></div>{/each}{#if !filteredCommands.length}<p class="panel-note">No matching shortcuts.</p>{/if}</div>
        <button type="button" class="settings-reset" onclick={() => { shortcuts = {}; resetDrafts(); shortcutError = ''; }}>Reset shortcuts</button>
      {:else}
        <div class="settings-intro"><strong>Connect your agents.</strong><p>Read open documents and apply guarded, undoable edits. Agent edits stay in the editor until you save.</p></div>
        <div class="settings-mcp">
          <section class="agent-status-card" data-state={agentState} aria-label="MCP connection status">
            <div class="agent-status-copy" role="status" aria-live="polite"><span class="agent-status-dot" aria-hidden="true"></span><div><strong>{agentHeading}</strong><p>{agentDescription}</p></div></div>
            <button type="button" class="agent-refresh" disabled={!nativeStore || refreshing} onclick={refresh}>{refreshing ? 'Checking…' : 'Refresh MCP status'}</button>
          </section>
          <section class="agent-permission-card" aria-label="Agent editing permission">
            <div><strong>Editing permission</strong><p>Choose whether connected agents may apply guarded edits.</p></div>
            <label class="settings-checkbox"><input type="checkbox" bind:checked={agentEditsEnabled} /><span class="settings-checkbox-mark" aria-hidden="true"><Icon name="checkbox-check" size={12} {theme} /></span> Agent edits enabled</label>
          </section>
          {#if command}
            <div class="agent-command-block">
              <label for="agent-mcp-command">MCP command</label>
              <textarea id="agent-mcp-command" class="agent-command" aria-label="MCP command" readonly value={command} rows={4} spellcheck="false" wrap="soft"></textarea>
              <div class="agent-command-actions"><button type="button" onclick={copyCommand}>{copied ? 'Copied command' : 'Copy MCP command'}</button>{#if copied}<span class="agent-copy-success" role="status">Command copied to clipboard.</span>{/if}</div>
              {#if copyError}<p class="script-error" role="alert">{copyError}</p>{/if}
            </div>
          {/if}
          {#if status?.socketPath}
            <details class="agent-socket"><summary>Socket details</summary><code>{status.socketPath}</code></details>
          {/if}
          {#if agentError && !refreshing}<div class="script-error" role="alert">{agentError}</div>{/if}
        </div>
      {/if}
    </div>
  </div>
</dialog>
