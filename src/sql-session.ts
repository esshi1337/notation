// Results of SQL blocks for this app session. They live in memory only:
// nothing here is written to the note, a draft, settings or storage.
import { invoke, isTauri } from '@tauri-apps/api/core';
import { DESKTOP_ONLY, sqlFailure } from './sql-connections';
import type { SqlResult } from './sql-format';

export type SqlRunState =
  | { status: 'running'; id: string; startedAt: number; cancelling?: boolean }
  | { status: 'done'; result: SqlResult }
  | { status: 'error'; code: string; message: string };

const MAX_KEPT = 48;
const states = new Map<string, SqlRunState>();
const listeners = new Map<string, Set<() => void>>();

/** A block is identified by its document, connection and exact SQL, so editing the query starts fresh. */
export function sqlKey(scope: string, connection: string, sql: string): string { return [scope, connection, sql].join('\u0000'); }
export function sqlState(key: string): SqlRunState | undefined { return states.get(key); }
export function subscribeSql(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, set = new Set());
  set.add(listener);
  return () => { set.delete(listener); if (!set.size && listeners.get(key) === set) listeners.delete(key); };
}
function publish(key: string, state: SqlRunState) {
  // Re-inserting keeps the map in least-recently-updated order.
  states.delete(key); states.set(key, state);
  for (const [old, value] of states) { if (states.size <= MAX_KEPT) break; if (value.status !== 'running' && old !== key) states.delete(old); }
  for (const listener of [...listeners.get(key) ?? []]) listener();
}

/** Run a block. Only ever called from a user action: a Run button or its shortcut. */
export async function runSql(key: string, connection: string, sql: string, parameters: Record<string, unknown>): Promise<void> {
  if (states.get(key)?.status === 'running') return;
  if (!isTauri()) { publish(key, { status: 'error', code: 'desktop', message: DESKTOP_ONLY }); return; }
  const id = crypto.randomUUID();
  publish(key, { status: 'running', id, startedAt: Date.now() });
  const mine = () => { const state = states.get(key); return state?.status === 'running' && state.id === id; };
  try {
    const result = await invoke<SqlResult>('sql_run', { request: { id, connection, sql, parameters } });
    if (mine()) publish(key, { status: 'done', result });
  } catch (cause) {
    if (mine()) publish(key, { status: 'error', ...sqlFailure(cause) });
  }
}
/** Ask the backend to stop the running query on the server. The run then ends with a `cancelled` error. */
export async function cancelSql(key: string): Promise<void> {
  const state = states.get(key);
  if (state?.status !== 'running' || state.cancelling) return;
  publish(key, { ...state, cancelling: true });
  try { await invoke('sql_cancel', { id: state.id }); } catch { /* The run reports its own outcome. */ }
}
/** Forget a block's outcome, for example after its connection was unlocked. */
export function clearSql(key: string) { if (states.get(key)?.status !== 'running') { states.delete(key); for (const listener of [...listeners.get(key) ?? []]) listener(); } }
/** The last successful result of a block in this session, if it was run. */
export function sqlResult(scope: string, connection: string, sql: string): SqlResult | undefined {
  const state = states.get(sqlKey(scope, connection, sql));
  return state?.status === 'done' ? state.result : undefined;
}
