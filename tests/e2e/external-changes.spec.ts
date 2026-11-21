import { expect, test, type Page } from '@playwright/test';
import { openSettings, renameDocument, runCommand, settled } from './commands';

const original = '# Original one\n\nInitial text.';
const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const tab = (page: Page, name: string) => page.getByRole('tablist', { name: 'Documents', exact: true }).getByRole('tab', { name, exact: true });
const banner = (page: Page) => page.locator('.disk-conflict-banner');
async function expectSource(page: Page, text: string, timeout = 5000) {
  await expect(source(page).locator('.cm-line')).toHaveText(text.split('\n'), { timeout });
}
type Mock = {
  disk: Record<string, string>; failure: string; delay: boolean; pending: (() => void)[];
  reads: string[]; concurrent: number; maximum: number; writes: number;
  delaySave: boolean; saves: (() => void)[];
};
const state = (page: Page) => page.evaluate(() => {
  const mock = (window as unknown as { externalMock: Mock }).externalMock;
  return { reads: mock.reads, concurrent: mock.concurrent, maximum: mock.maximum, writes: mock.writes, pending: mock.pending.length, saves: mock.saves.length };
});
async function change(page: Page, content: string) {
  await page.evaluate(content => { (window as unknown as { externalMock: Mock }).externalMock.disk['/one.md'] = content; }, content);
}
async function setup(page: Page, options: { enabled?: boolean; path?: string | null; hemingway?: boolean } = {}) {
  await page.addInitScript(({ options, original }) => {
    const tabs = [
      { id: 'one', name: 'one.md', path: options.path === undefined ? '/one.md' : options.path, content: original, hemingway: options.hemingway },
      { id: 'two', name: 'two.md', path: '/two.md', content: '# Original two' },
    ].map(tab => ({ ...tab, savedContent: tab.content, savedName: tab.name, updatedAt: 1 }));
    const mock: Mock = {
      disk: { '/one.md': original, '/two.md': '# Original two' }, failure: '', delay: false, pending: [],
      reads: [], concurrent: 0, maximum: 0, writes: 0, delaySave: false, saves: [],
    };
    Object.assign(window, { externalMock: mock, isTauri: true, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: (path: string) => path,
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        if (cmd === 'bootstrap_state') return {
          settings: { layout: 'split', automaticallyReloadExternalChanges: options.enabled ?? true }, draft: null,
          scriptDraft: null, scripts: [], recents: [], workspace: null,
          workspaceCatalog: { activeId: null, workspaces: [] }, session: { activeTabId: 'one', tabs, updatedAt: 1 },
        };
        if (cmd === 'read_document_snapshot') {
          const path = String(args.path);
          mock.reads.push(path); mock.concurrent++; mock.maximum = Math.max(mock.maximum, mock.concurrent);
          const content = mock.disk[path], failure = mock.failure;
          try {
            if (mock.delay) await new Promise<void>(resolve => mock.pending.push(resolve));
            if (failure) throw new Error(failure);
            if (content === undefined) throw new Error('Missing file');
            return { path, content };
          } finally { mock.concurrent--; }
        }
        if (cmd === 'resolve_document_path') return { path: args.path };
        if (cmd === 'write_document_checked' || cmd === 'write_document') {
          mock.writes++;
          if (mock.delaySave) await new Promise<void>(resolve => mock.saves.push(resolve));
          const path = String(args.path), content = String(args.content);
          if (cmd === 'write_document_checked' && mock.disk[path] !== args.expectedContent) throw new Error('Changed on disk');
          mock.disk[path] = content;
          return { path, content };
        }
        if (cmd === 'launch_ready') return [];
        if (cmd === 'plugin:event|listen') return 1;
        if (cmd === 'plugin:dialog|ask') return true;
        return null;
      },
    }, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} } });
  }, { options, original });
  await page.goto('/');
  await expectSource(page, original);
}
async function toggle(page: Page, enabled: boolean) {
  await openSettings(page);
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  await settings.getByRole('checkbox', { name: 'Automatically reload external changes', exact: true }).setChecked(enabled);
  await settings.getByRole('button', { name: 'Close settings' }).click();
}
async function holdRead(page: Page, content = '# Stale external result') {
  await page.evaluate(content => {
    const mock = (window as unknown as { externalMock: Mock }).externalMock;
    mock.disk['/one.md'] = content; mock.delay = true;
    window.dispatchEvent(new Event('focus'));
  }, content);
  await expect.poll(async () => (await state(page)).pending).toBe(1);
  // A subsequent check must read the current disk, not reuse the stale result.
  await change(page, original);
}
async function release(page: Page) {
  await page.evaluate(() => {
    const mock = (window as unknown as { externalMock: Mock }).externalMock;
    mock.delay = false; mock.pending.splice(0).forEach(resolve => resolve());
  });
  await expect.poll(async () => (await state(page)).concurrent).toBe(0);
}
async function nextPoll(page: Page) {
  const count = (await state(page)).reads.length;
  await expect.poll(async () => (await state(page)).reads.length).toBeGreaterThan(count);
}

test('focused clean document refreshes source and Markdown preview without a focus event or source write', async ({ page }) => {
  await setup(page);
  const editor = await source(page).elementHandle();
  await source(page).focus();
  await page.keyboard.press('ControlOrMeta+End');
  await change(page, '# Updated externally\n\n**Fresh preview**');
  await expectSource(page, '# Updated externally\n\n**Fresh preview**', 1800);
  await expect(page.locator('.preview-pane').getByRole('heading', { name: 'Updated externally' })).toBeVisible();
  await expect(page.locator('.preview-pane strong')).toHaveText('Fresh preview');
  expect(await editor!.evaluate(node => node.isConnected)).toBe(true);
  await expect(banner(page)).toHaveCount(0);
  expect((await state(page)).writes).toBe(0);
  expect((await state(page)).reads.every(path => path === '/one.md')).toBe(true);
  // The old end position is preserved/clamped, and an unchanged poll leaves it.
  await change(page, '# Short');
  await expectSource(page, '# Short');
  await nextPoll(page);
  await page.keyboard.type('!');
  await expectSource(page, '# Short!');
});

test('disabled preserves content and keeps the existing manual focus conflict UI', async ({ page }) => {
  await setup(page, { enabled: false });
  await change(page, '# External');
  await page.waitForTimeout(1200);
  await expectSource(page, original);
  await expect(banner(page)).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(banner(page)).toContainText('changed on disk');
  await expect(banner(page).getByRole('button', { name: 'Compare / reload' })).toBeVisible();
  await expectSource(page, original);
});

test('undo after automatic reload keeps the restored text as a protected unsaved edit', async ({ page }) => {
  await setup(page);
  await change(page, '# Reloaded from disk');
  await expectSource(page, '# Reloaded from disk');
  await source(page).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expectSource(page, original);
  await expect(page).toHaveTitle('• one.md — Notation');
  await nextPoll(page);
  await expectSource(page, original);
  await change(page, '# A later external change');
  await expect(banner(page)).toContainText('changed on disk');
  await expectSource(page, original);
  expect((await state(page)).writes).toBe(0);
});

for (const protection of ['typed text', 'renamed tab', 'Hemingway']) {
  test(`${protection} keeps local content with actionable conflict UI`, async ({ page }) => {
    await setup(page, { hemingway: protection === 'Hemingway' });
    if (protection === 'typed text') await source(page).fill('Local unsaved text');
    if (protection === 'renamed tab') await renameDocument(page, 'renamed.md');
    await change(page, '# External');
    await expect(banner(page)).toContainText('changed on disk');
    await expect(banner(page).getByRole('button', { name: 'Compare / reload' })).toBeVisible();
    await expectSource(page, protection === 'typed text' ? 'Local unsaved text' : original);
    if (protection === 'renamed tab') await expect(tab(page, 'renamed.md')).toBeVisible();
    expect((await state(page)).writes).toBe(0);
  });
}

for (const action of ['typing', 'typing then undo', 'disable', 'switch away and back', 'close', 'save unchanged content', 'toggle off and on', 'Hemingway on and off']) {
  test(`delayed read cannot overwrite after ${action}`, async ({ page }) => {
    await setup(page);
    await holdRead(page);
    if (action === 'typing') await source(page).fill('Typed while reading');
    if (action === 'typing then undo') { await source(page).fill('Temporary edit'); await page.keyboard.press('ControlOrMeta+z'); await expectSource(page, original); }
    if (action === 'disable') await toggle(page, false);
    if (action === 'toggle off and on') { await toggle(page, false); await toggle(page, true); }
    if (action === 'switch away and back') { await tab(page, 'two.md').click(); await tab(page, 'one.md').click(); }
    if (action === 'Hemingway on and off') { await runCommand(page, 'Hemingway mode'); await runCommand(page, 'Hemingway mode'); }
    if (action === 'close') await page.getByRole('button', { name: 'Close tab: one.md', exact: true }).click();
    if (action === 'save unchanged content') {
      await page.keyboard.press('ControlOrMeta+s');
      await expect.poll(async () => (await state(page)).writes).toBe(1);
      await expect(page.getByRole('status').filter({ hasText: 'Saved one.md' })).toBeVisible();
    }
    await release(page);
    if (action !== 'disable') await nextPoll(page);
    await expectSource(page, action === 'typing' ? 'Typed while reading' : action === 'close' ? '# Original two' : original);
    await expect(banner(page)).toHaveCount(0);
    expect((await state(page)).maximum).toBe(1);
    if (action === 'disable') {
      const reads = (await state(page)).reads.length;
      await page.waitForTimeout(1100);
      expect((await state(page)).reads.length).toBe(reads);
    }
  });
}

test('read finishing during a delayed save preserves the buffer and checked-write behavior', async ({ page }) => {
  await setup(page);
  await holdRead(page);
  await page.evaluate(() => { (window as unknown as { externalMock: Mock }).externalMock.delaySave = true; });
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(async () => (await state(page)).saves).toBe(1);
  await release(page);
  await expectSource(page, original);
  await page.evaluate(() => {
    const mock = (window as unknown as { externalMock: Mock }).externalMock;
    mock.delaySave = false; mock.saves.splice(0).forEach(resolve => resolve());
  });
  await nextPoll(page);
  await expectSource(page, original);
  await change(page, '# New after save');
  await expectSource(page, '# New after save');
});

for (const failure of ['Missing file during atomic replacement', 'Invalid UTF-8 or file too large']) {
  test(`poll recovers after ${failure}`, async ({ page }) => {
    await setup(page);
    await page.evaluate(failure => { (window as unknown as { externalMock: Mock }).externalMock.failure = failure; }, failure);
    await expect(banner(page)).toContainText('File unavailable on disk');
    await expectSource(page, original);
    await page.evaluate(() => {
      const mock = (window as unknown as { externalMock: Mock }).externalMock;
      mock.failure = ''; mock.disk['/one.md'] = '# Recovered';
    });
    await expectSource(page, '# Recovered');
    await expect(banner(page)).toHaveCount(0);
    expect((await state(page)).writes).toBe(0);
  });
}

test('repeated toggles and focus events coalesce reads and stop polling when disabled', async ({ page }) => {
  await setup(page);
  await holdRead(page);
  for (let i = 0; i < 3; i++) {
    await toggle(page, false); await toggle(page, true);
    await page.evaluate(() => { for (let n = 0; n < 10; n++) window.dispatchEvent(new Event('focus')); });
  }
  expect((await state(page)).concurrent).toBe(1);
  expect((await state(page)).pending).toBe(1);
  await release(page);
  await change(page, '# Latest');
  await expectSource(page, '# Latest');
  expect((await state(page)).maximum).toBe(1);
  await toggle(page, false);
  await expect.poll(async () => (await state(page)).concurrent).toBe(0);
  const count = (await state(page)).reads.length;
  await page.waitForTimeout(1600);
  expect((await state(page)).reads.length).toBe(count);
});

for (const path of [null, '', '   ', 'relative.md', 'browser:one.md', '/bad\0path']) {
  test(`does not read an invalid or unsaved path ${JSON.stringify(path)}`, async ({ page }) => {
    await setup(page, { path });
    await page.waitForTimeout(1100);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect((await state(page)).reads).toEqual([]);
    await expectSource(page, original);
  });
}


test('closing an inactive tab keeps the active file polling', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Close tab: two.md', exact: true }).click();
  await change(page, '# Active file still refreshes');
  await expectSource(page, '# Active file still refreshes', 1800);
  expect((await state(page)).reads.every(path => path === '/one.md')).toBe(true);
});

test('enabling refresh immediately reloads an already changed clean file', async ({ page }) => {
  await setup(page, { enabled: false });
  await change(page, '# Changed before enabling');
  await toggle(page, true);
  await expectSource(page, '# Changed before enabling', 1800);
  await expect(banner(page)).toHaveCount(0);
});

test('saving a dirty conflict still uses the checked write and preserves both versions on failure', async ({ page }) => {
  await setup(page);
  await source(page).fill('My unsaved text');
  await change(page, '# External version');
  await expect(banner(page)).toContainText('changed on disk');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.app-error')).toContainText('Changed on disk');
  await expectSource(page, 'My unsaved text');
  expect(await page.evaluate(() => (window as unknown as { externalMock: Mock }).externalMock.disk['/one.md'])).toBe('# External version');
});

test('the file-changed comparison uses the shared dialog styling', async ({ page }) => {
  await setup(page);
  await source(page).fill('My unsaved text');
  await change(page, '# External version');
  await banner(page).getByRole('button', { name: 'Compare / reload' }).click();
  const dialog = page.getByRole('dialog', { name: 'File changed on disk', exact: true });
  await settled(dialog);
  await expect(dialog.locator('pre')).toBeVisible();
  expect(await dialog.evaluate((element) => {
    const style = getComputedStyle(element), close = element.querySelector('.navigator-heading button')!.getBoundingClientRect();
    const actions = [...element.querySelectorAll('.dialog-actions button')].map((button) => Math.round(button.getBoundingClientRect().height));
    return { radius: style.borderTopLeftRadius, shadow: style.boxShadow !== 'none', backdrop: getComputedStyle(element, '::backdrop').backgroundColor, close: [Math.round(close.width), Math.round(close.height)], actions: Math.min(...actions) >= 32 };
  })).toEqual({ radius: '16px', shadow: true, backdrop: 'rgba(0, 0, 0, 0.48)', close: [28, 28], actions: true });
  await page.screenshot({ path: 'test-results/file-changed-dialog.png' });
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
