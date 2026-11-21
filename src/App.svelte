<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { ask, open, save } from '@tauri-apps/plugin-dialog';
  import { HEMINGWAY_MESSAGE, hemingwayCommandBlocked } from './hemingway';
  import { documentCounts } from './document-counts';
  import { detectLanguage, documentFileName, languageOptions } from './code-languages';
  import type { IntelligenceState } from './language-intelligence';
  import { configureLanguageIntelligence } from './intelligence-loader';
  import DocumentLanguage from './DocumentLanguage.svelte';
  import FileNavigator from './FileNavigator.svelte';
  import DiskConflict from './DiskConflict.svelte';
  import Editor from './Editor.svelte';
  import Preview from './Preview.svelte';
  import { reducedFormatting } from './reduced-formatting';
  import Scripts from './Scripts.svelte';
  import Workspace from './Workspace.svelte';
  import History from './History.svelte';
  import Templates from './Templates.svelte';
  import Canvas from './Canvas.svelte';
  import { newCanvas as emptyCanvas } from './canvas';
  import { renderMarkdown } from './render-markdown';
  import { renderContent } from './render-content';
  import Export from './Export.svelte';
  import { parseFrontmatter } from './frontmatter';
  import { CellSession } from './cells';
  import SmartTable from './SmartTable.svelte';
  import Graph from './Graph.svelte';
  import StickyNotes from './StickyNotes.svelte';
  import { referenceContent, scanBlockReferences } from './block-references';
  import type { EmbedDocument } from './render-content';
  import Properties from './Properties.svelte';
  import WikiChooser from './WikiChooser.svelte';
  import { findWikiHeadingLine, parseWikiLink, scanWikiHeadings } from './wiki-links';
  import type { WikiCompletion } from './wiki-links';
  import type { WikiCandidate, WikiResolution } from './wiki-navigation';
  import Explorer from './Explorer.svelte';
  import Sidebar from './Sidebar.svelte';
  import Git from './Git.svelte';
  import Settings from './Settings.svelte';
  import { compileThemeCSS } from './themes';
  import type { UserTheme } from './themes';
  import Tabs from './Tabs.svelte';
  import CloseRecovery from './CloseRecovery.svelte';
  import CommandPalette from './CommandPalette.svelte';
  import CompactMenu from './CompactMenu.svelte';
  import Icon from './Icon.svelte';
  import RenameDocument from './RenameDocument.svelte';
  import { migrateSettings, preferencesStyle, readUIPreferences, UI_SETTINGS_VERSION } from './preferences';
  import { smoothScrolling } from './smooth-scroll';
  import { presentWindow } from './window-chrome';
  import { fadeOnChange, pop, publishMotionPreference } from './motion';
  import { setDefaultMathMode } from './math-syntax';
  import WorkspaceSwitcher from './WorkspaceSwitcher.svelte';
  import { isMac } from './platform';
  import { COMMANDS, commandForEvent, formatShortcut, menuAccelerator, readShortcutOverrides, shortcutFor } from './shortcuts';
  import type { CommandId } from './shortcuts';
  import type { CommandItem } from './ui-commands';
  import { createTab, restoreTabs, serializeTab, tabDirty } from './documents';
  import type { DocumentTab } from './documents';
  import { captureWorkspaceView, emptyCatalog, restoreWorkspaceView, restoreWorkspaceViews, workspaceKey } from './workspaces';
  import type { WorkspaceCatalog, WorkspaceView } from './workspaces';
  import { writeStorage } from './storage';
  import type { BlockAction } from './editor-commands';
  import type { TaskToggle } from './markdown-features';
  import type { ScriptDocument } from './script-runner';
  import { currentMetadata, dismissRecovery, flushPersistence, nativeStore, observePersistence, persistMetadata, retryPersistence } from './store';
  import type { PersistenceStatus } from './store';

  const fence = String.fromCharCode(96).repeat(3);
  const sample = '# Welcome to Notation\n\nA small space for Markdown and Mermaid. Write on the left, see it on the right.\n\n## Follow an idea\n\n' + fence + 'mermaid\nflowchart LR\n  A[An idea] --> B[Make a note]\n  B --> C[Connect the dots]\n' + fence + '\n\n- Open a .md or .mmd file\n- Use **Ctrl/Cmd + S** to save\n- Use **Ctrl/Cmd + F** to find in your source\n';
  type Layout = 'split' | 'source' | 'preview' | 'live';
  type Panel = 'explorer' | 'workspace' | 'git' | 'history' | 'scripts' | 'properties' | 'graph' | 'stickies' | 'table' | 'export' | 'templates' | null;
  let stickyCreateRequest = $state(0);
  type DocumentResult = { path: string; content: string; warning?: string };
  type LaunchRequest = { id: string; paths: string[] };
  const MAX_LAUNCH_FILES = 64, MAX_LAUNCH_QUEUE = 16, MAX_LAUNCH_DEDUP = 128;
  // Consume startup buffers once. Keeping the bootstrap snapshot in component
  // props would retain every restored document even after its tab was closed.
  let { tabs: startingTabs, ...initial } = untrack(() => {
    const metadata = currentMetadata();
    const restored = restoreTabs(metadata.session, metadata.draft, sample);
    const view = restoreWorkspaceView(metadata.session?.workspaceViews?.[workspaceKey(metadata.workspaceCatalog?.activeId ?? null)], restored.tabs,
      ['source', 'preview', 'live'].includes(String(metadata.settings.layout)) ? metadata.settings.layout as Layout : 'split');
    return {
      tabs: restored.tabs, tabIds: restored.tabs.map(tab => tab.id), activeId: restored.activeTabId, view, settings: metadata.settings,
      catalog: metadata.workspaceCatalog ?? emptyCatalog(),
      workspaceViews: restoreWorkspaceViews(metadata.session?.workspaceViews, restored.tabs),
      recovered: !!(metadata.session || metadata.draft),
    };
  });
  const preferences = initial.settings;
  let documents = $state<DocumentTab[]>(startingTabs);
  startingTabs = [];
  let catalog = $state<WorkspaceCatalog>(initial.catalog);
  let workspaceViews = $state<Record<string, WorkspaceView>>(initial.workspaceViews);
  const initialView = initial.view;
  let visibleIds = $state(initialView?.tabIds ?? initial.tabIds);
  let activeId = $state(initialView?.activeTabId ?? initial.activeId);
  let visibleDocuments = $derived(visibleIds.map(id => documents.find(tab => tab.id === id)).filter((tab): tab is DocumentTab => !!tab));
  let activeWorkspace = $derived(catalog.workspaces.find(workspace => workspace.id === catalog.activeId));
  let workspaceBusy = $state(false);
  const cellSessions=new Map<string,CellSession>();
  function cellsFor(tab:DocumentTab){let session=cellSessions.get(tab.id);if(!session){session=new CellSession();if(detectLanguage(tab.name,tab.language)==='markdown')session.update(tab.content,tab.name,tab.path);cellSessions.set(tab.id,session);}return session;}
  $effect(()=>{const ids=new Set(documents.map(tab=>tab.id));for(const tab of documents)if(detectLanguage(tab.name,tab.language)==='markdown')cellsFor(tab).update(tab.content,tab.name,tab.path);for(const [id,session] of cellSessions)if(!ids.has(id)){session.dispose();cellSessions.delete(id);}});
  let active = $derived(documents.find((document) => document.id === activeId) ?? documents[0]);
  let editors = $state<Record<string, Editor | undefined>>({});
  let editor = $derived(editors[activeId]);
  let preview = $state<Preview>();
  // Persist the built-in choice separately; every renderer gets the effective
  // base mode of the active saved theme or temporary preview.
  let builtInTheme = $state<'dark' | 'light'>(preferences.theme === 'light' ? 'light' : 'dark');
  let fontSize = $state(Math.max(10, Math.min(24, Number(preferences.fontSize) || 14)));
  let wrap = $state(preferences.wrap !== false);
  let layout = $state<Layout>(initialView?.layout ?? (['source', 'preview', 'live'].includes(String(preferences.layout)) ? preferences.layout as Layout : 'split'));
  let agentEditsEnabled = $state(preferences.agentEditsEnabled !== false);
  let ui = $state(readUIPreferences(migrateSettings(preferences)));
  let scriptsEnabled = $derived(ui.scriptsEnabled === true);
  let themePreview = $state<UserTheme | null>(null);
  // Mutable signal: recovery invalidates pending reads synchronously, even
  // while Settings and its draft remain mounted (no reactive effect needed).
  const themeImportReset = { generation: 0 };
  let customTheme = $derived.by(() => {
    const candidate = themePreview ?? ui.userThemes.find(item => item.id === ui.selectedThemeId);
    if (!candidate) return null;
    try { return { ...candidate, compiled: compileThemeCSS(candidate.css) }; } catch { return null; }
  });
  let theme = $derived<'dark' | 'light'>(customTheme ? customTheme.base.startsWith('light/') ? 'light' : 'dark' : builtInTheme);
  function disableCustomTheme() { themeImportReset.generation++; themePreview = null; ui.selectedThemeId = ''; }
  $effect(() => {
    if (!customTheme) return;
    const style = document.createElement('style');
    style.dataset.userTheme = customTheme.id;
    style.textContent = customTheme.compiled;
    document.head.append(style);
    return () => style.remove();
  });
  let shortcuts = $state(readShortcutOverrides(preferences.shortcuts));
  let panel = $state<Panel>(null);
  let settingsOpen = $state(false);
  let languageTarget = $state<string | null>(null);
  let wikiChoice = $state<{ resolution: WikiResolution; sourceId: string; sourcePath?: string | null; ticket: number } | null>(null);
  let wikiBusy = $state(false);
  let wikiSerial = 0;
  let paletteOpen = $state(false), appMenuOpen = $state(false), layoutMenuOpen = $state(false);
  let paletteScope = $state<'all' | 'blocks'>('all');
  let intelligenceStates = $state<Record<string, IntelligenceState>>({});
  let symbolTarget = $state<string | null>(null);
  let fileNavigator = $state<'files' | 'search' | null>(null);
  let diskConflicts = $state<Record<string, string>>({});
  $effect(() => {
    const ids = new Set(documents.map(tab => tab.id));
    untrack(() => {
      for (const id of Object.keys(editors)) if (!ids.has(id)) delete editors[id];
      for (const id of Object.keys(intelligenceStates)) if (!ids.has(id)) delete intelligenceStates[id];
      for (const id of Object.keys(diskConflicts)) if (!ids.has(id)) delete diskConflicts[id];
    });
  });
  let comparingDisk = $state<string | null>(null);
  let diskTarget = $derived(documents.find(tab => tab.id === comparingDisk));
  let renameId = $state<string | null>(null);
  let renameTarget = $derived(documents.find((tab) => tab.id === renameId));
  let status = $state(initial.recovered ? 'Restored your previous work' : 'Ready');
  // Classify before mounting Preview; editor reports retain threshold hysteresis.
  let formattingReduced = $state<Record<string, boolean>>({});
  $effect(() => { const ids = new Set(documents.map(tab => tab.id)); untrack(() => { for (const id of Object.keys(formattingReduced)) if (!ids.has(id)) delete formattingReduced[id]; }); });
  let error = $state('');
  let busy = $state(false);
  const launchRequests: LaunchRequest[] = [], launchOrder: string[] = [];
  const launchSeen = new Set<string>(), launchHandled = new Set<string>();
  let launchWorker: Promise<void> | null = null, launchDisposed = false;
  let closingWindow = $state(false);
  let closeRecoveryDecision = $state<((discard: boolean) => void) | null>(null);
  let discardDecisions = 0;
  let persistence = $state<PersistenceStatus>({ state: 'idle', error: '' });
  let fileInput: HTMLInputElement;
  const desktop = isTauri();
  let gitContext = $state<{ path: string; root: string } | null>(null);
  let gitRefresh = $state(0);
  let gitRoot = $derived(nativeStore && desktop && active.path === gitContext?.path ? gitContext.root : null);
  $effect(() => {
    const path = active.path;
    gitRefresh;
    let cancelled = false;
    // Keep an already-open panel while rechecking the same file on focus.
    if (untrack(() => gitContext?.path) !== path) gitContext = null;
    if (nativeStore && desktop && path) {
      void invoke<string | null>('git_repository', { documentPath: path }).then(root => {
        if (!cancelled) gitContext = root ? { path, root } : null;
      }).catch(() => { if (!cancelled) gitContext = null; });
    }
    return () => { cancelled = true; };
  });
  $effect(() => { if (!gitRoot && panel === 'git') panel = null; });
  let dirty = $derived(tabDirty(active));
  let saveState = $derived(persistence.state === 'error' ? 'error' : dirty ? 'dirty' : 'saved');
  let canvasDocument = $derived(active.name.toLowerCase().endsWith('.canvas'));
  let activeLanguage = $derived(detectLanguage(active.name, active.language));
  let codeDocument = $derived(!canvasDocument && activeLanguage !== 'markdown');
  let intelligenceEnabled = $derived(ui.languageIntelligenceEnabled && !ui.performanceMode);
  let reducedDocument = $derived(!canvasDocument && !codeDocument && !active.hemingway && !ui.performanceMode && (formattingReduced[activeId] || reducedFormatting(active.content).reduced));
  let effectiveLayout = $derived(codeDocument || ui.performanceMode || reducedDocument ? 'source' : layout);
  let canvasVisible = $derived(canvasDocument && !ui.performanceMode && !active.hemingway && layout !== 'source');
  let standalone = $derived(active.name.toLowerCase().endsWith('.mmd'));
  let counts = $derived(documentCounts(active.content));
  let lineCount = $derived(counts.lines);
  let wordCount = $derived(counts.words);
  const mac = isMac;
  let commandItems = $derived<CommandItem[]>(COMMANDS.map((command) => ({
    ...command,
    ...(command.id === 'panel.scripts' && !scriptsEnabled ? { label: 'Scripts (enable in Settings → Editor)' } : {}),
    shortcut: formatShortcut(shortcutFor(command.id, shortcuts), mac),
    disabled: (command.id === 'panel.git' && !gitRoot) || (command.id === 'panel.scripts' && !scriptsEnabled) || (ui.performanceMode && ['view.split','view.preview','view.live'].includes(command.id)) || (command.id === 'view.language' && canvasDocument) || (!intelligenceEnabled && ['code.definition','code.references','code.rename','code.format'].includes(command.id)) || (codeDocument && (command.id.startsWith('block.') || command.id.startsWith('insert.') || ['panel.properties','panel.templates','panel.table','panel.export','view.split','view.preview','view.live'].includes(command.id))) || (active.hemingway && hemingwayCommandBlocked(command.id)) || ((busy || workspaceBusy) && ['file.new', 'file.newCanvas', 'file.open', 'file.save', 'file.saveAs', 'tab.close'].includes(command.id)) || (canvasDocument && (['panel.properties','panel.table','panel.templates','panel.export','block.actions'].includes(command.id) || command.id.startsWith('block.') || command.id.startsWith('fold.') || command.id.startsWith('insert.'))),
    checked: command.id.startsWith('view.') ? command.id === 'view.hemingway' ? active.hemingway : command.id === 'view.focus' ? ui.focusMode : !active.hemingway && command.id === 'view.' + effectiveLayout : command.id.startsWith('panel.') ? panel === command.id.slice(6) && !ui.focusMode : undefined,
  })));
  let layoutItems = $derived(codeDocument ? commandItems.filter(command => command.id === 'view.source') : active.hemingway ? commandItems.filter(command => command.id === 'view.hemingway') : canvasDocument
    ? commandItems.filter(command => ['view.source', 'view.preview'].includes(command.id)).map(command => ({ ...command, label: command.id === 'view.preview' ? 'Canvas' : 'Source', checked: command.id === (canvasVisible ? 'view.preview' : 'view.source') }))
    : commandItems.filter(command => ['view.source', 'view.split', 'view.preview', 'view.live'].includes(command.id)));
  let paletteItems = $derived(paletteScope === 'blocks' ? commandItems.filter((command) => command.group === 'Blocks' && command.id !== 'block.actions') : commandItems);
  const sidebarCommands: CommandId[] = ['panel.explorer', 'panel.workspace', 'panel.graph', 'panel.stickies', 'panel.git', 'panel.history', 'panel.properties', 'panel.templates', 'panel.table', 'panel.scripts'];
  let sidebarItems = $derived(sidebarCommands.filter(id => (id !== 'panel.scripts' || scriptsEnabled) && (id !== 'panel.git' || !!gitRoot)).map(id => commandItems.find(item => item.id === id)!));
  let visiblePanel = $derived(panel !== null && !ui.focusMode && (panel !== 'git' || !!gitRoot) && (panel !== 'scripts' || scriptsEnabled) && (!['properties', 'templates', 'export', 'table'].includes(panel) || (!canvasDocument && !codeDocument && !active.hemingway)));
  let appMenuItems = $derived(['Document', 'Application'].flatMap(group => commandItems.filter(command => command.group === group)));

  $effect(() => {
    if (!scriptsEnabled && panel === 'scripts') panel = null;
  });
  // Canvas cards, embeds and exports read the default where no view passes it.
  $effect.pre(() => setDefaultMathMode(ui.mathSyntax));
  $effect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.darkPreset = customTheme && theme === 'dark' ? customTheme.base.split('/')[1] : ui.darkPreset;
    document.documentElement.dataset.lightPreset = customTheme && theme === 'light' ? customTheme.base.split('/')[1] : ui.lightPreset;
    document.documentElement.dataset.density = ui.density;
    // Shows the (initially hidden) desktop window once this theme is applied,
    // and keeps the native window background in step with later theme changes.
    void customTheme; presentWindow(theme);
    publishMotionPreference(ui.reduceMotion || ui.performanceMode);
  });
  $effect(() => {
    persistMetadata({ settings: { uiSettingsVersion: UI_SETTINGS_VERSION, theme: builtInTheme, fontSize, wrap, layout, agentEditsEnabled, ...ui, shortcuts } });
  });
  $effect(() => {
    document.title = (dirty ? '• ' : '') + active.name + ' — Notation';
    persistMetadata({ draft: serializeTab(active) });
  });
  $effect(() => {
    persistMetadata({ session: { activeTabId: activeId, tabs: documents.map(serializeTab), updatedAt: Date.now(), activeWorkspaceId: catalog.activeId, workspaceViews: { ...workspaceViews, [workspaceKey(catalog.activeId)]: captureWorkspaceView(documents, visibleIds, activeId, layout) } } });
  });

  // Keep the reading position across view modes: take the source line at the
  // top of the outgoing view before the DOM changes, then put that line at
  // the top of whichever panes the new mode shows.
  let anchoredLayout: Layout | undefined, anchoredTab = '';
  $effect.pre(() => {
    const next = effectiveLayout, tab = activeId;
    untrack(() => {
      if (anchoredLayout !== undefined && tab === anchoredTab && next !== anchoredLayout && !canvasDocument) {
        const line = anchoredLayout === 'preview' ? preview?.topLine() ?? null : editors[tab]?.topLine() ?? null;
        if (line !== null) void tick().then(() => {
          if (activeId !== tab || effectiveLayout !== next) return;
          if (next !== 'source' && next !== 'live') preview?.scrollToLine(line);
          // After the editor has been shown again and re-measured.
          if (next !== 'preview') requestAnimationFrame(() => { if (activeId === tab && effectiveLayout === next) editors[tab]?.scrollToLine(line); });
        });
      }
      anchoredLayout = next; anchoredTab = tab;
    });
  });

  async function readDiskFile(path: string) { return (await invoke<DocumentResult>('read_document_snapshot', { path })).content; }
  async function readCodeFile(path: string) { return documents.find(tab=>tab.path===path || tab.id===path)?.content ?? await readDiskFile(path); }
  configureLanguageIntelligence({
    read: readCodeFile,
    display: async path => { const tab = await openTab(path); if (!tab) return null; await tick(); return editors[tab.id]?.getView() ?? null; },
    views: () => new Map(documents.flatMap(tab => { const view=editors[tab.id]?.getView(); return tab.path && view ? [[tab.path,view] as const] : []; })),
    editable: path => documents.some(tab=>tab.path===path && !tab.hemingway),
    error: message => { error = message; },
  });
  // One read at a time, with a single coalesced follow-up. Only the active
  // saved document is polled; focus checks still detect conflicts when off.
  let diskGeneration = 0, diskReading = false, diskQueued = false, diskDisposed = false;
  let diskTimer: ReturnType<typeof setTimeout> | undefined;
  // The file state seen at the last full read that found the disk equal to
  // the tab's saved content. While the file's fingerprint (size, modification
  // time, identity) still equals it, the content is not read again.
  type DiskFingerprint = { size: string; modifiedNs: string; device: string; inode: string };
  let diskKnown: { path: string; baseline: string; print: string; settled: boolean } | undefined;
  async function diskFingerprint(path: string) {
    try {
      const value = await invoke<DiskFingerprint | null>('document_fingerprint', { path });
      if (!value || typeof value.modifiedNs !== 'string' || typeof value.size !== 'string') return null;
      // A rewrite within the filesystem's timestamp granularity can keep the
      // same size and time. Trust a fingerprint only once it is two seconds old.
      const settled = Date.now() - Number(BigInt(value.modifiedNs) / 1_000_000n) >= 2000;
      return { print: [value.size, value.modifiedNs, value.device, value.inode].join(':'), settled };
    } catch { return null; }
  }
  function invalidateDiskCheck() {
    diskGeneration++;
    clearTimeout(diskTimer); diskTimer = undefined;
  }
  function scheduleDiskCheck() {
    clearTimeout(diskTimer); diskTimer = undefined;
    if (!diskDisposed && desktop && ui.automaticallyReloadExternalChanges && !busy && !workspaceBusy && !closingWindow) {
      diskTimer = setTimeout(() => { diskTimer = undefined; void checkDisk(); }, 750);
    }
  }
  async function checkDisk(tab: DocumentTab = active) {
    if (diskDisposed || !desktop || tab !== active) return;
    if (diskReading) { diskQueued = true; return; }
    const path = tab.path;
    // Restored metadata is untrusted. Drafts and malformed paths are not files.
    if (typeof path !== 'string' || path.includes('\0') || !(/^(?:\/|[a-z]:[\\/])/iu.test(path))) return;
    if (busy || workspaceBusy || closingWindow) return;
    clearTimeout(diskTimer); diskTimer = undefined;
    diskReading = true;
    const generation = diskGeneration, lifetime = tab.lifetime;
    const content = tab.content, baseline = tab.savedContent, name = tab.name, savedName = tab.savedName;
    const autoReload = ui.automaticallyReloadExternalChanges;
    const current = () => !diskDisposed && generation === diskGeneration && activeId === tab.id
      && documents.find(item => item.id === tab.id) === tab && tab.lifetime === lifetime && tab.path === path
      && tab.content === content && tab.savedContent === baseline && tab.name === name && tab.savedName === savedName
      && !busy && !workspaceBusy && !closingWindow;
    try {
      const seen = await diskFingerprint(path);
      if (!current()) return;
      if (seen && diskKnown && diskKnown.settled && diskKnown.path === path && diskKnown.baseline === baseline && diskKnown.print === seen.print) return;
      const disk = await readDiskFile(path);
      if (!current()) return;
      // Remember the state only when taken before the read and unchanged by it.
      diskKnown = seen && disk === baseline ? { path, baseline, ...seen } : undefined;
      if (disk === baseline) { delete diskConflicts[tab.id]; return; }
      if (autoReload && ui.automaticallyReloadExternalChanges && !tabDirty(tab) && !tab.hemingway && discardDecisions === 0) {
        const target = editors[tab.id], selection = { ...tab.selection };
        // Apply through the existing editor so history/residency stay intact.
        // The editor clamps raw selection offsets to the new document length.
        if (target?.apply(disk, content, 'input.external')) {
          tab.savedContent = disk; tab.updatedAt = Date.now();
          target.restoreSelection(selection);
          delete diskConflicts[tab.id];
          status = 'Reloaded ' + tab.name + ' from disk';
          return;
        }
      }
      diskConflicts[tab.id] = 'This file changed on disk. Your unsaved edits are preserved.';
    } catch (cause) {
      if (current()) diskConflicts[tab.id] = 'File unavailable on disk: ' + String(cause);
    } finally {
      diskReading = false;
      if (diskQueued && !diskDisposed) { diskQueued = false; void checkDisk(); }
      else scheduleDiskCheck();
    }
  }
  $effect(() => {
    // Deliberately exclude content and diskConflicts from reactive dependencies.
    // Editor mutations invalidate synchronously through onChange below.
    activeId; active.lifetime; active.path; active.hemingway;
    ui.automaticallyReloadExternalChanges; busy; workspaceBusy; closingWindow;
    untrack(() => { invalidateDiskCheck(); void checkDisk(); });
  });
  onMount(() => {
    const focus = () => { gitRefresh++; void checkDisk(); };
    window.addEventListener('focus', focus);
    return () => {
      diskDisposed = true; diskQueued = false; invalidateDiskCheck();
      window.removeEventListener('focus', focus);
    };
  });

  function selectTab(id: string) {
    if (!documents.some((tab) => tab.id === id)) return;
    if (!visibleIds.includes(id)) visibleIds = [...visibleIds, id];
    if (activeId !== id) invalidateDiskCheck();
    activeId = id;
  }
  async function canDiscard(tab: DocumentTab) {
    if (!tabDirty(tab)) return true;
    const message = 'Close ' + tab.name + ' and discard unsaved changes?';
    discardDecisions++;
    try { return desktop ? await ask(message, { title: 'Unsaved changes', kind: 'warning', okLabel: 'Discard', cancelLabel: 'Cancel' }) : window.confirm(message); }
    finally { discardDecisions--; }
  }
  async function closeTab(id: string) {
    if (busy || workspaceBusy) return;
    const previousControl = document.activeElement;
    const tab = documents.find(item => item.id === id);
    const shared = Object.entries(workspaceViews).some(([key, view]) => key !== workspaceKey(catalog.activeId) && view.tabIds.includes(id));
    if (!tab) return;
    if (shared && visibleIds.length === 1 && documents.length >= 64) { error = 'Close another tab before closing the last view of this shared file (64-tab limit).'; return; }
    invalidateDiskCheck();
    if (!shared && !await canDiscard(tab)) { scheduleDiskCheck(); return; }
    const index = visibleIds.indexOf(id);
    visibleIds = visibleIds.filter(value => value !== id);
    if (!shared) documents = documents.filter(item => item.id !== id);
    if (!visibleIds.length) { const blank = createTab(); documents.push(blank); visibleIds = [blank.id]; }
    if (activeId === id) activeId = visibleIds[Math.max(0, Math.min(index - 1, visibleIds.length - 1))];
    scheduleDiskCheck();
    await tick();
    // A closed tab stays in the DOM, inert, while it animates out.
    // The browser may not have moved focus off it yet.
    if (previousControl instanceof HTMLElement && (!previousControl.isConnected || previousControl.closest('[inert]')) && (document.activeElement === document.body || document.activeElement === previousControl)) {
      document.querySelector<HTMLElement>('.document-tab.active [role="tab"]')?.focus();
    }
    await flushPersistence();
  }
  async function workspaceAction(command: string, args: Record<string, unknown> = {}) {
    if (workspaceBusy || busy) throw new Error('Another operation is in progress.');
    if (documents.length >= 64 && (command === 'create_workspace' || (command === 'select_workspace' && !workspaceViews[workspaceKey(String(args.id))]))) throw new Error('Close an unused tab before opening a new workspace (64-tab limit).');
    invalidateDiskCheck();
    workspaceBusy = true;
    workspaceViews[workspaceKey(catalog.activeId)] = captureWorkspaceView(documents, visibleIds, activeId, layout);
    try {
      await tick(); if (!await flushPersistence()) throw new Error('Unsaved changes could not be saved before switching workspaces. Try saving, then switch again.');
      let next: WorkspaceCatalog;
      if (desktop) next = await invoke<WorkspaceCatalog>(command, args);
      else {
        next = { activeId: catalog.activeId, workspaces: catalog.workspaces.map(workspace => ({ ...workspace, files: [...workspace.files] })) };
        if (command === 'create_workspace') {
          const item = { id: crypto.randomUUID(), name: String(args.name).trim(), files: [], legacyRoot: null };
          if (!item.name) throw new Error('Enter a workspace name.');
          next.workspaces.push(item); next.activeId = item.id;
        } else if (command === 'select_workspace') next.activeId = String(args.id);
        else if (command === 'rename_workspace') { const item = next.workspaces.find(item => item.id === args.id); if (item) item.name = String(args.name).trim(); }
        else if (command === 'delete_workspace') { next.workspaces = next.workspaces.filter(item => item.id !== args.id); if (next.activeId === args.id) next.activeId = next.workspaces[0]?.id ?? null; }
        else throw new Error('File references require the desktop app.');
        if (!writeStorage('notation.workspaces', next)) throw new Error('Could not save workspaces.');
      }
      if (desktop && next.activeId) await invoke('index_workspace').catch(cause => { error = 'Workspace selected; indexing failed: ' + String(cause); });
      workspaceViews[workspaceKey(catalog.activeId)] = captureWorkspaceView(documents, visibleIds, activeId, layout);
      if (next.activeId !== catalog.activeId) {
        const previousId = catalog.activeId;
        const view = restoreWorkspaceView(workspaceViews[workspaceKey(next.activeId)] ?? (previousId === null ? workspaceViews[workspaceKey(null)] : undefined), documents, layout);
        if (previousId === null && next.activeId !== null) delete workspaceViews[workspaceKey(null)];
        if (view) {
          visibleIds = view.tabIds; activeId = view.activeTabId; layout = view.layout;
          for (const tab of documents) if (view.selections[tab.id]) tab.selection = { ...view.selections[tab.id] };
        } else {
          if (documents.length < 64) { const blank = createTab(); documents.push(blank); visibleIds = [blank.id]; activeId = blank.id; }
          else visibleIds = [activeId];
        }
        catalog = next;
        wikiChoice = null; wikiSerial++;
        await tick();
        for (const id of visibleIds) if (view?.selections[id]) editors[id]?.restoreSelection(view.selections[id]);
      } else catalog = next;
      // Retain deleted-workspace buffers as recoverable tabs instead of discarding unsaved work.
      if (command === 'delete_workspace') {
        const removed = workspaceViews[workspaceKey(String(args.id))];
        if (removed) visibleIds = [...new Set([...visibleIds, ...removed.tabIds.filter(id => documents.some(tab => tab.id === id))])];
        delete workspaceViews[workspaceKey(String(args.id))];
      }
      status = activeWorkspace ? 'Workspace: ' + activeWorkspace.name : 'Personal tabs';
      await tick(); if (!await flushPersistence()) error = 'Workspace switched, but some changes could not be saved.';
    } finally { workspaceBusy = false; }
  }
  async function chooseWorkspace(id: string) {
    if (id === catalog.activeId) return;
    try { await workspaceAction('select_workspace', { id }); }
    catch (cause) { error = 'Could not switch workspace: ' + String(cause); }
  }
  function newCanvasDocument(){if(busy||workspaceBusy)return;if(documents.length>=64){error='Close a tab before opening another document (64-tab limit).';return;}const tab=createTab({name:'untitled.canvas',content:emptyCanvas(),savedContent:''});documents.push(tab);selectTab(tab.id);layout='live';error='';status='New canvas';}
  function writingLocked() { if (!active.hemingway) return false; error = HEMINGWAY_MESSAGE; return true; }
  function applyTemplate(text:string,source:{text:string;documentId:number}){return !writingLocked() && source.documentId===active.lifetime&&(editor?.apply(text,source.text,'input.template')??false);}
  function applyCanvas(text:string,source:{text:string;documentId:number}){return !writingLocked() && source.documentId===active.lifetime&&(editor?.apply(text,source.text,'input.canvas')??false);}
  async function renderCanvasCard(host:HTMLElement,markdown:string,sourcePath?:string,current=()=>host.isConnected){await renderContent(host,renderMarkdown(markdown),{theme,folds:new Map(),current,toggle:()=>false,edit:()=>{},loadEmbed:loadEmbedded,sourcePath,openWiki:(target,path)=>void openWiki(target,activeId,path),openPath:path=>void openPath(path)});}
  function newDocument() {
    if (busy || workspaceBusy) return;
    if (documents.length >= 64) { error = 'Close a tab before opening another document (64-tab limit).'; return; }
    const tab = createTab();
    documents.push(tab); selectTab(tab.id); error = ''; status = 'New document';
  }
  function receiveDocument(result: DocumentResult, browser = false): DocumentTab {
    const key = browser ? 'browser:' + result.path : result.path;
    const existing = documents.find((tab) => browser ? tab.openKey === key : tab.path === result.path);
    if (existing) { selectTab(existing.id); status = 'Switched to ' + existing.name; error = result.warning || ''; return existing; }
    if (documents.length >= 64) throw new Error('Close a tab before opening another document (64-tab limit).');
    if (new TextEncoder().encode(result.content).length > 4 * 1024 * 1024) throw new Error('This document exceeds the 4 MiB editor limit.');
    const tab = createTab({ name: result.path.split(/[\\/]/u).pop() || 'untitled.md', path: browser ? null : result.path, content: result.content, openKey: browser ? key : undefined });
    documents.push(tab); selectTab(tab.id);
    status = 'Opened ' + tab.name; error = result.warning || '';
    return tab;
  }
  async function openPath(selected: string, line?: number, expiresAt?: number, launched = false): Promise<boolean> {
    return await openTab(selected, line, expiresAt, launched) !== null;
  }
  /**
   * Open `selected` and return its tab. The backend answers under the file's
   * canonical path (symbolic links resolved; on a case-insensitive volume the
   * stored letter case), which need not be the spelling that was asked for,
   * so callers must use the returned tab rather than look it up by `selected`.
   */
  async function openTab(selected: string, line?: number, expiresAt?: number, launched = false): Promise<DocumentTab | null> {
    if (busy || workspaceBusy) return null;
    const existing = documents.find((tab) => tab.path === selected);
    if (existing) { selectTab(existing.id); if (line) { layout = 'source'; await tick(); editors[existing.id]?.revealLine(line); } return existing; }
    invalidateDiskCheck();
    busy = true; error = '';
    try {
      const result = await invoke<DocumentResult>(launched ? 'read_launch_document' : 'read_document', { path: selected });
      if (expiresAt !== undefined && Date.now() >= expiresAt) throw new Error('Agent request expired before the document opened.');
      const tab = receiveDocument(result);
      if (line) { layout = 'source'; await tick(); editors[tab.id]?.revealLine(line); }
      return tab;
    } catch (cause) { error = 'Could not open document: ' + String(cause); return null; }
    finally { busy = false; }
  }
  function queueLaunchRequest(request: LaunchRequest) {
    if (launchDisposed) return;
    if (!request || typeof request.id !== 'string' || !Array.isArray(request.paths) || !request.paths.length || request.paths.length > MAX_LAUNCH_FILES || request.paths.some(path => typeof path !== 'string')) {
      error = 'Received a malformed file launch request.'; return;
    }
    if (launchSeen.has(request.id)) return;
    // Native admission bounds this queue to 16. Keep a defensive UI bound too;
    // an overflow is explicitly surfaced and completed, never silently dropped.
    if (launchRequests.length >= MAX_LAUNCH_QUEUE) {
      error = 'Too many documents are waiting to open. Retry the launch after the queue drains.';
      void invoke('complete_launch_request', { id: request.id }).catch(() => {});
      return;
    }
    launchSeen.add(request.id); launchOrder.push(request.id);
    if (launchOrder.length > MAX_LAUNCH_DEDUP) {
      const expired = launchOrder.shift()!;
      launchSeen.delete(expired); launchHandled.delete(expired);
    }
    launchRequests.push(request);
    void drainLaunchRequests();
  }
  function launchDelay(milliseconds: number) { return new Promise<void>(resolve => setTimeout(resolve, milliseconds)); }
  async function waitForLaunchWindow() {
    // Polling occurs only while a real launch waits for an operation or user
    // decision. An orderly close closes native admission, then lets this worker
    // finish already-accepted requests before persistence and window destruction.
    while (!launchDisposed && (busy || workspaceBusy || discardDecisions > 0)) await launchDelay(50);
    return !launchDisposed;
  }
  function appendLaunchError(message: string) { error = error ? error + '\n' + message : message; }
  async function drainLaunchRequests() {
    if (launchWorker || launchDisposed || !launchRequests.length) return;
    launchWorker = (async () => {
      while (launchRequests.length && !launchDisposed) {
        const request = launchRequests[0];
        if (!launchHandled.has(request.id)) {
          for (const path of request.paths) {
            let finished = false;
            while (!finished && !launchDisposed) {
              if (!await waitForLaunchWindow()) return;
              // Preserve earlier alerts across every request, not just one drain
              // batch, while capturing this path's result independently.
              const previousError = error;
              error = '';
              const opened = await openPath(path, undefined, undefined, true);
              const outcomeError = error;
              error = [previousError, outcomeError].filter(Boolean).join('\n');
              if (opened || outcomeError) finished = true;
              else {
                // A user operation won the race after the idle wait. Retry the
                // same path rather than treating busyness as an open failure.
                await launchDelay(25);
              }
            }
          }
          if (launchDisposed) return;
          launchHandled.add(request.id);
        }
        try {
          // Completion means every path was attempted and failures were shown;
          // it is deliberately distinct from the native "accepted" socket ACK.
          await invoke('complete_launch_request', { id: request.id });
          launchRequests.shift();
        } catch (cause) {
          appendLaunchError('Could not finish the file launch handoff; it will be retried. ' + String(cause));
          await launchDelay(100);
        }
      }
    })().catch(async (cause) => {
      appendLaunchError('File launch processing failed; the request will be retried. ' + String(cause));
      await launchDelay(100);
    }).finally(() => {
      launchWorker = null;
      if (launchRequests.length && !launchDisposed) void drainLaunchRequests();
    });
  }
  async function drainLaunchesForClose() {
    // Once native admission is closed, this fixed set cannot grow. Reconcile
    // snapshots as well as events so even a missed warm emission cannot strand
    // accepted work when the last window is destroyed.
    while (!launchDisposed) {
      const pending = await invoke<LaunchRequest[]>('launch_ready', { ready: true });
      for (const request of pending) queueLaunchRequest(request);
      void drainLaunchRequests();
      if (!pending.length && !launchRequests.length && !launchWorker) return;
      await launchDelay(25);
    }
  }
  async function openDocument() {
    if (busy || workspaceBusy) return;
    if (!desktop) { fileInput.value = ''; fileInput.click(); return; }
    try {
      const selected = await open({ multiple: false, directory: false, filters: [{ name: 'Text and code', extensions: ['md', 'markdown', 'mmd', 'canvas', 'txt', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'svelte', 'rs', 'json', 'html', 'css', 'py', 'yaml', 'yml', 'toml'] }, { name: 'All files', extensions: ['*'] }] });
      if (typeof selected === 'string') await openPath(selected);
    } catch (cause) { error = 'Could not open document: ' + String(cause); }
  }
  async function importFile(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    invalidateDiskCheck();
    busy = true;
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('Document exceeds the 4 MiB editor limit.');
      const content = new TextDecoder('utf-8', {fatal:true}).decode(await file.arrayBuffer());
      if (content.includes('\0')) throw new Error('Choose a UTF-8 text file, not a binary file.');
      receiveDocument({ path: file.name, content }, true);
    }
    catch (cause) { error = 'Could not open document: ' + String(cause); }
    finally { busy = false; }
  }
  function usableName(name: string) { return documentFileName(name, activeLanguage === 'markdown'); }
  async function saveDocument(saveAs = false) {
    if (busy || workspaceBusy) return;
    const tab = active, saveContent = tab.content, originalName = tab.name, saveName = usableName(tab.name);
    invalidateDiskCheck();
    busy = true; error = '';
    try {
      if (desktop) {
        let destination = tab.path;
        if (!destination || saveAs || tab.name !== tab.savedName) destination = await save({ defaultPath: tab.path && tab.name === tab.savedName ? tab.path : saveName, filters: [{ name: 'All files', extensions: ['*'] }] });
        if (!destination) return;
        const identity = await invoke<{ path: string }>('resolve_document_path', { path: destination });
        if (documents.some((item) => item.id !== tab.id && item.path === identity.path)) throw new Error('This file is already open in another tab. Switch to that tab or choose a different filename.');
        const result = await invoke<DocumentResult>(identity.path === tab.path ? 'write_document_checked' : 'write_document', { path: destination, content: saveContent, expectedContent: tab.savedContent });
        delete diskConflicts[tab.id];
        tab.path = identity.path;
        const actualName = result.path.split(/[\\/]/u).pop() || saveName;
        if (tab.name === originalName) tab.name = actualName;
        tab.savedName = actualName; error = result.warning || '';
      } else {
        const url = URL.createObjectURL(new Blob([saveContent], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = saveName; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        if (tab.name === originalName) tab.name = saveName;
        tab.savedName = saveName;
      }
      tab.savedContent = saveContent; tab.updatedAt = Date.now();
      status = (desktop ? 'Saved ' : 'Downloaded ') + tab.savedName;
      await tick(); await flushPersistence();
    } catch (cause) { error = 'Could not save document: ' + String(cause); void checkDisk(tab); }
    finally { busy = false; }
  }
  function togglePanel(value: Exclude<Panel, null>) { panel = panel === value ? null : value; }
  function openWorkspacePanel() { appMenuOpen = false; layoutMenuOpen = false; ui.focusMode = false; panel = 'workspace'; }
  function togglePreviewTask(request: TaskToggle) { return editor?.toggle(request) ?? false; }
  function insertPreviewSqlTable(request: { connection: string; sql: string; occurrence: number; markdown: string; snapshot: string }) { return editor?.insertSqlTable(request) ?? false; }
  async function editSource(from: number) { layout = 'live'; await tick(); editor?.reveal(from); }
  function scriptSnapshot() { return { document: { name: active.name, path: active.path, ...editor!.snapshot() }, documentId: active.lifetime }; }
  function applyScript(text: string, source: { document: ScriptDocument; documentId: number }) { return !writingLocked() && source.documentId === active.lifetime && (editor?.apply(text, source.document.text) ?? false); }
  function historySnapshot() { return { text: editor?.snapshot().text ?? active.content, documentId: active.lifetime }; }
  function restoreRevision(text: string, source: { text: string; documentId: number }) { return !writingLocked() && source.documentId === active.lifetime && (editor?.apply(text, source.text) ?? false); }
  function editProperties(id: string) { if (!documents.some((tab) => tab.id === id)) return; selectTab(id); ui.focusMode = false; panel = 'properties'; }
  function applyTable(text: string, source: {text:string;documentId:number}) { return !writingLocked() && source.documentId===active.lifetime && (editor?.apply(text,source.text,'input.table')??false); }
  function applyProperties(text: string, source: { text: string; documentId: number }) { return !writingLocked() && source.documentId === active.lifetime && (editor?.apply(text, source.text, 'input.properties') ?? false); }
  async function candidatesFor(tabId: string, context: WikiCompletion): Promise<WikiCandidate[]> {
    const source = documents.find((tab) => tab.id === tabId);
    if (!source) return [];
    if (context.kind === 'heading' && !context.note) return [{ path: source.path || '', name: source.name, title: source.name, relativePath: source.name, link: '', aliases: [], headings: referenceTargets(source.content) }];
    if (desktop) {
      const results = await invoke<WikiCandidate[]>('wiki_candidates', { query: context.kind === 'heading' ? context.note : context.query, sourcePath: source.path, limit: 50 });
      return results.map((note) => { const open = documents.find((tab) => tab.path === note.path); return open ? { ...note, headings: referenceTargets(open.content) } : { ...note, headings: [...note.headings, ...(note.blocks ?? []).map(block => ({text:'^'+block.id,line:block.line,level:0}))] }; });
    }
    return documents.filter((tab) => !tab.name.endsWith('.mmd') && tab.name.toLowerCase().includes((context.kind === 'heading' ? context.note : context.query).toLowerCase())).map((tab) => ({ path: tab.path || tab.id, name: tab.name, title: tab.name.replace(/\.md$/iu, ''), relativePath: tab.name, link: tab.name.replace(/\.md$/iu, ''), aliases: [], headings: referenceTargets(tab.content) }));
  }
  async function canvasNoteCandidates(query: string) {
    const needle = query.trim().toLowerCase().slice(0, 200);
    const found = new Map<string, { file: string; name: string; title: string; detail: string }>();
    for (const tab of documents) {
      if (tab.name.toLowerCase().endsWith('.canvas')) continue;
      const title = tab.name.replace(/\.(?:md|markdown)$/iu, '');
      if (needle && !tab.name.toLowerCase().includes(needle) && !title.toLowerCase().includes(needle)) continue;
      // Browser tabs have no native path. Desktop workspace notes come from the index below,
      // which provides the workspace-relative path required by Canvas file nodes.
      if (desktop) continue;
      found.set(tab.name, { file: tab.name, name: tab.name, title, detail: 'Open tab' });
    }
    if (desktop) {
      const notes = await invoke<WikiCandidate[]>('wiki_candidates', { query: needle, sourcePath: null, limit: 50 });
      for (const note of notes) {
        const file = (note.relativePath || '').trim();
        if (!file || found.has(file)) continue;
        found.set(file, { file, name: note.name || file, title: note.title || note.name || file, detail: 'Workspace note' });
      }
    }
    return [...found.values()].slice(0, 50);
  }
  async function jumpToWiki(tab: DocumentTab, heading: string | null) {
    selectTab(tab.id);
    if (!heading) { await tick(); if (layout !== 'preview') editors[tab.id]?.focus(); return; }
    const line = findWikiHeadingLine(tab.content, heading);
    if (line === null) { status = 'Heading not found: ' + heading; return; }
    if (layout === 'preview') layout = 'live';
    await tick(); editors[tab.id]?.revealLine(line);
  }
  function wikiHandler(id: string) { return (target: string, path?: string) => void openWiki(target, id, path); }
  function referenceTargets(text: string) { return [...scanWikiHeadings(text), ...scanBlockReferences(text).map(block=>({text:'^'+block.id,line:block.line,level:0}))]; }
  async function loadEmbedded(target: string, relativePath?: string): Promise<EmbedDocument> {
    const link = parseWikiLink('[[' + target + ']]'); if (!link) throw new Error('Invalid embed target.');
    const matching = documents.find(tab=>tab.path===relativePath||tab.id===relativePath), source = matching ?? active;
    let tab = !link.note ? (relativePath ? matching : source) : undefined, path = tab?.path ?? tab?.id ?? relativePath ?? '';
    if (desktop && link.note) {
      const resolution = await invoke<WikiResolution>('resolve_wiki_link',{target,sourcePath:relativePath === '' ? null : relativePath && !documents.some(tab=>tab.id===relativePath) ? relativePath : source.path});
      if (resolution.status !== 'resolved' || !resolution.path) throw new Error(resolution.status === 'ambiguous' ? 'Ambiguous embed. Use a folder-qualified note path.' : 'Embedded note not found: ' + link.note);
      path = resolution.path; tab = documents.find(note=>note.path===path);
    } else if (link.note) {
      const matches = documents.filter(note=>note.name===link.note||note.name.replace(/\.md$/iu,'')===link.note);
      if (matches.length!==1) throw new Error('Open exactly one matching note to preview this embed in the browser.');
      tab=matches[0];path=tab.path??tab.id;
    }
    const full = tab?.content ?? (await invoke<DocumentResult>('read_workspace_note',{path})).content;
    const fragment = referenceContent(full,link.heading);
    return {path,fullContent:full,content:fragment.text,label:link.label,key:path+'#'+(link.heading??''),variables:parseFrontmatter(full)?.values??{}};
  }
  function propertiesHandler(id: string) { return () => editProperties(id); }
  async function openWiki(target: string, sourceId: string, relativePath?: string) {
    const source = documents.find((tab) => tab.id === sourceId);
    if (!source || wikiBusy) return;
    const ticket = ++wikiSerial; wikiChoice = null; wikiBusy = true; error = '';
    try {
      const link = parseWikiLink('[[' + target + ']]');
      if (!link) throw new Error('Invalid wiki link.');
      if (!link.note) { const targetTab = relativePath ? documents.find(tab => tab.path === relativePath || tab.id === relativePath) : source; if (targetTab) { await jumpToWiki(targetTab, link.heading); return; } if (relativePath && await openPath(relativePath)) { const opened = documents.find(tab=>tab.path===relativePath); if (opened) await jumpToWiki(opened,link.heading); } return; }
      if (!desktop) {
        const matches = documents.filter((tab) => tab.name === link.note || tab.name.replace(/\.md$/iu, '') === link.note);
        if (matches.length === 1) { await jumpToWiki(matches[0], link.heading); return; }
        if (matches.length > 1) throw new Error('Multiple open tabs match [[' + link.note + ']]. Close the duplicate tab before following this link.');
        throw new Error('No open tab matches [[' + link.note + ']]. Opening or creating workspace notes requires the desktop app. Open the target file to navigate between browser tabs.');
      }
      const resolution = await invoke<WikiResolution>('resolve_wiki_link', { target, sourcePath: relativePath === '' ? null : relativePath && !documents.some(tab=>tab.id===relativePath) ? relativePath : source.path });
      if (ticket !== wikiSerial || !documents.some((tab) => tab.id === sourceId)) return;
      if (resolution.status === 'resolved' && resolution.path) {
        const tab = await openTab(resolution.path); if (tab) await jumpToWiki(tab, resolution.heading);
      } else wikiChoice = { resolution, sourceId, sourcePath: relativePath === '' ? null : relativePath && !documents.some(tab=>tab.id===relativePath) ? relativePath : source.path, ticket };
    } catch (cause) { if (ticket === wikiSerial) error = 'Could not follow wiki link: ' + String(cause); }
    finally { if (ticket === wikiSerial) wikiBusy = false; }
  }
  async function chooseWiki(path?: string) {
    const choice = wikiChoice;
    if (!choice || wikiBusy) return;
    const source = documents.find((tab) => tab.id === choice.sourceId);
    if (!source) { wikiChoice = null; error = 'The source tab was closed. Follow the link again.'; return; }
    wikiBusy = true; error = '';
    try {
      let tab: DocumentTab | undefined;
      if (path) tab = await openTab(path) ?? undefined;
      else {
        const result = await invoke<DocumentResult>('create_wiki_note', { target: choice.resolution.target, sourcePath: choice.sourcePath !== undefined ? choice.sourcePath : source.path, content: '' });
        if (choice.ticket !== wikiSerial || !documents.some((item) => item.id === source.id)) return;
        tab = receiveDocument(result);
      }
      if (tab && choice.ticket === wikiSerial) { wikiChoice = null; await jumpToWiki(tab, choice.resolution.heading); }
    } catch (cause) { error = 'Could not open or create note: ' + String(cause); }
    finally { wikiBusy = false; }
  }
  function blockAction(action: BlockAction) { if (!editor?.act(action)) status = 'This action is unavailable for the selected block'; }
  async function recoverDraft() {
    const cached = persistence.recovery?.draft;
    if (!cached) return;
    const old = documents.find((tab) => tab.id === cached.id);
    if (old && !await canDiscard(old)) return;
    const recoveredTab = createTab(cached);
    if (old) documents = documents.map((tab) => tab.id === old.id ? recoveredTab : tab);
    else documents.push(recoveredTab);
    selectTab(recoveredTab.id);
    status = 'Document restored from backup'; await tick(); await flushPersistence();
  }
  async function recoverSession() {
    const cached = persistence.recovery?.session;
    if (!cached) return;
    for (const tab of documents) if (!await canDiscard(tab)) return;
    const state = restoreTabs(cached, null, sample);
    documents = state.tabs; workspaceViews = restoreWorkspaceViews(cached?.workspaceViews, state.tabs); visibleIds = state.tabs.map(tab => tab.id); activeId = state.activeTabId; status = 'Tabs restored from backup';
    await tick(); await flushPersistence();
  }
  async function recoverScript() {
    const cached = persistence.recovery?.scriptDraft;
    if (!cached) return;
    if (!scriptsEnabled) { status = 'Enable scripts in Settings → Editor to restore these edits.'; return; }
    persistMetadata({ scriptDraft: cached, settings: { activeScriptId: cached.id || null } });
    status = 'Script edits restored from backup';
    panel = null; await tick();
    if (!scriptsEnabled) return;
    panel = 'scripts'; await flushPersistence();
  }
  async function runCommand(id: CommandId) {
    paletteOpen = false; appMenuOpen = false; layoutMenuOpen = false;
    if (id === 'panel.git' && !gitRoot) { status = 'Git is available only for a saved file in a Git worktree.'; return; }
    if (id === 'app.commands') { await tick(); paletteScope = 'all'; paletteOpen = true; return; }
    if (id === 'panel.scripts' && !scriptsEnabled) { status = 'Enable scripts in Settings → Editor to use the Scripts panel.'; return; }
    if (id === 'sticky.new') { ui.focusMode = false; stickyCreateRequest++; panel = 'stickies'; return; }
    if (ui.performanceMode && ['view.split','view.preview','view.live'].includes(id)) { status = 'Turn off Performance mode in Settings → Editor to use rendered views.'; return; }
    if (id === 'view.language') { if (!canvasDocument) languageTarget = activeId; return; }
    if (id === 'view.zoomIn' || id === 'view.zoomOut' || id === 'view.zoomReset') {
      fontSize = id === 'view.zoomReset' ? 14 : Math.max(10, Math.min(24, fontSize + (id === 'view.zoomIn' ? 1 : -1)));
      status = 'Font size ' + fontSize + 'px';
      return;
    }
    if (id === 'view.hemingway') { invalidateDiskCheck(); const tab = active; tab.hemingway = !tab.hemingway; tab.updatedAt = Date.now(); if (tab.hemingway) void cellsFor(tab).stop(); status = tab.hemingway ? 'Hemingway mode on — deletion blocked' : 'Hemingway mode off'; error = ''; await tick(); editors[tab.id]?.focus(); return; }
    if (active.hemingway && hemingwayCommandBlocked(id)) { error = HEMINGWAY_MESSAGE; return; }
    if (id === 'code.quickOpen' || id === 'code.search') { fileNavigator = id === 'code.search' ? 'search' : 'files'; return; }
    if (id.startsWith('code.')) {
      if (id !== 'code.comment' && !intelligenceEnabled) { status = 'Enable language intelligence in Settings → Editor after installing its tools.'; return; }
      if (active.hemingway) { error = HEMINGWAY_MESSAGE; return; }
      try {
        if (id === 'code.rename') symbolTarget = activeId;
        else if (id === 'code.format') { await editor?.format(); status = 'Document formatted'; }
        else if (id === 'code.comment') editor?.comment();
        else await editor?.codeAction(id === 'code.definition' ? 'definition' : 'references');
      } catch (cause) { error = String(cause); }
      return;
    }
    if (id === 'app.settings') { settingsOpen = true; return; }
    if (id === 'file.rename') { renameId = activeId; return; }
    if (id === 'file.newCanvas') { newCanvasDocument(); return; }
    if (id === 'file.new') { newDocument(); await tick(); editor?.focus(); return; }
    if (id === 'file.open') { await openDocument(); return; }
    if (id === 'file.save' || id === 'file.saveAs') { await saveDocument(id === 'file.saveAs'); return; }
    if (id === 'tab.close') { await closeTab(activeId); await tick(); editor?.focus(); return; }
    if (id === 'tab.next' || id === 'tab.previous') {
      const index = visibleDocuments.findIndex((tab) => tab.id === activeId);
      selectTab(visibleDocuments[(index + (id === 'tab.next' ? 1 : visibleDocuments.length - 1)) % visibleDocuments.length].id); await tick(); editor?.focus(); return;
    }
    if (canvasDocument && (['panel.properties','panel.table','panel.templates','panel.export'].includes(id) || id.startsWith('block.') || id.startsWith('fold.') || id.startsWith('insert.'))) { status='This command applies to Markdown notes.'; return; }
    if (codeDocument && (id.startsWith('block.') || id.startsWith('insert.') || ['panel.properties','panel.table','panel.templates','panel.export','view.split','view.preview','view.live'].includes(id))) { status = 'This command applies to Markdown notes.'; return; }
    if (id.startsWith('insert.')) { if(layout==='preview')layout='live';await tick();editor?.insert(id.slice(7));return; }
    if (id.startsWith('panel.')) { ui.focusMode = false; togglePanel(id.slice(6) as Exclude<Panel, null>); return; }
    if (id === 'view.focus') { ui.focusMode = !ui.focusMode; await tick(); editor?.focus(); return; }
    if (id.startsWith('view.')) { layout = id.slice(5) as Layout; return; }
    if (id.startsWith('fold.')) { if (layout === 'preview') layout = 'source'; await tick(); const actions = { 'fold.block': 'Fold block', 'fold.unfold': 'Unfold block', 'fold.all': 'Fold all', 'fold.none': 'Unfold all' } as const; editor?.fold(actions[id as keyof typeof actions]); return; }
    if (['edit.undo','edit.redo','edit.replace','edit.gotoLine'].includes(id)) { if (layout === 'preview') layout = 'source'; await tick(); if (id === 'edit.undo') editor?.undoEdit(); else if (id === 'edit.redo') editor?.redoEdit(); else if (id === 'edit.replace') editor?.replace(); else editor?.goToLine(); return; }
    if (id === 'edit.find') { if (layout === 'preview') layout = 'source'; await tick(); editor?.find(); return; }
    if (id === 'block.actions') { await tick(); paletteScope = 'blocks'; paletteOpen = true; return; }
    const actions: Partial<Record<CommandId, BlockAction>> = {
      'block.moveUp': 'Move up', 'block.moveDown': 'Move down', 'block.duplicate': 'Duplicate', 'block.delete': 'Delete',
      'block.heading': 'Turn into heading', 'block.paragraph': 'Turn into paragraph', 'block.task': 'Turn into task',
    };
    if (actions[id]) { if (layout === 'preview') layout = 'source'; await tick(); blockAction(actions[id]!); }
  }
  function handleKeyboard(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && (event.code === 'F12' || event.key === 'F12')) {
      event.preventDefault(); event.stopImmediatePropagation(); disableCustomTheme(); return;
    }
    if ((event.target as HTMLElement | null)?.closest?.('[data-shortcut-capture]')) return;
    const command = commandForEvent(event, shortcuts);
    if (!command) return;
    event.preventDefault(); event.stopPropagation();
    if (closingWindow || document.querySelector('dialog[open]') || event.repeat) return;
    void runCommand(command);
  }
  // macOS: show the effective shortcuts in the menu bar. An item with a key
  // equivalent takes that key before the webview sees it and sends the
  // command instead, so none are set while Settings captures shortcuts.
  $effect(() => {
    if (!desktop || !mac) return;
    const bindings: Record<string, string> = {};
    if (!settingsOpen) for (const command of COMMANDS) {
      const accelerator = menuAccelerator(shortcutFor(command.id, shortcuts));
      if (accelerator) bindings[command.id] = accelerator;
    }
    void invoke('set_menu_shortcuts', { shortcuts: bindings }).catch(() => undefined);
  });
  // macOS: a quit from the Dock or at logout bypasses the window close guard
  // unless the backend knows the guard has work to do (a save in flight or
  // failed). Reported only when it changes.
  let quitGuard = false;
  $effect(() => {
    if (!desktop || !mac) return;
    const needed = persistence.state === 'saving' || persistence.state === 'error';
    if (needed === quitGuard) return;
    quitGuard = needed;
    void invoke('set_quit_guard', { needed }).catch(() => undefined);
  });
  function runMenuCommand(id: unknown) {
    const command = COMMANDS.find((item) => item.id === id);
    if (!command || closingWindow || document.querySelector('dialog[open]')) return;
    void runCommand(command.id);
  }
  function tabSnapshot(tab: DocumentTab) {
    return { id: tab.id, name: tab.name, path: tab.path, content: editors[tab.id]?.snapshot().text ?? tab.content, dirty: tabDirty(tab), hemingway: tab.hemingway, selection: editors[tab.id]?.selected() ?? tab.selection };
  }

  onMount(() => {
    const guardFileDrop = (event: DragEvent) => {
      const transfer = event.dataTransfer;
      if (!transfer || (!transfer.types.includes('Files') && !transfer.files.length)) return;
      event.preventDefault();
      if (event.type === 'dragover') transfer.dropEffect = 'none';
      else if (!(event.target instanceof Element && event.target.closest('.canvas-viewport'))) {
        error = 'Open files with Open, or use Add note card or Add media card on Canvas.';
      }
    };
    window.addEventListener('dragover', guardFileDrop, true);
    window.addEventListener('drop', guardFileDrop, true);
    return () => {
      window.removeEventListener('dragover', guardFileDrop, true);
      window.removeEventListener('drop', guardFileDrop, true);
    };
  });

  onMount(() => {
    launchDisposed = false;
    if (initialView) for (const id of initialView.tabIds) if (initialView.selections[id]) editors[id]?.restoreSelection(initialView.selections[id]);
    const unobserve = observePersistence((value) => persistence = value);
    const guard = (event: BeforeUnloadEvent) => { if (!desktop && documents.some(tabDirty)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    window.addEventListener('keydown', handleKeyboard, true);
    let unclose: (() => void) | undefined, unagent: (() => void) | undefined, unlaunch: (() => void) | undefined, unmenu: (() => void) | undefined, disposed = false;
    if (nativeStore) {
      void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
        const current = getCurrentWindow(); let closing = false;
        unclose = await current.onCloseRequested(async (event) => {
          event.preventDefault();
          if (closing) return;
          const previousFocus = document.activeElement as HTMLElement | null;
          let launchGateClosed = false;
          const reopenLaunches = async () => {
            if (!launchGateClosed) return '';
            try { await invoke('set_launch_closing', { closing: false }); launchGateClosed = false; return ''; }
            catch (cause) { return 'Could not resume file launch admission after closing was interrupted. ' + String(cause); }
          };
          closing = true; closingWindow = true;
          try {
            // Reject new socket work as retryable, then drain the fixed set of
            // requests accepted before the gate closed. No acknowledgment is
            // abandoned by an ordinary approved window close.
            await invoke('set_launch_closing', { closing: true });
            launchGateClosed = true;
            await drainLaunchesForClose();
            await tick(); await Promise.all([...cellSessions.values()].map(session=>session.stop())); await flushPersistence();
            if (persistence.state === 'error') {
              discardDecisions++;
              let discard = false;
              try { discard = await new Promise<boolean>((resolve) => closeRecoveryDecision = resolve); }
              finally { discardDecisions--; }
              if (!discard) {
                const reopenError = await reopenLaunches();
                closing = false; closingWindow = false; await tick(); previousFocus?.focus();
                if (reopenError) persistence = { state: 'error', error: reopenError };
                return;
              }
            }
            // Finish this approved request directly. Calling close() here would
            // emit another request and move failures outside this catch block.
            await current.destroy();
          } catch (cause) {
            const reopenError = await reopenLaunches();
            closing = false; closingWindow = false;
            if (String(cause).includes('Close sticky windows first')) error = String(cause);
            else persistence = { state: 'error', error: 'Could not close the window after saving app state. ' + String(cause) + reopenError };
          }
        });
      }).catch((cause: unknown) => { persistence = { state: 'error', error: 'Close-time database flush unavailable. Recovery cache remains active. ' + String(cause) }; });
      void import('@tauri-apps/api/event').then(async ({ listen }) => {
        const stop = await listen<LaunchRequest>('notation:launch-request', ({ payload }) => queueLaunchRequest(payload));
        if (disposed) { stop(); return; }
        unlaunch = stop;
        // main.ts has completed bootstrap and App has restored its session before
        // this snapshot is requested. Listen first so warm events cannot race it.
        const pending = await invoke<LaunchRequest[]>('launch_ready', { ready: true });
        if (!disposed) for (const request of pending) queueLaunchRequest(request);
      }).catch((cause: unknown) => { error = 'File launch queue unavailable: ' + String(cause); });
      // The macOS menu bar sends app command ids; run them like shortcuts.
      void import('@tauri-apps/api/event').then(async ({ listen }) => {
        const stop = await listen<string>('notation:menu-command', ({ payload }) => runMenuCommand(payload));
        if (disposed) stop(); else unmenu = stop;
      }).catch(() => undefined);
      type AgentRequest = { id: string; operation: 'list_tabs' | 'read_tab' | 'open_document' | 'edit_document'; path?: string; tabId?: string; expectedContent?: string; content?: string; expiresAt: number };
      void import('@tauri-apps/api/event').then(async ({ listen }) => {
        unagent = await listen<AgentRequest>('notation:agent-request', async ({ payload: request }) => {
          try {
            if (disposed || !Number.isFinite(request.expiresAt) || Date.now() >= request.expiresAt) throw new Error('Agent request expired.');
            if ((request.operation === 'edit_document' || request.operation === 'open_document') && (discardDecisions > 0 || closingWindow)) throw new Error('A close or recovery decision is pending. Retry the agent request after it finishes.');
            let result: unknown;
            if (request.operation === 'list_tabs') result = { activeTabId: activeId, tabs: documents.map((tab) => ({ id: tab.id, name: tab.name, path: tab.path, dirty: tabDirty(tab), active: tab.id === activeId })) };
            else if (request.operation === 'open_document') {
              const openedTab = request.path ? await openTab(request.path, undefined, request.expiresAt) : null;
              if (!openedTab) throw new Error(error || 'The editor is busy or the document could not be opened.');
              await tick();
              const opened = documents.find((tab) => tab.id === openedTab.id);
              if (!opened) throw new Error('The opened tab is no longer available.');
              result = tabSnapshot(opened);
            } else {
              const tab = documents.find((item) => item.id === request.tabId);
              if (!tab) throw new Error('The requested tab is not open.');
              if (request.operation === 'edit_document') {
                if (tab.hemingway) throw new Error(HEMINGWAY_MESSAGE);
                if (!agentEditsEnabled) throw new Error('Agent edits are disabled in Settings.');
                if (typeof request.expectedContent !== 'string' || typeof request.content !== 'string') throw new Error('Agent edits require content and exact expectedContent.');
                if (Date.now() >= request.expiresAt) throw new Error('Agent request expired.');
                if (!editors[tab.id]?.apply(request.content, request.expectedContent, 'input.agent')) throw new Error('Document content changed. Read the tab again before editing.');
                status = 'Agent edited ' + tab.name;
              } else if (request.operation !== 'read_tab') throw new Error('Unsupported agent operation.');
              result = tabSnapshot(tab);
            }
            await invoke('complete_agent_request', { id: request.id, result });
          } catch (cause) { await invoke('complete_agent_request', { id: request.id, error: String(cause) }).catch(() => {}); }
        });
        await tick(); if (!disposed) await invoke('agent_ready', { ready: true });
      }).catch((cause: unknown) => { error = 'MCP editor bridge unavailable: ' + String(cause); });
    }
    return () => { disposed = true; launchDisposed = true; window.removeEventListener('beforeunload', guard); window.removeEventListener('keydown', handleKeyboard, true); unobserve(); unclose?.(); unagent?.(); unlaunch?.(); unmenu?.(); if (nativeStore) { void invoke('launch_ready', { ready: false }).catch(() => {}); void invoke('agent_ready', { ready: false }).catch(() => {}); } };
  });
</script>

<main class="app" use:smoothScrolling={ui.smoothScrolling && !ui.performanceMode} data-performance-mode={ui.performanceMode} class:focus-mode={ui.focusMode} data-density={ui.density} data-dark-preset={ui.darkPreset} data-light-preset={ui.lightPreset} inert={closingWindow} style={preferencesStyle(ui) + ';--editor-font-size:' + fontSize + 'px'}>
  <header class="workspace-bar" data-tauri-drag-region={desktop && mac ? 'deep' : undefined}>
    <CompactMenu label="App menu" text="N" items={appMenuItems} execute={(id) => void runCommand(id)} bind:open={appMenuOpen} {theme} />
    <div class="workspace-control">
      {#if catalog.workspaces.length}<WorkspaceSwitcher workspaces={catalog.workspaces} value={catalog.activeId ?? ''} disabled={workspaceBusy || busy} onchange={(id) => void chooseWorkspace(id)} {theme} />{:else}<span class="workspace-personal">Personal</span>{/if}
      <button class="workspace-panel-trigger" aria-label="Open workspace panel" title="Workspace panel" onclick={openWorkspacePanel}><Icon name="chevron" size={14} {theme} /></button>
    </div>
    <Tabs documents={visibleDocuments} {activeId} select={selectTab} close={(id) => void closeTab(id)} create={() => void runCommand('file.new')} rename={(id) => { selectTab(id); renameId = id; }} {theme} />
    <button class="commands-trigger" aria-label="Commands" title={'Commands ' + formatShortcut(shortcutFor('app.commands', shortcuts), mac)} onclick={() => { paletteScope = 'all'; paletteOpen = true; }}><Icon name="search" size={16} {theme} /><span>Commands</span><kbd aria-hidden="true">{formatShortcut(shortcutFor('app.commands', shortcuts), mac)}</kbd></button>
    <CompactMenu label="Layout" text={active.hemingway ? 'Hemingway' : canvasVisible ? 'Canvas' : effectiveLayout === 'live' ? 'Live' : effectiveLayout[0].toUpperCase() + effectiveLayout.slice(1)} items={layoutItems} execute={(id) => void runCommand(id)} bind:open={layoutMenuOpen} radio {theme} />
  </header>
  <div class="toast-stack">
  {#if error}<div class="app-error" role="alert" in:pop={{ token: 'slow', y: -10, scale: 1 }} out:pop={{ token: 'slow', y: -10, scale: 1, exit: true }}>{error}<button aria-label="Dismiss error" onclick={() => error = ''}>×</button></div>{/if}
  {#if persistence.state === 'error'}<div class="app-error" role="alert" in:pop={{ token: 'slow', y: -10, scale: 1 }} out:pop={{ token: 'slow', y: -10, scale: 1, exit: true }}>{persistence.error}<button onclick={() => void retryPersistence()}>Retry saving app state</button></div>{/if}
  {#if persistence.recoveryOffered && (persistence.recovery?.draft || persistence.recovery?.scriptDraft || persistence.recovery?.session)}<div class="recovery-banner" role="status" in:pop={{ token: 'slow', y: -10, scale: 1 }} out:pop={{ token: 'slow', y: -10, scale: 1, exit: true }}><div class="recovery-copy"><strong>Work available to restore</strong>{#if persistence.recovery.session}<span>Restore tabs replaces your current open tabs; unsaved tabs are confirmed first.</span>{:else if persistence.recovery.draft}<span>Restore document opens the draft and replaces its matching open tab.</span>{/if}{#if persistence.recovery.scriptDraft}<span>{scriptsEnabled ? 'Restore script edits replaces the code in Scripts without running it or updating saved library scripts.' : 'Enable scripts in Settings → Editor to restore these edits.'}</span>{/if}<span>Document files stay unchanged. Keep current work dismisses these options and keeps your current work.</span></div><div class="recovery-actions">{#if persistence.recovery.session}<button onclick={recoverSession}>Restore tabs</button>{:else if persistence.recovery.draft}<button onclick={recoverDraft}>Restore document</button>{/if}{#if persistence.recovery.scriptDraft && scriptsEnabled}<button onclick={recoverScript}>Restore script edits</button>{/if}<button onclick={dismissRecovery}>Keep current work</button></div></div>{/if}
  </div>
  <div class="content-area" data-sidebar-position={ui.sidebarPosition}>
    {#if !ui.focusMode}
      <aside class="app-sidebar" aria-label="Application tools">
        <Sidebar items={sidebarItems} execute={(id) => void runCommand(id)} {theme} />
        {#if visiblePanel}<div class="sidebar-panel" class:sidebar-graph={panel === 'graph'} use:fadeOnChange={panel} in:pop={{ token: 'slow', x: ui.sidebarPosition === 'right' ? 16 : -16, y: 0, scale: 1 }} out:pop={{ token: 'slow', x: ui.sidebarPosition === 'right' ? 16 : -16, y: 0, scale: 1, exit: true }} onintrostart={(event) => event.currentTarget.classList.remove('leaving')} onoutrostart={(event) => event.currentTarget.classList.add('leaving')}>
          {#if panel === 'stickies'}<StickyNotes createRequest={stickyCreateRequest} created={() => stickyCreateRequest = 0} close={() => { panel = null; stickyCreateRequest = 0; }} />{/if}
          {#if panel === 'explorer' && !ui.focusMode}<Explorer workspace={activeWorkspace} currentPath={active.path} openFile={(path) => void openPath(path)} configure={() => panel = 'workspace'} close={() => panel = null} />{/if}
          {#if panel === 'scripts' && scriptsEnabled && !ui.focusMode}<Scripts lockedReason={active.hemingway ? HEMINGWAY_MESSAGE : ''} snapshot={scriptSnapshot} apply={applyScript} close={() => panel = null} />{:else if panel === 'workspace' && !ui.focusMode}<Workspace {catalog} action={workspaceAction} changing={workspaceBusy} currentPath={active.path} openDocument={openPath} close={() => panel = null} />{:else if panel === 'history' && !ui.focusMode}<History lockedReason={active.hemingway ? HEMINGWAY_MESSAGE : ''} currentContent={active.content} documentKey={active.path ?? active.id} snapshot={historySnapshot} restore={restoreRevision} close={() => panel = null} />{:else if panel === 'properties' && !ui.focusMode && !canvasDocument && !active.hemingway}<Properties content={active.content} documentId={active.lifetime} {standalone} apply={applyProperties} editSource={() => { layout = 'source'; void tick().then(() => editor?.reveal(0)); }} close={() => panel = null} />{:else if panel === 'templates' && !ui.focusMode && !canvasDocument && !active.hemingway}<Templates snapshot={scriptSnapshot} apply={applyTemplate} close={()=>panel=null} />{:else if panel === 'export' && !ui.focusMode && !canvasDocument && !active.hemingway}<Export snapshot={()=>({name:active.name,text:active.content,documentId:active.lifetime,path:active.path,sourcePath:active.path??active.id,standalone})} {theme} loadEmbed={loadEmbedded} close={()=>panel=null} />{:else if panel === 'table' && !ui.focusMode && !canvasDocument && !active.hemingway}<SmartTable content={active.content} documentId={active.lifetime} cursor={active.selection?.head ?? 0} {standalone} apply={applyTable} close={()=>panel=null} />{:else if panel === 'graph' && !ui.focusMode}{#key catalog.activeId}<Graph currentPath={active.path} open={(path)=>void openPath(path)} close={()=>panel=null} />{/key}{:else if panel === 'git' && gitRoot && active.path && !ui.focusMode}{#key JSON.stringify([active.path, gitRoot])}<Git documentPath={active.path} repositoryRoot={gitRoot} close={() => panel = null} />{/key}{/if}
        </div>{/if}
      </aside>
      {#if visiblePanel}<button class="sidebar-scrim" tabindex="-1" aria-label="Close tool panel" onclick={() => { panel = null; stickyCreateRequest = 0; }} in:pop={{ token: 'slow', y: 0, scale: 1 }} out:pop={{ token: 'slow', y: 0, scale: 1, exit: true }}></button>{/if}
    {/if}
    <div class="workspace" use:fadeOnChange={{ key: effectiveLayout + (canvasVisible ? ':canvas' : '') + (active.hemingway ? ':hemingway' : ''), self: true, token: 'base', from: .35 }} class:only-source={effectiveLayout === 'source' || effectiveLayout === 'live' || canvasVisible || active.hemingway} class:only-preview={!active.hemingway && effectiveLayout === 'preview'}>
      <section class="pane source-pane" class:code-source={codeDocument} aria-label="Source editor" hidden={!active.hemingway && (effectiveLayout === 'preview' || canvasVisible)}>
        {#if reducedDocument}<div class="formatting-notice" role="status">Reduced formatting · This document is large or punctuation-heavy. Editing continues in Source; rich formatting returns when it shrinks. Your text is unchanged.</div>{/if}
        {#if active.hemingway}<div class="pane-heading" role="status" aria-label="Hemingway mode"><span>HEMINGWAY MODE</span><span class="pane-hint">Deletion blocked · Commands → Hemingway mode</span></div>{:else if effectiveLayout === 'split'}<div class="pane-heading"><span>SOURCE</span><span class="pane-hint">{standalone ? '.mmd' : '.md'}</span></div>{/if}
        {#if diskConflicts[activeId]}<div class="disk-conflict-banner" role="alert" in:pop={{ token: 'slow', y: -10, scale: 1 }} out:pop={{ token: 'slow', y: -10, scale: 1, exit: true }}><span>{diskConflicts[activeId]}</span><button onclick={() => comparingDisk = activeId}>Compare / reload</button><button onclick={() => delete diskConflicts[activeId]}>Keep editing</button></div>{/if}
        {#each documents as tab (tab.lifetime)}<div class="editor-tab-host" hidden={tab.id !== activeId}><Editor bind:this={editors[tab.id]} mathMode={ui.mathSyntax} value={tab.content} codeLanguage={ui.performanceMode ? 'plaintext' : detectLanguage(tab.name, tab.language)} intelligenceEnabled={desktop && intelligenceEnabled} tabSize={ui.tabSize} indentWithTabs={ui.indentWithTabs} onIntelligence={(value) => { intelligenceStates[tab.id] = value; }} hemingway={tab.hemingway} initialSelection={tab.selection} active={tab.id === activeId} {wrap} showLineNumbers={ui.showLineNumbers} appearance={[fontSize, ui.editorFont, ui.lineHeight, ui.readingWidth].join(':')} live={tab.id === activeId && effectiveLayout === 'live' && !canvasDocument} standalone={tab.name.toLowerCase().endsWith('.mmd')} {theme} folds={tab.folds} cells={cellsFor(tab)} sourcePath={tab.path ?? tab.id} loadEmbed={loadEmbedded} onOpenPath={(path) => void openPath(path)} onOpenWiki={(target, path) => void openWiki(target, tab.id, path)} onEditProperties={() => editProperties(tab.id)} wikiCandidates={(context) => candidatesFor(tab.id, context)} onFormatting={(state) => { formattingReduced[tab.id] = state.reduced; }} onChange={(value) => { invalidateDiskCheck(); scheduleDiskCheck(); tab.content = value; tab.updatedAt = Date.now(); }} onSelection={(selection) => { tab.selection = selection; }} /></div>{/each}
      </section>
      <section class="pane preview-pane" aria-label="Preview pane" hidden={effectiveLayout === 'source' || effectiveLayout === 'live' || canvasVisible || active.hemingway}>{#if effectiveLayout === 'split'}<div class="pane-heading"><span>PREVIEW</span></div>{/if}{#if !active.hemingway && !canvasVisible && (effectiveLayout === 'split' || effectiveLayout === 'preview')}<Preview bind:this={preview} mathMode={ui.mathSyntax} documentId={active.lifetime} content={active.content} {standalone} {theme} folds={active.folds} onToggleTask={togglePreviewTask} onInsertSqlTable={insertPreviewSqlTable} onEditSource={(from) => void editSource(from)} cells={cellsFor(active)} sourcePath={active.path ?? active.id} loadEmbed={loadEmbedded} onOpenPath={(path) => void openPath(path)} onOpenWiki={wikiHandler(activeId)} onEditProperties={propertiesHandler(activeId)} />{/if}</section>
      {#if canvasVisible}<Canvas content={active.content} documentId={active.lifetime} path={active.path} apply={applyCanvas} openNote={(file,subpath)=>void openWiki(file+(subpath||''),activeId,'')} noteCandidates={canvasNoteCandidates} renderCard={renderCanvasCard} undo={()=>editor?.undoEdit()} redo={()=>editor?.redoEdit()} />{/if}
    </div>

  </div>
  {#if ui.showStatusBar && !ui.focusMode}<footer class="statusbar"><span class="status-message" role="status">{busy ? 'Working…' : status}</span>{#if !canvasVisible}{#if !canvasDocument}<button class="document-language" aria-label="Change document language" title="Document language · automatic by file extension" onclick={() => languageTarget = activeId}>{languageOptions.find(item => item.value === activeLanguage)?.label ?? activeLanguage}{active.language ? ' · override' : ''}</button>{#if intelligenceEnabled && codeDocument}<span class="intelligence-status" role="status" title={intelligenceStates[activeId]?.message}>{intelligenceStates[activeId]?.state === 'error' ? 'Tools unavailable' : intelligenceStates[activeId]?.message ?? ''}</span>{/if}{/if}<span class="status-detail">{lineCount} {lineCount === 1 ? 'line' : 'lines'}<span class="status-divider">·</span>{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>{/if}{#if ui.performanceMode}<span class="status-detail">Performance mode</span>{/if}{#if !ui.performanceMode && formattingReduced[activeId]}<span class="status-detail" role="status" title="This document is large or punctuation-heavy. Rich formatting is paused; the text, undo history and saved content are unchanged.">Reduced formatting · text unchanged</span>{/if}<span class="save-state" data-state={saveState} use:fadeOnChange={{ key: saveState + (dirty ? ':dirty' : ''), self: true }}>{#if saveState === 'saved'}<Icon name="check" size={12} {theme} />{/if}{saveState === 'error' ? dirty ? 'Unsaved changes' : 'App state not saved' : dirty ? 'Unsaved changes' : 'Saved'}</span>{#if nativeStore}<span class="database-state" data-state={persistence.state} hidden={persistence.state !== 'saving' && persistence.state !== 'error'} role="status">{persistence.state === 'saving' ? 'Saving app state…' : persistence.state === 'error' ? 'Changes not saved' : ''}</span>{/if}{#if !desktop}<span class="browser-mode">Browser mode</span>{/if}</footer>{/if}
  {#if fileNavigator}<FileNavigator mode={fileNavigator} files={[...new Set([...visibleDocuments.map(tab=>tab.path ?? tab.id), ...(activeWorkspace?.files ?? [])])]} label={(path)=>documents.find(tab=>tab.path===path || tab.id===path)?.name ?? path.split('/').pop() ?? path} read={readCodeFile} open={async (path,line) => { const tab=documents.find(tab=>tab.id===path || tab.path===path); if(tab){selectTab(tab.id); await tick(); if(line)editors[tab.id]?.revealLine(line);}else await openPath(path,line); }} close={()=>fileNavigator=null} />{/if}
  {#if symbolTarget}{@const target=editors[symbolTarget]}<RenameDocument name={target?.symbolName() ?? ''} label="Rename symbol" fieldLabel="Symbol name" rename={(name)=>{void target?.renameSymbol(name)?.then(count=>{status=`Renamed symbol in ${count} files · save each changed file to write to disk`;}).catch(cause=>error=String(cause));}} close={()=>symbolTarget=null} />{/if}
  {#if diskTarget?.path}{@const target=diskTarget}<DiskConflict path={target.path!} content={target.content} read={readDiskFile} reload={(content)=>{if(target.hemingway){error=HEMINGWAY_MESSAGE;return;}target.content=content;target.savedContent=content;target.updatedAt=Date.now();delete diskConflicts[target.id];comparingDisk=null;}} close={()=>comparingDisk=null} />{/if}
  {#if paletteOpen}<CommandPalette commands={paletteItems} execute={(id) => void runCommand(id)} close={() => paletteOpen = false} {theme} />{/if}
  {#if renameTarget}<RenameDocument name={renameTarget.name} rename={(name) => { const target = documents.find((tab) => tab.id === renameId); if (target) { invalidateDiskCheck(); scheduleDiskCheck(); target.name = name; target.updatedAt = Date.now(); } }} close={() => renameId = null} />{/if}
  {#if wikiChoice}<WikiChooser resolution={wikiChoice.resolution} busy={wikiBusy} {error} choose={(path) => void chooseWiki(path)} create={() => void chooseWiki()} close={() => { wikiChoice = null; wikiSerial++; }} />{/if}
  {#if languageTarget && documents.find(tab => tab.id === languageTarget)}{@const target = documents.find(tab => tab.id === languageTarget)!}<DocumentLanguage name={target.name} language={target.language} {theme} change={(value) => target.language = value} close={() => languageTarget = null} />{/if}
  {#if settingsOpen}<Settings bind:builtInTheme {theme} bind:fontSize bind:wrap bind:layout bind:agentEditsEnabled bind:prefs={ui} bind:shortcuts {themeImportReset} onpreview={(value) => themePreview = value} disableTheme={disableCustomTheme} close={() => { themePreview = null; settingsOpen = false; }} />{/if}
</main>
{#if closeRecoveryDecision}<CloseRecovery decide={(discard) => { const resolve = closeRecoveryDecision; closeRecoveryDecision = null; resolve?.(discard); }} />{/if}
<input class="file-input" type="file" aria-label="Open document" bind:this={fileInput} onchange={importFile} />
