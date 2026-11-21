// Connection profiles for SQL blocks. A profile is metadata only: the
// password is passed to the backend when saving or testing and is never
// part of anything the backend returns.
import { invoke, isTauri } from '@tauri-apps/api/core';

export type SqlKind = 'sqlite' | 'postgres' | 'mysql';
export type TlsMode = 'disable' | 'prefer' | 'require' | 'verify-full';
export type PasswordStorage = 'none' | 'keychain' | 'session';
export type SqlProfile = {
  name: string; kind: SqlKind; path: string; host: string; port: number; database: string; user: string;
  tlsMode: TlsMode; caFile: string; rowLimit: number; timeoutSeconds: number; passwordStorage: PasswordStorage;
};
/** `needed`: asked every session and not entered yet in this one. */
export type SqlConnection = SqlProfile & { passwordState: 'none' | 'keychain' | 'session' | 'needed' };
export type SqlConnectionList = { connections: SqlConnection[]; keychainAvailable: boolean; keychainReason: string | null; maxRowLimit: number; maxTimeoutSeconds: number };
export type SqlFailure = { code: string; message: string };

export const DESKTOP_ONLY = 'Database queries require the desktop app.';
export const kindLabels: Record<SqlKind, string> = { sqlite: 'SQLite', postgres: 'Postgres', mysql: 'MySQL' };
export const defaultPorts: Record<SqlKind, number> = { sqlite: 0, postgres: 5432, mysql: 3306 };

export function sqlFailure(cause: unknown): SqlFailure {
  if (cause && typeof cause === 'object' && typeof (cause as SqlFailure).message === 'string') return { code: String((cause as SqlFailure).code ?? 'internal'), message: (cause as SqlFailure).message };
  return { code: 'internal', message: cause instanceof Error ? cause.message : String(cause) };
}

export function newProfile(kind: SqlKind, keychainAvailable: boolean): SqlProfile {
  return {
    name: '', kind, path: '', host: kind === 'sqlite' ? '' : 'localhost', port: defaultPorts[kind], database: '', user: '',
    tlsMode: kind === 'sqlite' ? 'disable' : 'prefer', caFile: '', rowLimit: 1000, timeoutSeconds: 30,
    passwordStorage: kind === 'sqlite' ? 'none' : keychainAvailable ? 'keychain' : 'session',
  };
}

/** Where a connection points, without anything secret. Shown in Settings only. */
export function connectionSummary(connection: SqlProfile): string {
  if (connection.kind === 'sqlite') return connection.path;
  return `${connection.user}@${connection.host}:${connection.port}${connection.database ? '/' + connection.database : ''}`;
}

// The last list the backend returned, so editor highlighting and SQL blocks
// can tell a connection's kind without asking again.
let known = new Map<string, SqlConnection>(), loaded = false;
const listeners = new Set<() => void>();
export function knownConnection(name: string): SqlConnection | undefined { return known.get(name); }
export function subscribeConnections(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** Whether the connection list has been read in this session, so an unknown name can be reported. */
export function connectionsLoaded(): boolean { return loaded; }
function remember(list: SqlConnectionList) {
  loaded = true;
  known = new Map(list.connections.map((connection) => [connection.name, connection]));
  for (const listener of [...listeners]) listener();
}

export async function listConnections(): Promise<SqlConnectionList> {
  if (!isTauri()) throw { code: 'desktop', message: DESKTOP_ONLY } satisfies SqlFailure;
  const list = await invoke<SqlConnectionList>('sql_list_connections');
  remember(list);
  return list;
}
/** `password` is null to keep the one already stored. */
export async function saveConnection(profile: SqlProfile, password: string | null, original: string | null): Promise<SqlConnection> {
  const saved = await invoke<SqlConnection>('sql_save_connection', { profile, password, original });
  await listConnections();
  return saved;
}
export async function deleteConnection(name: string): Promise<void> {
  await invoke('sql_delete_connection', { name });
  await listConnections();
}
export function testConnection(profile: SqlProfile, password: string | null, original: string | null): Promise<{ server: string; durationMs: number }> {
  return invoke('sql_test_connection', { profile, password, original });
}
/** Hand over the password of an ask-every-session connection; it stays in the backend's memory. */
export async function unlockConnection(name: string, password: string): Promise<void> {
  await invoke('sql_unlock_connection', { name, password });
  await listConnections();
}
