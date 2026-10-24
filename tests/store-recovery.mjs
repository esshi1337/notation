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

async function fixture({ cachedDraft = baseDraft, cachedScript = baseScript, cachedSession = null, pendingRecovery = null, database = baseState, failWrites = false, failCache = false, cacheLimit = Infinity, native = true, scriptLibrary = null } = {}) {
  const data = new Map([
    ['notation.draft', JSON.stringify(cachedDraft)],
    ['notation.scripts', JSON.stringify(cachedScript)],
    ['notation.session', JSON.stringify(cachedSession)],
    ['notation.pending-recovery', JSON.stringify(pendingRecovery)],
    ['notation.script-library', JSON.stringify(scriptLibrary)],
  ]);
  const commits = [];
  const commands = [];
  const cacheAttempts = [];
  let writeGate, writeStarted;
  globalThis.isTauri = native;
  globalThis.localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { cacheAttempts.push(key); if (failCache || Buffer.byteLength(value) > cacheLimit) throw new Error('Simulated recovery cache full'); data.set(key, value); },
  };
  globalThis.window = native ? { __TAURI_INTERNALS__: {
    invoke: async (command, args) => {
      commands.push(command);
      if (command === 'bootstrap_state') return structuredClone(database);
      if (command === 'metadata_summary') return structuredClone({ workspace: database.workspace, workspaceCatalog: database.workspaceCatalog, recents: database.recents });
      if (command === 'persist_state') {
        if (Buffer.byteLength(JSON.stringify(args.state.session ?? null)) > 32 * 1024 * 1024) throw new Error('Session exceeds the 32 MiB recovery limit. No tabs were dropped or replaced.');
        if (writeGate) { const gate = writeGate; writeGate = null; writeStarted(); await gate; }
        if (failWrites) throw new Error('Simulated database write failure');
        commits.push(structuredClone(args.state)); return null;
      }
      throw new Error('Unexpected command ' + command);
    },
  } } : {};
  const store = await server.ssrLoadModule('/src/store.ts?recovery-test=' + ++sequence);
  const state = await store.bootstrapMetadata();
  const currentStatus = () => { let value; const unsubscribe = store.observePersistence((status) => value = status); unsubscribe(); return value; };
  return { store, state, data, commits, commands, cacheAttempts, status: currentStatus, allowWrites: () => { failWrites = false; },
    blockNextWrite: () => {
      let release;
      const started = new Promise(resolve => { writeStarted = resolve; });
      writeGate = new Promise(resolve => { release = resolve; });
      return { started, release };
    },
  };
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
  {
    for (const change of [
      value => { value.tabs.reverse(); },
      value => { value.tabs.pop(); },
      value => { value.tabs[1].id = 'replacement'; },
      value => { value.tabs[1].name = 'renamed.md'; },
      value => { value.tabs[1].path = '/different.md'; },
      value => { delete value.tabs[1].path; },
      value => { value.tabs[1].content += '\n"escaped" \\ café'; },
      value => { value.tabs[1].hemingway = true; },
    ]) {
      const newer = structuredClone(baseSession); newer.updatedAt = 700;
      change(newer);
      const test = await fixture({ cachedSession: newer, database: { ...baseState, session: baseSession } });
      assert.deepEqual(test.status().recovery.session, newer, 'recover meaningful ordered tab changes');
    }
    const same = structuredClone(baseSession); same.updatedAt = 701;
    same.tabs.forEach(tab => { tab.hemingway = false; });
    const test = await fixture({ cachedSession: same, database: { ...baseState, session: baseSession } });
    assert.equal(test.status().recovery, null, 'missing and false Hemingway flags are equivalent');
  }
  {
    const test = await fixture({ cachedSession: baseSession, database: { ...baseState, session: baseSession }, failWrites: true });
    const older = structuredClone(baseSession); older.tabs[1].content = 'First unsaved version'; older.updatedAt = 800;
    test.store.persistMetadata({ session: older });
    await test.store.flushPersistence();
    test.allowWrites();
    const blocked = test.blockNextWrite();
    const retry = test.store.retryPersistence();
    await blocked.started;
    const newer = structuredClone(older); newer.tabs[1].content = 'Edited during in-flight retry'; newer.updatedAt = 801;
    test.store.persistMetadata({ session: newer });
    blocked.release();
    await retry;
    assert.deepEqual(test.status().recovery.session, newer, 'older successful retry cannot clear newer recovery');
    assert.deepEqual(JSON.parse(test.data.get('notation.pending-recovery')).session, newer);
    await test.store.flushPersistence();
    assert.equal(test.status().recovery, null);
    assert.deepEqual(test.commits.at(-1).session, newer, 'newer pending snapshot commits next');
  }
  {
    const database = { ...baseState, session: baseSession, workspace: '/workspace',
      workspaceCatalog: { activeId: 'work', workspaces: [] }, recents: [{ path: '/workspace/a.md' }] };
    const test = await fixture({ database });
    const sessionBefore = test.store.currentMetadata().session;
    database.recents = [{ path: '/workspace/b.md' }];
    const summary = await test.store.metadataSummary();
    assert.deepEqual(summary, { workspace: '/workspace', recents: database.recents });
    assert.equal(test.commands.at(-1), 'metadata_summary', 'recent-file refresh avoids full bootstrap');
    assert.equal(test.commands.filter(command => command === 'bootstrap_state').length, 1);
    assert.equal(test.store.currentMetadata().session, sessionBefore, 'summary does not reload document buffers');
    assert.deepEqual(test.store.currentMetadata().workspaceCatalog, database.workspaceCatalog);
  }
  {
    const test = await fixture({ database: { ...baseState, session: baseSession }, cacheLimit: 4 * 1024 * 1024 });
    const content = 'é'.repeat(1_100_000);
    const huge = { activeTabId: 'large-0', updatedAt: 900, tabs: Array.from({ length: 8 }, (_, i) => ({ ...baseDraft, id: `large-${i}`, content, savedContent: content })) };
    test.store.persistMetadata({ session: huge, settings: { theme: 'dark' } });
    assert.equal(await test.store.flushPersistence(), true);
    assert.deepEqual(test.commits.at(-1).settings, { theme: 'dark' });
    assert.ok(!('session' in test.commits.at(-1)));
    const attempts = test.cacheAttempts.length;
    test.store.persistMetadata({ settings: { fontSize: 18 } });
    await test.store.flushPersistence();
    await test.store.retryPersistence();
    assert.ok(test.commits.every(patch => !('session' in patch)), 'retries cannot reintroduce oversized session');
    assert.deepEqual(test.cacheAttempts.slice(attempts), ['notation.settings'], 'known oversize buffers do not churn recovery quota');
    assert.match(test.status().error, /Session too large to autosave; save tabs as files/);
    assert.doesNotMatch(test.status().error, /cache is retained|database/i);
    assert.equal(test.store.currentMetadata().session, huge, 'all content remains in memory');
    test.store.persistMetadata({ session: baseSession });
    assert.equal(await test.store.flushPersistence(), true);
    assert.deepEqual(test.commits.at(-1).session, baseSession);
    assert.equal(test.status().state, 'saved');
  }
  {
    for (const failCache of [false, true]) {
      const older = { ...baseSession, updatedAt: 50 };
      const test = await fixture({ cachedSession: older, pendingRecovery: { session: older, failedAt: 50 }, database: { ...baseState, session: baseSession }, failWrites: true, failCache });
      assert.equal(test.status().recovery, null, 'stale inherited recovery is not an offer');
      const current = structuredClone(baseSession); current.updatedAt = 1000; current.tabs[1].content = 'Current edit after restart';
      test.store.persistMetadata({ session: current });
      await test.store.flushPersistence();
      if (!failCache) {
        assert.deepEqual(JSON.parse(test.data.get('notation.session')), current);
        assert.deepEqual(JSON.parse(test.data.get('notation.pending-recovery')).session, current);
      } else {
        assert.doesNotMatch(test.status().error, /cache is retained/i);
        assert.match(test.status().error, /cache could not be saved/i);
      }
    }
  }
  {
    const test = await fixture({ failWrites: true });
    test.store.persistMetadata({ settings: { theme: 'dark' } });
    assert.equal(await test.store.flushPersistence(), false);
    test.allowWrites();
    assert.equal(await test.store.flushPersistence(), true);
    assert.equal(await test.store.flushPersistence(), true, 'empty flush retains latest outcome');
  }
  {
    const existing = [{ id: 'saved-one', name: 'Saved', code: 'return 1;', cwd: null, updatedAt: 100 }];
    const test = await fixture({ native: false, scriptLibrary: existing });
    const before = structuredClone(test.store.currentMetadata().scripts);
    const attempts = test.cacheAttempts.length;
    await assert.rejects(
      () => test.store.saveScript({ id: 'too-big', name: 'Too big', code: 'x'.repeat(128 * 1024 + 1), cwd: null }),
      /128 KiB/,
      'browser mode rejects oversized scripts before writing',
    );
    assert.deepEqual(test.store.currentMetadata().scripts, before, 'rejected script leaves the library untouched');
    assert.deepEqual(JSON.parse(test.data.get('notation.script-library')), existing, 'rejected script is not persisted');
    assert.ok(!test.cacheAttempts.slice(attempts).includes('notation.script-library'), 'rejected script never writes script-library storage');
  }
  console.log('Store recovery: 17 scenario groups passed (including 9 content comparisons)');
} finally {
  await server.close();
}
