<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { ask, open, save } from '@tauri-apps/plugin-dialog';
  import { HEMINGWAY_MESSAGE, hemingwayCommandBlocked } from './hemingway';
  import Editor from './Editor.svelte';
  import Preview from './Preview.svelte';
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
  import { referenceContent, scanBlockReferences } from './block-references';
  import type { EmbedDocument } from './render-content';
  import Properties from './Properties.svelte';
  import WikiChooser from './WikiChooser.svelte';
  import { findWikiHeadingLine, parseWikiLink, scanWikiHeadings } from './wiki-links';
  import type { WikiCompletion } from './wiki-links';
  import type { WikiCandidate, WikiResolution } from './wiki-navigation';
  import Explorer from './Explorer.svelte';
  import Git from './Git.svelte';
  import Settings from './Settings.svelte';
  import Tabs from './Tabs.svelte';
  import CloseRecovery from './CloseRecovery.svelte';
  import CommandPalette from './CommandPalette.svelte';
  import CompactMenu from './CompactMenu.svelte';
  import RenameDocument from './RenameDocument.svelte';
  import { preferencesStyle, readUIPreferences } from './preferences';
  import { COMMANDS, commandForEvent, formatShortcut, readShortcutOverrides, shortcutFor } from './shortcuts';
  import type { CommandId } from './shortcuts';
  import type { CommandItem } from './ui-commands';
  import { createTab, restoreTabs, serializeTab, tabDirty } from './documents';
  import type { DocumentTab } from './documents';
  import type { BlockAction } from './editor-commands';
  import type { TaskToggle } from './markdown-features';
  import type { ScriptDocument } from './script-runner';
  import { dismissRecovery, flushPersistence, nativeStore, observePersistence, persistMetadata, retryPersistence } from './store';
  import type { Metadata, PersistenceStatus } from './store';

  let { metadata }: { metadata: Metadata } = $props();
  const initial = untrack(() => metadata);
  const fence = String.fromCharCode(96).repeat(3);
  const sample = '# Welcome to Notation\n\nA small space for Markdown and Mermaid. Write on the left, see it on the right.\n\n## Follow an idea\n\n' + fence + 'mermaid\nflowchart LR\n  A[An idea] --> B[Make a note]\n  B --> C[Connect the dots]\n' + fence + '\n\n- Open a .md or .mmd file\n- Use **Ctrl/Cmd + S** to save\n- Use **Ctrl/Cmd + F** to find in your source\n';
  type Layout = 'split' | 'source' | 'preview' | 'live';
  type Panel = 'explorer' | 'workspace' | 'git' | 'history' | 'scripts' | 'properties' | 'graph' | 'table' | 'export' | 'templates' | null;
  type DocumentResult = { path: string; content: string; warning?: string };
  const restored = restoreTabs(initial.session, initial.draft, sample);
  const preferences = initial.settings;
  let documents = $state<DocumentTab[]>(restored.tabs);
  let activeId = $state(restored.activeTabId);
  const cellSessions=new Map<string,CellSession>();
  function cellsFor(tab:DocumentTab){let session=cellSessions.get(tab.id);if(!session){session=new CellSession();session.update(tab.content,tab.name,tab.path);cellSessions.set(tab.id,session);}return session;}
  $effect(()=>{const ids=new Set(documents.map(tab=>tab.id));for(const tab of documents)cellsFor(tab).update(tab.content,tab.name,tab.path);for(const [id,session] of cellSessions)if(!ids.has(id)){session.dispose();cellSessions.delete(id);}});
  let active = $derived(documents.find((document) => document.id === activeId) ?? documents[0]);
  let editors = $state<Record<string, Editor | undefined>>({});
  let editor = $derived(editors[activeId]);
  let theme = $state<'dark' | 'light'>(preferences.theme === 'light' ? 'light' : 'dark');
  let fontSize = $state(Math.max(10, Math.min(24, Number(preferences.fontSize) || 14)));
  let wrap = $state(preferences.wrap !== false);
  let layout = $state<Layout>(['source', 'preview', 'live'].includes(String(preferences.layout)) ? preferences.layout as Layout : 'split');
  let agentEditsEnabled = $state(preferences.agentEditsEnabled !== false);
  let ui = $state(readUIPreferences(preferences));
  let shortcuts = $state(readShortcutOverrides(preferences.shortcuts));
  let panel = $state<Panel>(null);
  let settingsOpen = $state(false);
  let wikiChoice = $state<{ resolution: WikiResolution; sourceId: string; sourcePath?: string | null; ticket: number } | null>(null);
  let wikiBusy = $state(false);
  let wikiSerial = 0;
  let paletteOpen = $state(false), appMenuOpen = $state(false), layoutMenuOpen = $state(false);
  let paletteScope = $state<'all' | 'blocks'>('all');
  let renameId = $state<string | null>(null);
  let renameTarget = $derived(documents.find((tab) => tab.id === renameId));
  let status = $state(initial.session || initial.draft ? 'Recovered your last session' : 'Ready');
  let error = $state('');
  let busy = $state(false);
  let closingWindow = $state(false);
  let closeRecoveryDecision = $state<((discard: boolean) => void) | null>(null);
  let discardDecisions = 0;
  let persistence = $state<PersistenceStatus>({ state: 'idle', error: '' });
  let fileInput: HTMLInputElement;
  const desktop = isTauri();
  let dirty = $derived(tabDirty(active));
  let canvasDocument = $derived(active.name.toLowerCase().endsWith('.canvas'));
  let canvasVisible = $derived(canvasDocument && !active.hemingway && layout !== 'source');
  let standalone = $derived(active.name.toLowerCase().endsWith('.mmd'));
  let lineCount = $derived(active.content.split('\n').length);
  let wordCount = $derived(active.content.trim() ? active.content.trim().split(/\s+/u).length : 0);
  const mac = /Mac|iPhone|iPad/u.test(navigator.platform);
  let commandItems = $derived<CommandItem[]>(COMMANDS.map((command) => ({
    ...command, shortcut: formatShortcut(shortcutFor(command.id, shortcuts), mac),
    disabled: (active.hemingway && hemingwayCommandBlocked(command.id)) || (busy && ['file.new', 'file.newCanvas', 'file.open', 'file.save', 'file.saveAs', 'tab.close'].includes(command.id)) || (canvasDocument && (['panel.properties','panel.table','panel.templates','panel.export','block.actions'].includes(command.id) || command.id.startsWith('block.') || command.id.startsWith('fold.') || command.id.startsWith('insert.'))),
    checked: command.id.startsWith('view.') ? command.id === 'view.hemingway' ? active.hemingway : command.id === 'view.focus' ? ui.focusMode : !active.hemingway && command.id === 'view.' + layout : command.id.startsWith('panel.') ? panel === command.id.slice(6) && !ui.focusMode : undefined,
  })));
  let layoutItems = $derived(active.hemingway ? commandItems.filter(command => command.id === 'view.hemingway') : canvasDocument
    ? commandItems.filter(command => ['view.source', 'view.preview'].includes(command.id)).map(command => ({ ...command, label: command.id === 'view.preview' ? 'Canvas' : 'Source', checked: command.id === (canvasVisible ? 'view.preview' : 'view.source') }))
    : commandItems.filter(command => ['view.source', 'view.split', 'view.preview', 'view.live'].includes(command.id)));
  let paletteItems = $derived(paletteScope === 'blocks' ? commandItems.filter((command) => command.group === 'Blocks' && command.id !== 'block.actions') : commandItems);
  let appMenuItems = $derived(['Document', 'Application', 'Panels'].flatMap(group => commandItems.filter(command => command.group === group)));

  $effect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.darkPreset = ui.darkPreset;
    document.documentElement.dataset.density = ui.density;
    persistMetadata({ settings: { theme, fontSize, wrap, layout, agentEditsEnabled, ...ui, shortcuts } });
  });
  $effect(() => {
    document.title = (dirty ? '• ' : '') + active.name + ' — Notation';
    persistMetadata({ draft: serializeTab(active) });
  });
  $effect(() => {
    persistMetadata({ session: { activeTabId: activeId, tabs: documents.map(serializeTab), updatedAt: Date.now() } });
  });

  function selectTab(id: string) {
    if (!documents.some((tab) => tab.id === id)) return;
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
    if (busy) return;
    const tab = documents.find((item) => item.id === id);
    if (!tab || !await canDiscard(tab)) return;
    const index = documents.indexOf(tab);
    documents = documents.filter((item) => item.id !== id);
    if (!documents.length) documents = [createTab()];
    if (activeId === id) activeId = documents[Math.max(0, Math.min(index - 1, documents.length - 1))].id;
    await tick(); await flushPersistence();
  }
  function newCanvasDocument(){if(busy)return;if(documents.length>=64){error='Close a tab before opening another document (64-tab limit).';return;}const tab=createTab({name:'untitled.canvas',content:emptyCanvas(),savedContent:''});documents.push(tab);activeId=tab.id;layout='live';error='';status='New canvas';}
  function writingLocked() { if (!active.hemingway) return false; error = HEMINGWAY_MESSAGE; return true; }
  function applyTemplate(text:string,source:{text:string;documentId:number}){return !writingLocked() && source.documentId===active.lifetime&&(editor?.apply(text,source.text,'input.template')??false);}
  function applyCanvas(text:string,source:{text:string;documentId:number}){return !writingLocked() && source.documentId===active.lifetime&&(editor?.apply(text,source.text,'input.canvas')??false);}
  async function renderCanvasCard(host:HTMLElement,markdown:string,sourcePath?:string,current=()=>host.isConnected){await renderContent(host,renderMarkdown(markdown),{theme,folds:new Map(),current,toggle:()=>false,edit:()=>{},loadEmbed:loadEmbedded,sourcePath,openWiki:(target,path)=>void openWiki(target,activeId,path),openPath:path=>void openPath(path)});}
  function newDocument() {
    if (busy) return;
    if (documents.length >= 64) { error = 'Close a tab before opening another document (64-tab limit).'; return; }
    const tab = createTab();
    documents.push(tab); activeId = tab.id; error = ''; status = 'New document';
  }
  function receiveDocument(result: DocumentResult, browser = false): DocumentTab {
    const key = browser ? 'browser:' + result.path : result.path;
    const existing = documents.find((tab) => browser ? tab.openKey === key : tab.path === result.path);
    if (existing) { activeId = existing.id; status = 'Switched to ' + existing.name; error = result.warning || ''; return existing; }
    if (documents.length >= 64) throw new Error('Close a tab before opening another document (64-tab limit).');
    if (new TextEncoder().encode(result.content).length > 4 * 1024 * 1024) throw new Error('This document exceeds the 4 MiB editor limit.');
    const tab = createTab({ name: result.path.split(/[\\/]/u).pop() || 'untitled.md', path: browser ? null : result.path, content: result.content, openKey: browser ? key : undefined });
    documents.push(tab); activeId = tab.id;
    status = 'Opened ' + tab.name; error = result.warning || '';
    return tab;
  }
  async function openPath(selected: string, line?: number, expiresAt?: number): Promise<boolean> {
    if (busy) return false;
    const existing = documents.find((tab) => tab.path === selected);
    if (existing) { activeId = existing.id; if (line) { layout = 'source'; await tick(); editors[existing.id]?.revealLine(line); } return true; }
    busy = true; error = '';
    try {
      const result = await invoke<DocumentResult>('read_document', { path: selected });
      if (expiresAt !== undefined && Date.now() >= expiresAt) throw new Error('Agent request expired before the document opened.');
      const tab = receiveDocument(result);
      if (line) { layout = 'source'; await tick(); editors[tab.id]?.revealLine(line); }
      return true;
    } catch (cause) { error = 'Could not open document: ' + String(cause); return false; }
    finally { busy = false; }
  }
  async function openDocument() {
    if (busy) return;
    if (!desktop) { fileInput.value = ''; fileInput.click(); return; }
    try {
      const selected = await open({ multiple: false, directory: false, filters: [{ name: 'Markdown & Mermaid', extensions: ['md', 'markdown', 'mmd', 'canvas'] }, { name: 'Text files', extensions: ['txt'] }] });
      if (typeof selected === 'string') await openPath(selected);
    } catch (cause) { error = 'Could not open document: ' + String(cause); }
  }
  async function importFile(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    busy = true;
    try { receiveDocument({ path: file.name, content: await file.text() }, true); }
    catch (cause) { error = 'Could not open document: ' + String(cause); }
    finally { busy = false; }
  }
  function usableName(name: string) {
    const clean = name.trim().replace(/[\\/:*?"<>|]/gu, '-');
    return clean ? /\.(md|markdown|mmd|txt|canvas)$/iu.test(clean) ? clean : clean + '.md' : 'untitled.md';
  }
  async function saveDocument(saveAs = false) {
    if (busy) return;
    const tab = active, saveContent = tab.content, originalName = tab.name, saveName = usableName(tab.name);
    busy = true; error = '';
    try {
      if (desktop) {
        let destination = tab.path;
        if (!destination || saveAs || tab.name !== tab.savedName) destination = await save({ defaultPath: tab.path && tab.name === tab.savedName ? tab.path : saveName, filters: tab.name.toLowerCase().endsWith('.canvas') ? [{name:'JSON Canvas',extensions:['canvas']}] : [{ name: 'Markdown', extensions: ['md'] }, { name: 'Mermaid', extensions: ['mmd'] }] });
        if (!destination) return;
        const identity = await invoke<{ path: string }>('resolve_document_path', { path: destination });
        if (documents.some((item) => item.id !== tab.id && item.path === identity.path)) throw new Error('This file is already open in another tab. Switch to that tab or choose a different filename.');
        const result = await invoke<DocumentResult>('write_document', { path: destination, content: saveContent });
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
    } catch (cause) { error = 'Could not save document: ' + String(cause); }
    finally { busy = false; }
  }
  function togglePanel(value: Exclude<Panel, null>) { panel = panel === value ? null : value; }
  function togglePreviewTask(request: TaskToggle) { return editor?.toggle(request) ?? false; }
  async function editSource(from: number) { layout = 'live'; await tick(); editor?.reveal(from); }
  function scriptSnapshot() { return { document: { name: active.name, path: active.path, ...editor!.snapshot() }, documentId: active.lifetime }; }
  function applyScript(text: string, source: { document: ScriptDocument; documentId: number }) { return !writingLocked() && source.documentId === active.lifetime && (editor?.apply(text, source.document.text) ?? false); }
  function historySnapshot() { return { text: editor?.snapshot().text ?? active.content, documentId: active.lifetime }; }
  function restoreRevision(text: string, source: { text: string; documentId: number }) { return !writingLocked() && source.documentId === active.lifetime && (editor?.apply(text, source.text) ?? false); }
  function editProperties(id: string) { if (!documents.some((tab) => tab.id === id)) return; activeId = id; ui.focusMode = false; panel = 'properties'; }
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
  async function jumpToWiki(tab: DocumentTab, heading: string | null) {
    activeId = tab.id;
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
        throw new Error('Opening or creating workspace notes requires the desktop app. Open the target file to navigate between browser tabs.');
      }
      const resolution = await invoke<WikiResolution>('resolve_wiki_link', { target, sourcePath: relativePath === '' ? null : relativePath && !documents.some(tab=>tab.id===relativePath) ? relativePath : source.path });
      if (ticket !== wikiSerial || !documents.some((tab) => tab.id === sourceId)) return;
      if (resolution.status === 'resolved' && resolution.path) {
        if (await openPath(resolution.path)) { const tab = documents.find((item) => item.path === resolution.path); if (tab) await jumpToWiki(tab, resolution.heading); }
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
      if (path) { if (await openPath(path)) tab = documents.find((item) => item.path === path); }
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
    activeId = recoveredTab.id;
    status = 'Recovered cached draft'; await tick(); await flushPersistence();
  }
  async function recoverSession() {
    const cached = persistence.recovery?.session;
    if (!cached) return;
    for (const tab of documents) if (!await canDiscard(tab)) return;
    const state = restoreTabs(cached, null, sample);
    documents = state.tabs; activeId = state.activeTabId; status = 'Recovered cached tabs';
    await tick(); await flushPersistence();
  }
  async function recoverScript() {
    const cached = persistence.recovery?.scriptDraft;
    if (!cached) return;
    persistMetadata({ scriptDraft: cached, settings: { activeScriptId: cached.id || null } });
    panel = null; await tick(); panel = 'scripts'; await flushPersistence();
  }
  async function runCommand(id: CommandId) {
    paletteOpen = false; appMenuOpen = false; layoutMenuOpen = false;
    if (id === 'app.commands') { await tick(); paletteScope = 'all'; paletteOpen = true; return; }
    if (id === 'view.hemingway') { const tab = active; tab.hemingway = !tab.hemingway; tab.updatedAt = Date.now(); if (tab.hemingway) void cellsFor(tab).stop(); status = tab.hemingway ? 'Hemingway mode on — deletion blocked' : 'Hemingway mode off'; error = ''; await tick(); editors[tab.id]?.focus(); return; }
    if (active.hemingway && hemingwayCommandBlocked(id)) { error = HEMINGWAY_MESSAGE; return; }
    if (id === 'app.settings') { settingsOpen = true; return; }
    if (id === 'file.rename') { renameId = activeId; return; }
    if (id === 'file.newCanvas') { newCanvasDocument(); return; }
    if (id === 'file.new') { newDocument(); await tick(); editor?.focus(); return; }
    if (id === 'file.open') { await openDocument(); return; }
    if (id === 'file.save' || id === 'file.saveAs') { await saveDocument(id === 'file.saveAs'); return; }
    if (id === 'tab.close') { await closeTab(activeId); await tick(); editor?.focus(); return; }
    if (id === 'tab.next' || id === 'tab.previous') {
      const index = documents.findIndex((tab) => tab.id === activeId);
      selectTab(documents[(index + (id === 'tab.next' ? 1 : documents.length - 1)) % documents.length].id); await tick(); editor?.focus(); return;
    }
    if (canvasDocument && (['panel.properties','panel.table','panel.templates','panel.export'].includes(id) || id.startsWith('block.') || id.startsWith('fold.') || id.startsWith('insert.'))) { status='This command applies to Markdown notes.'; return; }
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
    if ((event.target as HTMLElement | null)?.closest?.('[data-shortcut-capture]')) return;
    const command = commandForEvent(event, shortcuts);
    if (!command) return;
    event.preventDefault(); event.stopPropagation();
    if (closingWindow || document.querySelector('dialog[open]') || event.repeat) return;
    void runCommand(command);
  }
  function tabSnapshot(tab: DocumentTab) {
    return { id: tab.id, name: tab.name, path: tab.path, content: editors[tab.id]?.snapshot().text ?? tab.content, dirty: tabDirty(tab), hemingway: tab.hemingway, selection: editors[tab.id]?.selected() ?? tab.selection };
  }

  onMount(() => {
    const unobserve = observePersistence((value) => persistence = value);
    const guard = (event: BeforeUnloadEvent) => { if (!desktop && documents.some(tabDirty)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    window.addEventListener('keydown', handleKeyboard, true);
    let unclose: (() => void) | undefined, unagent: (() => void) | undefined, disposed = false;
    if (nativeStore) {
      void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
        const current = getCurrentWindow(); let closing = false;
        unclose = await current.onCloseRequested(async (event) => {
          event.preventDefault();
          if (closing) return;
          const previousFocus = document.activeElement as HTMLElement | null;
          closing = true; closingWindow = true;
          try {
            await tick(); await Promise.all([...cellSessions.values()].map(session=>session.stop())); await flushPersistence();
            if (persistence.state === 'error') {
              discardDecisions++;
              let discard = false;
              try { discard = await new Promise<boolean>((resolve) => closeRecoveryDecision = resolve); }
              finally { discardDecisions--; }
              if (!discard) { closing = false; closingWindow = false; await tick(); previousFocus?.focus(); return; }
            }
            // Finish this approved request directly. Calling close() here would
            // emit another request and move failures outside this catch block.
            await current.destroy();
          } catch (cause) { closing = false; closingWindow = false; persistence = { state: 'error', error: 'Could not close the window after saving app state. ' + String(cause) }; }
        });
      }).catch((cause: unknown) => { persistence = { state: 'error', error: 'Close-time database flush unavailable. Recovery cache remains active. ' + String(cause) }; });
      type AgentRequest = { id: string; operation: 'list_tabs' | 'read_tab' | 'open_document' | 'edit_document'; path?: string; tabId?: string; expectedContent?: string; content?: string; expiresAt: number };
      void import('@tauri-apps/api/event').then(async ({ listen }) => {
        unagent = await listen<AgentRequest>('notation:agent-request', async ({ payload: request }) => {
          try {
            if (disposed || !Number.isFinite(request.expiresAt) || Date.now() >= request.expiresAt) throw new Error('Agent request expired.');
            if ((request.operation === 'edit_document' || request.operation === 'open_document') && (discardDecisions > 0 || closingWindow)) throw new Error('A close or recovery decision is pending. Retry the agent request after it finishes.');
            let result: unknown;
            if (request.operation === 'list_tabs') result = { activeTabId: activeId, tabs: documents.map((tab) => ({ id: tab.id, name: tab.name, path: tab.path, dirty: tabDirty(tab), active: tab.id === activeId })) };
            else if (request.operation === 'open_document') {
              if (!request.path || !await openPath(request.path, undefined, request.expiresAt)) throw new Error(error || 'The editor is busy or the document could not be opened.');
              await tick();
              const opened = documents.find((tab) => tab.path === request.path);
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
    return () => { disposed = true; window.removeEventListener('beforeunload', guard); window.removeEventListener('keydown', handleKeyboard, true); unobserve(); unclose?.(); unagent?.(); if (nativeStore) void invoke('agent_ready', { ready: false }).catch(() => {}); };
  });
</script>

<main class="app" class:focus-mode={ui.focusMode} data-density={ui.density} data-dark-preset={ui.darkPreset} inert={closingWindow} style={preferencesStyle(ui) + ';--editor-font-size:' + fontSize + 'px'}>
  <header class="workspace-bar">
    <CompactMenu label="App menu" text="N" items={appMenuItems} execute={(id) => void runCommand(id)} bind:open={appMenuOpen} />
    <Tabs {documents} {activeId} select={selectTab} close={(id) => void closeTab(id)} rename={(id) => { selectTab(id); renameId = id; }} />
    <button class="commands-trigger" aria-label="Commands" title={'Commands ' + formatShortcut(shortcutFor('app.commands', shortcuts), mac)} onclick={() => { paletteScope = 'all'; paletteOpen = true; }}><span>Commands</span><kbd aria-hidden="true">{formatShortcut(shortcutFor('app.commands', shortcuts), mac)}</kbd></button>
    <CompactMenu label="Layout" text={active.hemingway ? 'Hemingway' : canvasVisible ? 'Canvas' : layout === 'live' ? 'Live' : layout[0].toUpperCase() + layout.slice(1)} items={layoutItems} execute={(id) => void runCommand(id)} bind:open={layoutMenuOpen} radio />
  </header>
  {#if error}<div class="app-error" role="alert">{error}<button aria-label="Dismiss error" onclick={() => error = ''}>×</button></div>{/if}
  {#if persistence.state === 'error'}<div class="app-error" role="alert">{persistence.error}<button onclick={() => void retryPersistence()}>Retry saving app state</button></div>{/if}
  {#if persistence.recovery?.draft || persistence.recovery?.scriptDraft || persistence.recovery?.session}<div class="recovery-banner" role="status"><span>A cached draft from an incomplete save is available.</span>{#if persistence.recovery.session}<button onclick={recoverSession}>Recover cached tabs</button>{:else if persistence.recovery.draft}<button onclick={recoverDraft}>Recover cached draft</button>{/if}{#if persistence.recovery.scriptDraft}<button onclick={recoverScript}>Recover cached script</button>{/if}<button onclick={dismissRecovery}>Dismiss cached recovery</button></div>{/if}
  <div class="content-area">
    {#if panel === 'explorer' && !ui.focusMode}<Explorer currentPath={active.path} openFile={(path) => void openPath(path)} configure={() => panel = 'workspace'} close={() => panel = null} />{/if}
    <div class="workspace" class:only-source={layout === 'source' || layout === 'live' || canvasVisible || active.hemingway} class:only-preview={!active.hemingway && layout === 'preview'}>
      <section class="pane source-pane" aria-label="Source editor" hidden={!active.hemingway && (layout === 'preview' || canvasVisible)}>
        {#if active.hemingway}<div class="pane-heading" role="status" aria-label="Hemingway mode"><span>HEMINGWAY MODE</span><span class="pane-hint">Deletion blocked · Commands → Hemingway mode</span></div>{:else if layout === 'split'}<div class="pane-heading"><span>SOURCE</span><span class="pane-hint">{standalone ? '.mmd' : '.md'}</span></div>{/if}
        {#each documents as tab (tab.lifetime)}<div class="editor-tab-host" hidden={tab.id !== activeId}><Editor bind:this={editors[tab.id]} value={tab.content} hemingway={tab.hemingway} initialSelection={tab.selection} active={tab.id === activeId} {wrap} showLineNumbers={ui.showLineNumbers} appearance={[fontSize, ui.editorFont, ui.lineHeight, ui.readingWidth].join(':')} live={tab.id === activeId && layout === 'live' && !canvasDocument} standalone={tab.name.toLowerCase().endsWith('.mmd')} {theme} folds={tab.folds} cells={cellsFor(tab)} sourcePath={tab.path ?? tab.id} loadEmbed={loadEmbedded} onOpenPath={(path) => void openPath(path)} onOpenWiki={(target, path) => void openWiki(target, tab.id, path)} onEditProperties={() => editProperties(tab.id)} wikiCandidates={(context) => candidatesFor(tab.id, context)} onChange={(value) => { tab.content = value; tab.updatedAt = Date.now(); }} onSelection={(selection) => tab.selection = selection} /></div>{/each}
      </section>
      <section class="pane preview-pane" aria-label="Preview pane" hidden={layout === 'source' || layout === 'live' || canvasVisible || active.hemingway}>{#if layout === 'split'}<div class="pane-heading"><span>PREVIEW</span></div>{/if}{#if !active.hemingway && !canvasVisible && (layout === 'split' || layout === 'preview')}<Preview documentId={active.lifetime} content={active.content} {standalone} {theme} folds={active.folds} onToggleTask={togglePreviewTask} onEditSource={(from) => void editSource(from)} cells={cellsFor(active)} sourcePath={active.path ?? active.id} loadEmbed={loadEmbedded} onOpenPath={(path) => void openPath(path)} onOpenWiki={wikiHandler(activeId)} onEditProperties={propertiesHandler(activeId)} />{/if}</section>
      {#if canvasVisible}<Canvas content={active.content} documentId={active.lifetime} path={active.path} apply={applyCanvas} openNote={(file,subpath)=>void openWiki(file+(subpath||''),activeId,'')} renderCard={renderCanvasCard} undo={()=>editor?.undoEdit()} redo={()=>editor?.redoEdit()} />{/if}
    </div>
    {#if panel === 'scripts' && !ui.focusMode}<Scripts lockedReason={active.hemingway ? HEMINGWAY_MESSAGE : ''} snapshot={scriptSnapshot} apply={applyScript} close={() => panel = null} />{:else if panel === 'workspace' && !ui.focusMode}<Workspace currentPath={active.path} openDocument={openPath} close={() => panel = null} />{:else if panel === 'history' && !ui.focusMode}<History lockedReason={active.hemingway ? HEMINGWAY_MESSAGE : ''} currentContent={active.content} documentKey={active.path ?? active.id} snapshot={historySnapshot} restore={restoreRevision} close={() => panel = null} />{:else if panel === 'properties' && !ui.focusMode && !canvasDocument && !active.hemingway}<Properties content={active.content} documentId={active.lifetime} {standalone} apply={applyProperties} editSource={() => { layout = 'source'; void tick().then(() => editor?.reveal(0)); }} close={() => panel = null} />{:else if panel === 'templates' && !ui.focusMode && !canvasDocument && !active.hemingway}<Templates snapshot={scriptSnapshot} apply={applyTemplate} close={()=>panel=null} />{:else if panel === 'export' && !ui.focusMode && !canvasDocument && !active.hemingway}<Export snapshot={()=>({name:active.name,text:active.content,documentId:active.lifetime,path:active.path,sourcePath:active.path??active.id,standalone})} {theme} loadEmbed={loadEmbedded} close={()=>panel=null} />{:else if panel === 'table' && !ui.focusMode && !canvasDocument && !active.hemingway}<SmartTable content={active.content} documentId={active.lifetime} cursor={active.selection?.head ?? 0} {standalone} apply={applyTable} close={()=>panel=null} />{:else if panel === 'graph' && !ui.focusMode}<Graph currentPath={active.path} open={(path)=>void openPath(path)} close={()=>panel=null} />{:else if panel === 'git' && !ui.focusMode}<Git close={() => panel = null} />{/if}
  </div>
  {#if ui.showStatusBar && !ui.focusMode}<footer class="statusbar"><span class="status-message" role="status">{busy ? 'Working…' : status}</span>{#if !canvasVisible}<span class="status-detail">{lineCount} {lineCount === 1 ? 'line' : 'lines'}<span class="status-divider">·</span>{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>{/if}<span class="save-state">{dirty ? 'Unsaved changes' : 'Saved'}</span>{#if nativeStore}<span class="database-state" data-state={persistence.state} hidden={persistence.state !== 'saving' && persistence.state !== 'error'} role="status">{persistence.state === 'saving' ? 'Saving app state…' : persistence.state === 'error' ? 'Recovery cache active' : ''}</span>{/if}{#if !desktop}<span class="browser-mode">Browser mode</span>{/if}</footer>{/if}
  {#if paletteOpen}<CommandPalette commands={paletteItems} execute={(id) => void runCommand(id)} close={() => paletteOpen = false} />{/if}
  {#if renameTarget}<RenameDocument name={renameTarget.name} rename={(name) => { const target = documents.find((tab) => tab.id === renameId); if (target) { target.name = name; target.updatedAt = Date.now(); } }} close={() => renameId = null} />{/if}
  {#if wikiChoice}<WikiChooser resolution={wikiChoice.resolution} busy={wikiBusy} {error} choose={(path) => void chooseWiki(path)} create={() => void chooseWiki()} close={() => { wikiChoice = null; wikiSerial++; }} />{/if}
  {#if settingsOpen}<Settings bind:theme bind:fontSize bind:wrap bind:layout bind:agentEditsEnabled bind:prefs={ui} bind:shortcuts close={() => settingsOpen = false} />{/if}
</main>
{#if closeRecoveryDecision}<CloseRecovery decide={(discard) => { const resolve = closeRecoveryDecision; closeRecoveryDecision = null; resolve?.(discard); }} />{/if}
<input class="file-input" type="file" accept=".md,.markdown,.mmd,.txt,.canvas,text/plain,text/markdown,application/json" aria-label="Open document" bind:this={fileInput} onchange={importFile} />
