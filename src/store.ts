import { invoke, isTauri } from '@tauri-apps/api/core';
import { readStorage, writeStorage } from './storage';
import type { DocumentSession } from './documents';

export type RecoveryDraft = { id: string; name: string; path: string | null; content: string; savedContent?: string; savedName?: string; updatedAt?: number; hemingway?: boolean };
export type ScriptDraft = { id?: string | null; name: string; code: string; cwd: string | null; updatedAt?: number };
export type SavedScript = ScriptDraft & { id: string; updatedAt: number };
export type Recent = { path: string; name?: string; visitedAt?: number };
export type Metadata = {
  settings: Record<string, unknown>; draft: RecoveryDraft | null; scriptDraft: ScriptDraft | null;
  scripts: SavedScript[]; workspace: string | null; recents: Recent[]; session?: DocumentSession | null; migrationApplied?: boolean;
};
type Patch = { settings?: Record<string, unknown>; draft?: RecoveryDraft | null; scriptDraft?: ScriptDraft | null; session?: DocumentSession | null };
export type PendingRecovery = { draft?: RecoveryDraft | null; scriptDraft?: ScriptDraft | null; session?: DocumentSession | null; failedAt: number };
export type PersistenceStatus = { state: 'idle' | 'saving' | 'saved' | 'error'; error: string; recovery?: PendingRecovery | null };
export const nativeStore = isTauri();
function validSession(value: DocumentSession | null | undefined): value is DocumentSession {
  return !!value && typeof value.activeTabId === 'string' && Number.isFinite(value.updatedAt) && Array.isArray(value.tabs) && value.tabs.length > 0
    && value.tabs.every((tab) => !!tab && typeof tab.id === 'string' && typeof tab.name === 'string' && typeof tab.content === 'string')
    && new Set(value.tabs.map((tab) => tab.id)).size === value.tabs.length
    && value.tabs.some((tab) => tab.id === value.activeTabId);
}

function legacyState(): Metadata {
  const settings = readStorage<Record<string, unknown> | null>('notation.settings', {});
  const candidate = readStorage<RecoveryDraft | null>('notation.draft', null);
  const draft = candidate && typeof candidate.content === 'string' && typeof candidate.name === 'string'
    ? { ...candidate, id: typeof candidate.id === 'string' ? candidate.id : crypto.randomUUID() } : null;
  const scriptDraft = readStorage<ScriptDraft | null>('notation.scripts', null);
  const library = readStorage<SavedScript[] | null>('notation.script-library', null);
  const scripts = Array.isArray(library) ? library : [];
  const session = readStorage<DocumentSession | null>('notation.session', null);
  if (library === null && scriptDraft && typeof scriptDraft.code === 'string') scripts.push({
    id: 'legacy-script', name: scriptDraft.name || 'Document transform', code: scriptDraft.code,
    cwd: scriptDraft.cwd || null, updatedAt: Date.now(),
  });
  return {
    settings: settings && typeof settings === 'object' ? settings : {}, draft, scriptDraft,
    scripts, workspace: null, recents: [], session: validSession(session) ? session : null,
  };
}

let metadata = legacyState();
let recovery = readStorage<PendingRecovery | null>('notation.pending-recovery', null);
let recoveryOwned = false;
let ready = !nativeStore;
let pending: Patch = {};
let timer: ReturnType<typeof setTimeout> | undefined;
let writes = Promise.resolve();
let status: PersistenceStatus = { state: 'idle', error: '', recovery };
const listeners = new Set<(value: PersistenceStatus) => void>();

function report(state: PersistenceStatus['state'], error = '') {
  status = { state, error, recovery };
  for (const listener of listeners) listener(status);
}
export function observePersistence(listener: (value: PersistenceStatus) => void) {
  listeners.add(listener); listener(status); return () => listeners.delete(listener);
}
export function currentMetadata() { return metadata; }

function sameDraft(left: RecoveryDraft | null | undefined, right: RecoveryDraft | null | undefined) {
  return !!left && !!right && left.content === right.content && left.name === right.name && left.path === right.path && (left.hemingway === true) === (right.hemingway === true);
}
function sameScript(left: ScriptDraft | null | undefined, right: ScriptDraft | null | undefined) {
  return !!left && !!right && left.code === right.code && left.name === right.name && (left.cwd || null) === (right.cwd || null);
}
function sameSession(left: DocumentSession | null | undefined, right: DocumentSession | null | undefined) {
  if (!validSession(left) || !validSession(right)) return false;
  const content = (session: DocumentSession) => JSON.stringify(session.tabs.map((tab) => ({ id: tab.id, name: tab.name, path: tab.path, content: tab.content, hemingway: tab.hemingway === true })));
  return content(left) === content(right);
}
function stashRecovery() {
  if (recovery && !recoveryOwned) return !!readStorage<PendingRecovery | null>('notation.pending-recovery', null);
  recovery = { draft: metadata.draft, scriptDraft: metadata.scriptDraft, session: metadata.session, failedAt: Date.now() };
  recoveryOwned = true;
  return writeStorage('notation.pending-recovery', recovery);
}
function committed(patch: Patch) {
  if (!recovery) return;
  if ('draft' in patch && sameDraft(patch.draft, recovery.draft)) delete recovery.draft;
  if ('scriptDraft' in patch && sameScript(patch.scriptDraft, recovery.scriptDraft)) delete recovery.scriptDraft;
  if ('session' in patch && sameSession(patch.session, recovery.session)) delete recovery.session;
  if (!recovery.draft && !recovery.scriptDraft && !recovery.session) recovery = null;
  writeStorage('notation.pending-recovery', recovery);
}
export function dismissRecovery() {
  recovery = null; recoveryOwned = false;
  writeStorage('notation.pending-recovery', null);
  report(status.state, status.error);
}

export async function bootstrapMetadata(): Promise<Metadata> {
  if (!nativeStore) return metadata;
  try {
    const loaded = await invoke<Metadata>('bootstrap_state', { legacy: metadata });
    // A crash can happen before the debounced SQL write returns an error.
    // Preserve newer differing cache content before mounting authoritative DB
    // state; changing only a saved baseline does not create a recovery offer.
    const cachedDraft = metadata.draft, cachedScript = metadata.scriptDraft;
    let foundRecovery = false;
    if (!recovery?.draft && cachedDraft && !sameDraft(cachedDraft, loaded.draft) && (cachedDraft.updatedAt ?? 0) > (loaded.draft?.updatedAt ?? 0)) {
      recovery = { ...recovery, draft: cachedDraft, failedAt: recovery?.failedAt ?? Date.now() }; foundRecovery = true;
    }
    if (!recovery?.scriptDraft && cachedScript && !sameScript(cachedScript, loaded.scriptDraft) && (cachedScript.updatedAt ?? 0) > (loaded.scriptDraft?.updatedAt ?? 0)) {
      recovery = { ...recovery, scriptDraft: cachedScript, failedAt: recovery?.failedAt ?? Date.now() }; foundRecovery = true;
    }
    const cachedSession = metadata.session;
    if (!recovery?.session && cachedSession && !sameSession(cachedSession, loaded.session) && cachedSession.updatedAt > (loaded.session?.updatedAt ?? 0)) {
      recovery = { ...recovery, session: cachedSession, failedAt: recovery?.failedAt ?? Date.now() }; foundRecovery = true;
    }
    if (foundRecovery) writeStorage('notation.pending-recovery', recovery);
    metadata = {
      ...metadata, ...loaded,
      settings: loaded.settings && typeof loaded.settings === 'object' ? loaded.settings : {},
      scripts: Array.isArray(loaded.scripts) ? loaded.scripts : [],
      recents: Array.isArray(loaded.recents) ? loaded.recents : [],
    };
    ready = true; report('saved');
  } catch (error) {
    const retained = stashRecovery();
    report('error', 'Database unavailable. ' + (retained ? 'Recovery cache is active. ' : 'Recovery cache could not be saved. Keep the app open and save files. ') + String(error));
  }
  return metadata;
}

export function persistMetadata(patch: Patch) {
  if (patch.settings) patch = { ...patch, settings: { ...metadata.settings, ...patch.settings } };
  if (patch.scriptDraft) patch = { ...patch, scriptDraft: { ...patch.scriptDraft, updatedAt: sameScript(patch.scriptDraft, metadata.scriptDraft) ? metadata.scriptDraft?.updatedAt ?? patch.scriptDraft.updatedAt : Date.now() } };
  metadata = { ...metadata, ...patch };
  if (nativeStore && (recoveryOwned || !ready)) stashRecovery();
  let cached = true;
  if ('settings' in patch) cached = writeStorage('notation.settings', patch.settings) && cached;
  if ('draft' in patch && (!recovery?.draft || recoveryOwned || sameDraft(patch.draft, recovery.draft))) cached = writeStorage('notation.draft', patch.draft) && cached;
  if ('scriptDraft' in patch && (!recovery?.scriptDraft || recoveryOwned || sameScript(patch.scriptDraft, recovery.scriptDraft))) cached = writeStorage('notation.scripts', patch.scriptDraft) && cached;
  if ('session' in patch && (!recovery?.session || recoveryOwned || sameSession(patch.session, recovery.session))) cached = writeStorage('notation.session', patch.session) && cached;
  if (!cached) { stashRecovery(); report('error', 'Recovery cache is unavailable. Keep the app open and save your document.'); }
  if (!nativeStore) { if (cached) { committed(patch); report('idle'); } return; }
  pending = { ...pending, ...patch };
  if (!ready) { report('error', status.error || 'Database unavailable. Recovery cache is active.'); return; }
  report('saving');
  clearTimeout(timer);
  timer = setTimeout(() => { void flushPersistence(); }, 250);
}

export function flushPersistence(): Promise<void> {
  clearTimeout(timer);
  if (!nativeStore || !ready || !Object.keys(pending).length) return writes;
  writes = writes.catch(() => {}).then(async () => {
    if (!Object.keys(pending).length) return;
    const state = pending; pending = {};
    try {
      await invoke('persist_state', { state });
      committed(state);
      report(Object.keys(pending).length ? 'saving' : 'saved');
    } catch (error) {
      pending = { ...state, ...pending };
      const retained = stashRecovery();
      report('error', 'Could not save app state to the database. ' + (retained ? 'Recovery cache is retained. ' : 'Recovery cache could not be saved. Keep the app open and save files or retry. ') + String(error));
    }
  });
  return writes;
}

export async function retryPersistence() {
  if (!ready) {
    try { await invoke('bootstrap_state', { legacy: legacyState() }); ready = true; }
    catch (error) { report('error', 'Database unavailable. Recovery cache is active. ' + String(error)); return; }
  }
  pending = { ...pending, settings: metadata.settings, draft: metadata.draft, scriptDraft: metadata.scriptDraft, session: metadata.session };
  report('saving'); await flushPersistence();
}

export async function savedScripts(): Promise<SavedScript[]> {
  if (nativeStore && ready) metadata.scripts = await invoke<SavedScript[]>('list_scripts');
  return metadata.scripts;
}
export async function saveScript(script: Omit<SavedScript, 'updatedAt'>): Promise<SavedScript> {
  await flushPersistence();
  const saved = nativeStore ? await invoke<SavedScript>('save_script', { script }) : { ...script, updatedAt: Date.now() };
  metadata.scripts = [...metadata.scripts.filter((item) => item.id !== saved.id), saved];
  writeStorage('notation.script-library', metadata.scripts);
  return saved;
}
export async function deleteScript(id: string): Promise<void> {
  if (nativeStore) await invoke('delete_script', { id });
  metadata.scripts = metadata.scripts.filter((item) => item.id !== id);
  writeStorage('notation.script-library', metadata.scripts);
}

export async function metadataSummary() {
  if (nativeStore && ready) {
    const loaded = await invoke<Metadata>('bootstrap_state');
    metadata.workspace = loaded.workspace;
    metadata.recents = loaded.recents;
  }
  return { workspace: metadata.workspace, recents: metadata.recents };
}
