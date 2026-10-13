import assert from 'node:assert/strict';
import { createServer } from 'vite';

// Exercises the public frontend storage API at its IPC boundary. The native
// SQLite implementation has separate Rust/native tests; this verifies that a
// healthy but older DB snapshot cannot destroy newer local recovery content.
const baseDraft = {
  id: 'draft-one', name: 'note.md', path: null, content: 'Saved DB text',
  savedContent: 'Saved DB text', savedName: 'note.md', updatedAt: 100,
};
const baseScript = { id: 'script-one', name: 'Transform', code: 'return "saved";', cwd: null, updatedAt: 100 };
const baseSession = { activeTabId: baseDraft.id, tabs: [baseDraft, { ...baseDraft, id: 'draft-two', name: 'second.md', content: 'Inactive DB text' }], updatedAt: 100 };
const baseState = { settings: {}, draft: baseDraft, scriptDraft: baseScript, scripts: [], workspace: null, recents: [] };
const server = await createServer({ cacheDir: 'node_modules/.vite-store-recovery', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, logLevel: 'error' });
let sequence = 0;

async function fixture({ cachedDraft = baseDraft, cachedScript = baseScript, cachedSession = null, database = baseState, failWrites = false, failCache = false } = {}) {
  const data = new Map([
    ['notation.draft', JSON.stringify(cachedDraft)],
    ['notation.scripts', JSON.stringify(cachedScript)],
    ['notation.session', JSON.stringify(cachedSession)],
  ]);
  const commits = [];
  globalThis.isTauri = true;
  globalThis.localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { if (failCache) throw new Error('Simulated recovery cache full'); data.set(key, value); },
  };
  globalThis.window = { __TAURI_INTERNALS__: {
    invoke: async (command, args) => {
      if (command === 'bootstrap_state') return structuredClone(database);
      if (command === 'persist_state') { if (failWrites) throw new Error('Simulated database write failure'); commits.push(structuredClone(args.state)); return null; }
      throw new Error('Unexpected command ' + command);
    },
  } };
  const store = await server.ssrLoadModule('/src/store.ts?recovery-test=' + ++sequence);
  const state = await store.bootstrapMetadata();
  const currentStatus = () => { let value; const unsubscribe = store.observePersistence((status) => value = status); unsubscribe(); return value; };
  return { store, state, data, commits, status: currentStatus, allowWrites: () => { failWrites = false; } };
}

try {
  {
    const newer = { ...baseDraft, content: 'Cached edit before process crash', updatedAt: 200 };
    const test = await fixture({ cachedDraft: newer });
    assert.equal(test.state.draft.content, baseDraft.content, 'DB state remains authoritative until explicit recovery');
    assert.equal(test.status().recovery.draft.content, newer.content, 'newer cache is offered as recoverable content');
    test.store.persistMetadata({ draft: test.state.draft });
    await test.store.flushPersistence();
    assert.equal(JSON.parse(test.data.get('notation.draft')).content, newer.content, 'initial older DB persist preserves legacy cache');
    assert.equal(JSON.parse(test.data.get('notation.pending-recovery')).draft.content, newer.content, 'older successful commit cannot clear newer recovery');
    test.store.persistMetadata({ draft: newer });
    await test.store.flushPersistence();
    assert.equal(test.status().recovery, null, 'recovery clears after matching content commits successfully');
    assert.equal(test.commits.at(-1).draft.content, newer.content);
  }
  {
    const baselineOnly = { ...baseDraft, savedContent: 'Different baseline', savedName: 'other.md', updatedAt: 300 };
    const test = await fixture({ cachedDraft: baselineOnly });
    assert.equal(test.status().recovery, null, 'baseline metadata differences do not offer false content recovery');
  }
  {
    const older = { ...baseDraft, content: 'Old cached text', updatedAt: 50 };
    const test = await fixture({ cachedDraft: older });
    assert.equal(test.status().recovery, null, 'older cache cannot replace a newer DB snapshot');
  }
  {
    const newer = { ...baseScript, code: 'return "unsaved working buffer";', updatedAt: 200 };
    const test = await fixture({ cachedScript: newer });
    assert.equal(test.state.scriptDraft.code, baseScript.code);
    assert.equal(test.status().recovery.scriptDraft.id, baseScript.id, 'saved script identity survives recovery');
    test.store.persistMetadata({ scriptDraft: test.state.scriptDraft });
    await test.store.flushPersistence();
    assert.equal(JSON.parse(test.data.get('notation.scripts')).code, newer.code, 'older startup script draft cannot overwrite recovery cache');
    test.store.persistMetadata({ scriptDraft: newer });
    await test.store.flushPersistence();
    assert.equal(test.status().recovery, null);
    assert.equal(test.commits.at(-1).scriptDraft.code, newer.code);
  }
  {
    const test = await fixture();
    test.store.persistMetadata({ scriptDraft: { ...baseScript, code: 'return "edited";' } });
    await test.store.flushPersistence();
    const editedAt = test.commits.at(-1).scriptDraft.updatedAt;
    assert.ok(editedAt > baseScript.updatedAt, 'editing script content advances recovery timestamp');
    test.store.persistMetadata({ scriptDraft: { ...baseScript, code: 'return "edited";' } });
    await test.store.flushPersistence();
    assert.equal(test.commits.at(-1).scriptDraft.updatedAt, editedAt, 'remounting unchanged script content preserves timestamp');
    test.store.dismissRecovery();
    assert.equal(test.data.get('notation.pending-recovery'), 'null');
  }
  {
    const newer = structuredClone(baseSession);
    newer.tabs[1].content = 'Newer inactive tab edit'; newer.updatedAt = 200;
    const test = await fixture({ cachedSession: newer, database: { ...baseState, session: baseSession } });
    assert.equal(test.state.session.tabs[1].content, 'Inactive DB text');
    assert.equal(test.status().recovery.session.tabs[1].content, newer.tabs[1].content);
    test.store.persistMetadata({ session: test.state.session });
    await test.store.flushPersistence();
    assert.equal(JSON.parse(test.data.get('notation.session')).tabs[1].content, newer.tabs[1].content, 'older DB startup cannot overwrite an inactive cached tab');
    assert.ok(test.status().recovery.session, 'committing older session does not discard newer recovery');
    test.store.persistMetadata({ session: newer });
    await test.store.flushPersistence();
    assert.equal(test.status().recovery, null);
    assert.deepEqual(test.commits.at(-1).session, newer);
  }
  {
    const changedSelection = structuredClone(baseSession);
    changedSelection.activeTabId = 'draft-two'; changedSelection.updatedAt = 300;
    changedSelection.tabs[1].selection = { anchor: 2, head: 7 };
    changedSelection.tabs[1].savedContent = 'Different disk baseline';
    const test = await fixture({ cachedSession: changedSelection, database: { ...baseState, session: baseSession } });
    assert.equal(test.status().recovery, null, 'selection and baseline metadata alone do not offer false content recovery');
  }
  {
    const test = await fixture({ cachedSession: baseSession, database: { ...baseState, session: baseSession }, failWrites: true });
    const newer = structuredClone(baseSession); newer.tabs[1].content = 'Pending inactive edit'; newer.updatedAt = 400;
    test.store.persistMetadata({ session: newer });
    await test.store.flushPersistence();
    assert.equal(test.status().state, 'error');
    assert.equal(JSON.parse(test.data.get('notation.pending-recovery')).session.tabs[1].content, newer.tabs[1].content);
    test.allowWrites();
    await test.store.retryPersistence();
    assert.equal(test.status().state, 'saved');
    assert.equal(test.status().recovery, null);
    assert.equal(test.commits.at(-1).session.tabs[1].content, newer.tabs[1].content);
  }
  {
    const test = await fixture({ cachedSession: { tabs: null, updatedAt: 500 }, database: { ...baseState, session: baseSession } });
    assert.equal(test.status().state, 'saved', 'malformed local session must not make a healthy database unavailable');
    assert.deepEqual(test.state.session, baseSession);
  }
  {
    const test = await fixture({ cachedSession: baseSession, database: { ...baseState, session: baseSession }, failWrites: true, failCache: true });
    const newer = structuredClone(baseSession); newer.tabs[1].content = 'Only surviving in memory'; newer.updatedAt = 600;
    test.store.persistMetadata({ session: newer });
    await test.store.flushPersistence();
    assert.equal(test.status().state, 'error');
    assert.equal(test.store.currentMetadata().session.tabs[1].content, newer.tabs[1].content, 'both persistence failures must leave the in-memory document editable');
    assert.doesNotMatch(test.status().error, /cache is retained/i, 'do not claim a recovery copy exists when both stores failed');
    assert.match(test.status().error, /keep.*open|save.*(?:document|file)/i, 'tell the user how to preserve the in-memory edits');
  }
  console.log('Store recovery: 10 scenarios passed');
} finally {
  await server.close();
}
