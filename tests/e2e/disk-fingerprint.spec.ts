import { expect, test, type Page } from '@playwright/test';

const original = '# Original\n\nInitial text.';
const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
type Mock = { disk: string; reads: number; prints: number; version: number; ageMs: number; mode: 'ok' | 'missing' | 'failing' };
const mock = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { diskMock: Mock }).diskMock }));
const set = (page: Page, values: Partial<Mock>) => page.evaluate((next) => { Object.assign((window as unknown as { diskMock: Mock }).diskMock, next); }, values);
const focus = (page: Page) => page.evaluate(() => { window.dispatchEvent(new Event('focus')); });

/** A desktop window with one saved tab; the file's fingerprint follows `version` and is `ageMs` old. */
async function setup(page: Page, ageMs = 60_000) {
  await page.addInitScript(({ original, ageMs }) => {
    const state: Mock = { disk: original, reads: 0, prints: 0, version: 1, ageMs, mode: 'ok' };
    // A fixed modification time: old enough to trust, or (for a 'recent' file) one that never becomes two seconds old.
    const modifiedMs = ageMs < 2000 ? Date.now() + 3_600_000 : Date.now() - ageMs;
    const tabs = [{ id: 'one', name: 'one.md', path: '/one.md', content: original, savedContent: original, savedName: 'one.md', updatedAt: 1 }];
    Object.assign(window, { diskMock: state, isTauri: true, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: (path: string) => path,
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        if (cmd === 'bootstrap_state') return { settings: { layout: 'source', automaticallyReloadExternalChanges: true }, draft: null, scriptDraft: null, scripts: [], recents: [], workspace: null, workspaceCatalog: { activeId: null, workspaces: [] }, session: { activeTabId: 'one', tabs, updatedAt: 1 } };
        if (cmd === 'document_fingerprint') {
          state.prints++;
          if (state.mode === 'failing') throw new Error('stat failed');
          if (state.mode === 'missing') return null;
          const modified = BigInt(modifiedMs) * 1_000_000n + BigInt(state.version);
          return { size: '25', modifiedNs: modified.toString(), device: '1', inode: String(100 + state.version) };
        }
        if (cmd === 'read_document_snapshot') { state.reads++; return { path: args.path, content: state.disk }; }
        if (cmd === 'launch_ready') return [];
        if (cmd === 'plugin:event|listen') return 1;
        return null;
      },
    }, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} } });
  }, { original, ageMs });
  await page.goto('/');
  await expect(source(page)).toBeVisible();
  await expect.poll(async () => (await mock(page)).reads).toBeGreaterThan(0);
}
/** Several disk checks; resolves once they have all asked for the fingerprint. */
async function checks(page: Page, count: number) {
  for (let index = 0; index < count; index++) {
    const before = (await mock(page)).prints;
    await focus(page);
    await expect.poll(async () => (await mock(page)).prints).toBeGreaterThan(before);
  }
  await page.waitForTimeout(100);
}

test('an unchanged, settled file is fingerprinted, not read again', async ({ page }) => {
  await setup(page);
  // The first read may have raced the first fingerprint; settle on one known state.
  await checks(page, 1);
  const { reads } = await mock(page);
  await checks(page, 6);
  expect((await mock(page)).reads).toBe(reads);
  // The 750 ms poll behaves the same.
  const prints = (await mock(page)).prints;
  await expect.poll(async () => (await mock(page)).prints, { timeout: 8000 }).toBeGreaterThan(prints + 2);
  expect((await mock(page)).reads).toBe(reads);

  // A new fingerprint means a read, and the changed content is picked up.
  await set(page, { disk: '# Changed elsewhere', version: 2 });
  await focus(page);
  await expect(source(page).locator('.cm-line').first()).toHaveText('# Changed elsewhere');
  const afterChange = (await mock(page)).reads;
  expect(afterChange).toBeGreaterThan(reads);
  // The reloaded state becomes the known one.
  await checks(page, 4);
  expect((await mock(page)).reads).toBeLessThanOrEqual(afterChange + 1);
});

test('a file modified within the last two seconds is always read', async ({ page }) => {
  await setup(page, 500);
  await checks(page, 1);
  const { reads } = await mock(page);
  await checks(page, 3);
  expect((await mock(page)).reads).toBeGreaterThanOrEqual(reads + 3);
  // Same size, same timestamp, different content: found because it is read.
  await set(page, { disk: '# Rewritten in place.....' });
  await focus(page);
  await expect(source(page).locator('.cm-line').first()).toHaveText('# Rewritten in place.....');
});

for (const mode of ['missing', 'failing'] as const) {
  test(`a ${mode} fingerprint falls back to reading the file`, async ({ page }) => {
    await setup(page);
    await set(page, { mode });
    await checks(page, 1);
    const { reads } = await mock(page);
    await checks(page, 3);
    expect((await mock(page)).reads).toBeGreaterThanOrEqual(reads + 3);
    await set(page, { disk: '# Changed while fingerprints fail' });
    await focus(page);
    await expect(source(page).locator('.cm-line').first()).toHaveText('# Changed while fingerprints fail');
  });
}
