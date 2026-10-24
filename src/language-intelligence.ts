import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Text, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { LSPClient, LSPPlugin, serverCompletion, hoverTooltips, signatureHelp, serverDiagnostics, jumpToDefinition, findReferences } from '@codemirror/lsp-client';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { keymap } from '@codemirror/view';
import { lintGutter } from '@codemirror/lint';
import DOMPurify from 'dompurify';
import type { CodeLanguage } from './code-languages';

type Start = { id: string; rootUri: string; uri: string; languageId: string; server: string };
export type IntelligenceState = { state: 'starting' | 'ready' | 'error' | 'off'; message: string };
type Hooks = { read: (path: string) => Promise<string>; display: (path: string) => Promise<EditorView | null>; views: () => Map<string, EditorView>; editable: (path: string) => boolean; error: (message: string) => void };
let hooks: Hooks;
export function configureIntelligence(value: Hooks) { hooks = value; }
export function localPath(uri: string): string {
  const url = new URL(uri);
  if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) throw new Error('Language navigation requires a local file.');
  const path = decodeURIComponent(url.pathname);
  if (!path.startsWith('/') || (path.includes('\0') || path.split('/').some(part => part === '..' || part === '.'))) throw new Error('Invalid local file URI.');
  return path;
}
export function fileUri(path: string) { return 'file://' + path.split('/').map(encodeURIComponent).join('/'); }
export function sanitizeDocumentation(html: string) { return DOMPurify.sanitize(html, { ALLOWED_TAGS: ['p', 'br', 'code', 'pre', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'span', 'h1', 'h2', 'h3', 'blockquote'], ALLOWED_ATTR: ['class'] }); }
type Session = { info: Start; client: LSPClient; handlers: Set<(value: string) => void>; users: Set<(state: IntelligenceState) => void>; state: IntelligenceState; writes: Promise<void>; pending: number; timer?: ReturnType<typeof setTimeout>; stopped: boolean };
const sessions = new Map<string, Session>();
let listeners: Promise<UnlistenFn[]> | undefined;
function state(session: Session, next: IntelligenceState) { session.state = next; for (const user of session.users) user(next); }
function errorText(cause: unknown) { return cause && typeof cause === 'object' && 'message' in cause ? String(cause.message) : String(cause); }
function fail(session: Session, cause: unknown) { if (session.stopped) return; state(session, { state: 'error', message: errorText(cause) }); session.stopped = true; session.client.disconnect(); void invoke('lsp_stop', { id: session.info.id }).catch(() => {}); }
async function ensureListeners() {
  listeners ??= Promise.all([
    listen<{ id: string; message: string }>('notation:lsp-message', ({ payload }) => { const session = sessions.get(payload.id); if (session && !session.stopped) for (const handler of session.handlers) { try { handler(payload.message); } catch (cause) { fail(session, cause); } } }),
    listen<{ id: string; error: string }>('notation:lsp-exit', ({ payload }) => { const session = sessions.get(payload.id); if (session) fail(session, payload.error || 'Language server stopped. Toggle language intelligence to reconnect.'); }),
  ]).catch(cause => { listeners = undefined; throw cause; });
  await listeners;
}
export function initializeMessage(message: string) {
  const value = JSON.parse(message);
  if (value.method === 'initialize' && value.params?.capabilities?.textDocument) {
    // The upstream client advertises pull diagnostics but this extension handles
    // publishDiagnostics. Advertise only the protocol we actually consume.
    delete value.params.capabilities.textDocument.diagnostic;
  }
  return JSON.stringify(value);
}
export async function attachIntelligence(path: string, language: CodeLanguage, report: (state: IntelligenceState) => void): Promise<{ extension: Extension; release: () => void }> {
  report({ state: 'starting', message: 'Starting language intelligence…' });
  await ensureListeners();
  const tsserverPath = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(language) ? await invoke<string>('lsp_typescript_path') : undefined;
  const info = await invoke<Start>('lsp_start', { path, language });
  let session = sessions.get(info.id);
  if (!session || session.stopped) {
    const client = new LSPClient({
      rootUri: info.rootUri, timeout: 15000, sanitizeHTML: sanitizeDocumentation,
      initializationOptions: language === 'svelte' ? { isTrusted: false } : language === 'rust' ? { cargo: { buildScripts: { enable: false } }, procMacro: { enable: false }, checkOnSave: false } : { hostInfo: 'Notation', tsserver: { path: tsserverPath }, disableAutomaticTypingAcquisition: true, plugins: [], maxTsServerMemory: 256, preferences: { includeCompletionsForModuleExports: true } },
      extensions: [serverCompletion(), hoverTooltips(), signatureHelp(), serverDiagnostics(), autocompletion(), keymap.of(completionKeymap), lintGutter()],
      notificationHandlers: { 'window/showMessage': (_client, message: { message?: string }) => { if (message.message) hooks.error(message.message); return true; } },
    });
    const request = client.request.bind(client);
    client.request = (async (method: string, params: unknown) => {
      const completion = method === 'textDocument/completion' ? params as { textDocument: { uri: string }; position: Position } : null;
      const view = completion ? hooks.views().get(localPath(completion.textDocument.uri)) : undefined;
      const snapshot = view?.state.doc;
      const result = await request(method, params);
      if (completion) {
        if (!view || !snapshot || view.state.doc !== snapshot || !hooks.editable(localPath(completion.textDocument.uri))) return null;
        return safeCompletions(result, snapshot, completion.position);
      }
      if (method === 'textDocument/references' && Array.isArray(result)) {
        if (result.length > 500 || new Set(result.map(item => item.uri)).size > 32) throw new Error('Reference results exceed 500 locations or 32 files. Narrow the symbol search.');
      }
      return result;
    }) as typeof client.request;
    const cachedFiles = new Map<string, Promise<import('@codemirror/lsp-client').WorkspaceFile | null>>();
    let referenceBytes = 0;
    const workspace = client.workspace;
    workspace.displayFile = async uri => hooks.display(localPath(uri));
    workspace.requestFile = async uri => {
      const existing = workspace.getFile(uri); if (existing) return existing;
      if (cachedFiles.has(uri)) return cachedFiles.get(uri)!;
      if (cachedFiles.size >= 32) throw new Error('Reference file limit reached. Retry after closing the reference list.');
      const pending = (async () => {
        const path = localPath(uri), content = await hooks.read(path);
        referenceBytes += new TextEncoder().encode(content).length;
        if (referenceBytes > 16 * 1024 * 1024) throw new Error('References exceed the 16 MiB text limit.');
        return { uri, languageId: language, version: 0, doc: Text.of(content.replace(/\r\n?/gu, '\n').split('\n')), getView: () => hooks.views().get(path) ?? null };
      })().catch(cause => { hooks.error(String(cause)); return null; });
      cachedFiles.set(uri, pending);
      setTimeout(() => { if (cachedFiles.get(uri) === pending) { cachedFiles.clear(); referenceBytes = 0; } }, 30000);
      return pending;
    };
    session = { info, client, handlers: new Set(), users: new Set(), state: { state: 'starting', message: 'Starting ' + info.server + '…' }, writes: Promise.resolve(), pending: 0, stopped: false };
    sessions.set(info.id, session);
    const current = session;
    let sentInitialize = false;
    client.connect({
      send(message) {
        if (!sentInitialize) { message = initializeMessage(message); sentInitialize = true; }
        if (current.stopped || current.pending >= 64) throw new Error('Language server connection is unavailable or busy.');
        current.pending++;
        current.writes = current.writes.then(() => invoke<void>('lsp_send', { id: info.id, message })).catch(cause => fail(current, cause)).finally(() => { current.pending--; });
      },
      subscribe(handler) { current.handlers.add(handler); }, unsubscribe(handler) { current.handlers.delete(handler); },
    });
    void client.initializing.then(() => state(current, { state: 'ready', message: info.server + ' ready' })).catch(cause => fail(current, cause));
  }
  clearTimeout(session.timer); session.users.add(report); report(session.state);
  const current = session;
  let released = false;
  return { extension: current.client.plugin(info.uri, info.languageId), release() {
    if (released) return; released = true; current.users.delete(report);
    if (!current.users.size) current.timer = setTimeout(() => {
      if (current.users.size) return;
      current.stopped = true; current.client.disconnect(); sessions.delete(info.id);
      void invoke('lsp_stop', { id: info.id }).catch(() => {});
    }, 1000);
  } };
}
export function intelligenceCommand(view: EditorView, action: 'definition' | 'references') {
  if (!LSPPlugin.get(view)) throw new Error('Language intelligence is not ready for this file.');
  return action === 'definition' ? jumpToDefinition(view) : findReferences(view);
}
type Position = { line: number; character: number };
type Edit = { range: { start: Position; end: Position }; newText: string };
export function editOffset(doc: Text, position: Position) {
  if (!Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.line >= doc.lines || position.character < 0) throw new Error('Language server returned an invalid text range.');
  const line = doc.line(position.line + 1);
  if (position.character > line.length) throw new Error('Language server returned an invalid text column.');
  return line.from + position.character;
}
export function validatedEdits(doc: Text, edits: Edit[]) {
  if (!Array.isArray(edits) || edits.length > 10000) throw new Error('Language edit is too large.');
  const changes = edits.map(edit => {
    if (typeof edit.newText !== 'string') throw new Error('Invalid language edit.');
    return { from: editOffset(doc, edit.range.start), to: editOffset(doc, edit.range.end), insert: edit.newText };
  }).sort((a, b) => a.from - b.from || a.to - b.to);
  let end = 0, size = doc.length;
  for (const change of changes) { if (change.from < end || change.to < change.from) throw new Error('Overlapping language edits.'); end = change.to; size += change.insert.length - (change.to - change.from); }
  if (size > 4 * 1024 * 1024) throw new Error('Language edits exceed the editor limit.');
  let cursor = 0, bytes = 0;
  const encoder = new TextEncoder();
  for (const change of changes) { bytes += encoder.encode(doc.sliceString(cursor, change.from)).length + encoder.encode(change.insert).length; cursor = change.to; }
  bytes += encoder.encode(doc.sliceString(cursor)).length;
  if (bytes > 4 * 1024 * 1024) throw new Error('Language edits exceed the editor byte limit.');
  return changes;
}
export async function formatCode(view: EditorView, tabSize: number, insertSpaces: boolean) {
  const plugin = LSPPlugin.get(view); if (!plugin) throw new Error('Language intelligence is not ready.');
  if (!plugin.client.serverCapabilities?.documentFormattingProvider) throw new Error('This server does not provide document formatting.');
  plugin.client.sync(); const doc = view.state.doc;
  const edits = await plugin.client.request<unknown, Edit[] | null>('textDocument/formatting', { textDocument: { uri: plugin.uri }, options: { tabSize, insertSpaces } });
  if (!edits) return;
  if (view.state.doc !== doc || hooks.views().get(localPath(plugin.uri)) !== view || !hooks.editable(localPath(plugin.uri))) throw new Error('The document changed while formatting. Retry formatting.');
  view.dispatch({ changes: validatedEdits(doc, edits), userEvent: 'input.format' });
}
export async function renameCode(view: EditorView, name: string) {
  const plugin = LSPPlugin.get(view); if (!plugin) throw new Error('Language intelligence is not ready.');
  if (!name.trim() || name.length > 256) throw new Error('Enter a symbol name of up to 256 characters.');
  if (!plugin.client.serverCapabilities?.renameProvider) throw new Error('This server does not support symbol rename.');
  plugin.client.sync();
  const selected = view.state.wordAt(view.state.selection.main.head);
  if (!selected) throw new Error('Place the cursor on a symbol before renaming.');
  const originalSymbol = view.state.sliceDoc(selected.from, selected.to);
  const snapshots = new Map([...hooks.views()].map(([path, editor]) => [path, editor.state.doc]));
  const response = await plugin.client.request<unknown, { changes?: Record<string, Edit[]>; documentChanges?: { textDocument: { uri: string; version: number | null }; edits: Edit[]; kind?: string }[] } | null>('textDocument/rename', { textDocument: { uri: plugin.uri }, position: plugin.toPosition(view.state.selection.main.head), newName: name });
  if (!response) return 0;
  const edits = new Map<string, Edit[]>(Object.entries(response.changes ?? {}));
  for (const change of response.documentChanges ?? []) {
    if (change.kind || !change.textDocument) throw new Error('This rename requires file operations; no edits were applied.');
    const file = plugin.client.workspace.getFile(change.textDocument.uri);
    if (change.textDocument.version != null && (!file || file.version !== change.textDocument.version)) throw new Error('Rename targets an outdated document version. Retry.');
    if (edits.has(change.textDocument.uri)) throw new Error('Duplicate file edits; no edits were applied.');
    edits.set(change.textDocument.uri, change.edits);
  }
  if (edits.size > 32) throw new Error('Rename affects more than 32 files; no edits were applied.');
  const session = [...sessions.values()].find(value => value.client === plugin.client);
  if (!session) throw new Error('The language server stopped during rename.');
  const root = localPath(session.info.rootUri);
  const plans: { path: string; view: EditorView; doc: Text; changes: ReturnType<typeof validatedEdits> }[] = [];
  for (const [uri, changes] of edits) {
    const path = localPath(uri);
    if (!path.startsWith(root.endsWith('/') ? root : root + '/')) throw new Error('Rename targets a file outside this language-server root; no edits were applied.');
    const editor = hooks.views().get(path) ?? await hooks.display(path);
    if (!editor || !hooks.editable(path)) throw new Error('A rename target cannot be edited; no edits were applied.');
    const doc = editor.state.doc, before = snapshots.get(path);
    if (before && before !== doc) throw new Error('A document changed while renaming; no edits were applied.');
    const validated = validatedEdits(doc, changes);
    if (validated.some(change => doc.sliceString(change.from, change.to) !== originalSymbol)) throw new Error('A rename range no longer matches the symbol. No edits were applied; refresh the affected file and retry.');
    plans.push({ path, view: editor, doc, changes: validated });
  }
  if (plans.some(plan => plan.view.state.doc !== plan.doc || hooks.views().get(plan.path) !== plan.view || !hooks.editable(plan.path))) throw new Error('A document changed while preparing rename; no edits were applied.');
  for (const plan of plans) plan.view.dispatch({ changes: plan.changes, userEvent: 'input.rename' });
  await hooks.display(localPath(plugin.uri));
  return plans.length;
}

type CompletionRange = { start: Position; end: Position };
type CompletionItem = { label: string; insertText?: string; textEditText?: string; textEdit?: { range?: CompletionRange; insert?: CompletionRange; replace?: CompletionRange; newText: string }; additionalTextEdits?: Edit[]; [key: string]: unknown };
/** The upstream adapter uses one current-line range for every completion item. */
export function safeCompletions(result: unknown, doc: Text, position: Position): unknown {
  if (!result) return result;
  type CompletionList = { items: CompletionItem[]; itemDefaults?: { editRange?: CompletionRange | { insert: CompletionRange; replace: CompletionRange }; [key: string]: unknown }; [key: string]: unknown };
  const list: CompletionList = Array.isArray(result) ? { items: result } : result as CompletionList;
  if (!Array.isArray(list.items)) throw new Error('Malformed completion response.');
  const cursor = editOffset(doc, position);
  const encoder = new TextEncoder(), originalBytes = encoder.encode(doc.toString()).length;
  let chosenRange = '';
  const items = list.items.slice(0, 1000).filter((item: CompletionItem) => {
    try {
      if (typeof item.label !== 'string') return false;
      const main = list.itemDefaults?.editRange ?? item.textEdit?.range ?? item.textEdit?.insert;
      const range = main && 'insert' in main ? main.insert : main;
      let from = cursor, to = cursor;
      if (range) {
        if (range.start.line !== position.line || range.end.line !== position.line) return false;
        from = editOffset(doc, range.start); to = editOffset(doc, range.end);
        if (from > cursor || to < cursor || to - from > 65536) return false;
      }
      const key = range ? `${from}:${to}` : 'word';
      const text = item.textEdit?.newText ?? item.textEditText ?? item.insertText ?? item.label;
      if (typeof text !== 'string' || text.length > 65536) return false;
      const extra = item.additionalTextEdits ?? [];
      if (!Array.isArray(extra) || extra.length > 64 || (!range && extra.length)) return false;
      const changes = extra.map(edit => ({ from: editOffset(doc, edit.range.start), to: editOffset(doc, edit.range.end), insert: edit.newText }));
      changes.push({ from, to, insert: text }); changes.sort((a,b)=>a.from-b.from || a.to-b.to);
      let end=-1, bytes=originalBytes;
      for (const change of changes) {
        if (typeof change.insert !== 'string' || change.insert.length > 65536 || change.from < end || change.to < change.from || change.to-change.from > 65536) return false;
        end=change.to;bytes+=encoder.encode(change.insert).length-encoder.encode(doc.sliceString(change.from,change.to)).length;
      }
      if (bytes > 4*1024*1024 || (chosenRange && key!==chosenRange)) return false;
      chosenRange=key; return true;
    } catch { return false; }
  });
  return { ...list, items };
}
