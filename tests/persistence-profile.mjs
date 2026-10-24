import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';

// Isolates frontend persistence work. IPC is simulated, so these measurements
// describe serialized payloads and V8 observations, not WebKit or native PSS.
const source = process.argv[2] || '/src/store.ts';
const originalStringify = JSON.stringify;
const mib = (bytes) => Number((bytes / 1024 / 1024).toFixed(3));
let active = null;
JSON.stringify = function (...args) {
  const result = originalStringify.apply(JSON, args);
  if (active && typeof result === 'string') {
    active.stringifyCalls++;
    active.stringifyChars += result.length;
  }
  return result;
};
const text = ('Text with "quotes", \\slashes and Unicode café.\n').repeat(12000).slice(0, 512 * 1024);
const tabs = Array.from({ length: 8 }, (_, index) => ({
  id: `tab-${index}`, name: `note-${index}.txt`, path: null,
  content: text, savedContent: text, savedName: `note-${index}.txt`,
  selection: { anchor: 0, head: 0 }, updatedAt: 100, hemingway: false,
}));
const session = { activeTabId: tabs[0].id, tabs, updatedAt: 100 };
const database = { settings: {}, draft: tabs[0], session, scriptDraft: null,
  scripts: [], workspace: null, workspaceCatalog: { activeId: null, workspaces: [] }, recents: [] };
const cache = new Map([
  ['notation.draft', originalStringify(tabs[0])],
  ['notation.session', originalStringify(session)],
]);
let failWrites = false;
globalThis.isTauri = true;
globalThis.localStorage = {
  getItem: key => cache.get(key) ?? null,
  setItem: (key, value) => {
    cache.set(key, value);
    if (active) { active.cacheWrites++; active.cacheChars += value.length; }
  },
};
globalThis.window = { __TAURI_INTERNALS__: {
  invoke: async (command, args) => {
    if (active) {
      active.ipcCalls++;
      active.ipcRequestChars += originalStringify(args ?? {}).length;
    }
    let response;
    if (command === 'bootstrap_state') response = database;
    else if (command === 'metadata_summary') response = {
      workspace: database.workspace, workspaceCatalog: database.workspaceCatalog, recents: database.recents,
    };
    else if (command === 'persist_state') {
      if (failWrites) throw new Error('Controlled database failure');
      Object.assign(database, args.state);
      response = null;
    } else throw new Error(`Unexpected command ${command}`);
    const wire = originalStringify(response);
    if (active) active.ipcResponseChars += wire.length;
    return JSON.parse(wire);
  },
} };
const server = await createServer({
  cacheDir: 'node_modules/.vite-persistence-profile',
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true }, logLevel: 'error',
});
const report = { source, node: process.version, tabs: tabs.length, contentCharsPerTab: text.length,
  forcedGc: typeof globalThis.gc === 'function', phases: [] };
async function phase(name, work) {
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  active = { name, stringifyCalls: 0, stringifyChars: 0, cacheWrites: 0, cacheChars: 0,
    ipcCalls: 0, ipcRequestChars: 0, ipcResponseChars: 0 };
  const start = performance.now();
  await work();
  const elapsed = performance.now() - start;
  const after = process.memoryUsage().heapUsed;
  const result = active;
  active = null;
  globalThis.gc?.();
  report.phases.push({ ...result, elapsedMs: Number(elapsed.toFixed(2)),
    heapBeforeMiB: mib(before), heapAfterBeforeGcMiB: mib(after), heapAfterGcMiB: mib(process.memoryUsage().heapUsed) });
}
try {
  const store = await server.ssrLoadModule(source);
  await phase('matching-startup', () => store.bootstrapMetadata());
  await phase('selection-only-20', async () => {
    for (let i = 0; i < 20; i++) {
      const next = { ...session, tabs: tabs.map((tab, index) => index ? tab : { ...tab, selection: { anchor: i, head: i } }), updatedAt: 200 + i };
      store.persistMetadata({ draft: next.tabs[0] });
      store.persistMetadata({ session: next });
      await store.flushPersistence();
    }
  });
  failWrites = true;
  const pending = { ...session, tabs: tabs.map((tab, index) => index ? tab : { ...tab, content: text + 'edit', updatedAt: 300 }), updatedAt: 300 };
  store.persistMetadata({ draft: pending.tabs[0], session: pending });
  await store.flushPersistence();
  failWrites = false;
  await phase('matching-recovery-retry', () => store.retryPersistence());
  let status;
  const unsubscribe = store.observePersistence(value => { status = value; });
  unsubscribe();
  assert.equal(status.state, 'saved');
  assert.equal(status.recovery, null);
  await phase('workspace-summary-5', async () => {
    for (let i = 0; i < 5; i++) assert.deepEqual((await store.metadataSummary()).recents, []);
  });
  console.log(originalStringify(report, null, 2));
} finally {
  JSON.stringify = originalStringify;
  await server.close();
}
