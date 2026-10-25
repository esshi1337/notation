import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page) {
  await page.addInitScript(() => {
    const tabs = [
      { id: 'one', name: 'one.md', path: '/one/notes/one.md' },
      { id: 'outside', name: 'outside.md', path: '/outside.md' },
      { id: 'two', name: 'two.md', path: '/two/two.md' },
      { id: 'untitled', name: 'untitled.md', path: null },
    ].map(tab => ({ ...tab, content: `# ${tab.name}\n`, savedContent: `# ${tab.name}\n`, savedName: tab.name, updatedAt: 1 }));
    const state = {
      calls: [] as { cmd: string; args: Record<string, unknown> }[],
      delay: '', pending: [] as (() => void)[], missing: false,
    };
    Object.assign(window, { gitMock: state, isTauri: true, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: (path: string) => path,
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        state.calls.push({ cmd, args });
        if (cmd === 'bootstrap_state') return {
          settings: { layout: 'source' }, draft: null, scriptDraft: null, scripts: [], recents: [],
          workspace: '/unrelated', workspaceCatalog: { activeId: null, workspaces: [] },
          session: { activeTabId: 'one', tabs, updatedAt: 1 },
        };
        const path = String(args.documentPath ?? '');
        const root = path.startsWith('/one/') ? '/one' : path.startsWith('/two/') ? '/two' : null;
        const result = cmd === 'git_repository' ? (state.missing ? null : root)
          : cmd === 'git_status' ? { available: true, root, branch: root === '/one' ? 'first' : 'second', detached: false, changes: [{ path: `${root}/changed.md`, index: ' ', worktree: 'M' }], branches: [] }
          : cmd === 'git_history' ? [{ hash: root, shortHash: root, parents: [], author: 'Test', date: '', subject: `History ${root}`, refs: [] }]
          : cmd === 'git_diff' ? { diff: `Diff ${root}`, truncated: false } : null;
        if (cmd === state.delay) await new Promise<void>(resolve => state.pending.push(resolve));
        if (cmd.startsWith('git_')) return result;
        if (cmd === 'read_document_snapshot') return { path: args.path, content: tabs.find(tab => tab.path === args.path)?.content ?? '' };
        if (cmd === 'launch_ready') return [];
        if (cmd === 'plugin:event|listen') return 1;
        return null;
      },
    }, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Git panel', exact: true })).toBeVisible();
}
const icon = (page: Page) => page.getByRole('button', { name: 'Git panel', exact: true });
const panel = (page: Page) => page.getByRole('region', { name: 'Git', exact: true });
const tab = (page: Page, name: string) => page.getByRole('tablist', { name: 'Documents', exact: true }).getByRole('tab', { name, exact: true });
async function delay(page: Page, cmd: string) {
  await page.evaluate(cmd => { (window as any).gitMock.delay = cmd; }, cmd);
}
async function release(page: Page) {
  await page.evaluate(() => { const state = (window as any).gitMock; state.delay = ''; state.pending.splice(0).forEach((resolve: () => void) => resolve()); });
}
async function pending(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).gitMock.pending.length)).toBeGreaterThan(0);
}

test('Git follows the saved file, not workspace, and hides for outside/untitled/missing files', async ({ page }) => {
  await setup(page);
  await expect(icon(page).locator('svg')).toHaveAttribute('data-icon', 'git');
  await icon(page).click();
  await expect(panel(page).getByLabel('Git repository', { exact: true })).toHaveText('/one');
  await expect(panel(page)).toContainText('History /one');
  await page.getByRole('textbox', { name: 'Document source' }).fill('Unsaved edits stay in the first tab');
  await tab(page, 'outside.md').click();
  await expect(icon(page)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  await page.keyboard.press('Control+Shift+g');
  await expect(panel(page)).toHaveCount(0);
  await tab(page, 'untitled.md').click();
  await expect(icon(page)).toHaveCount(0);
  await tab(page, 'two.md').click();
  await icon(page).click();
  await expect(panel(page).getByLabel('Git repository', { exact: true })).toHaveText('/two');
  await expect(panel(page)).toContainText('History /two');
  await page.evaluate(() => { (window as any).gitMock.missing = true; window.dispatchEvent(new Event('focus')); });
  await expect(icon(page)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  for (const name of ['one.md', 'outside.md', 'two.md', 'untitled.md']) await expect(tab(page, name)).toBeVisible();
  await tab(page, 'one.md').click();
  await expect(page.getByRole('textbox', { name: 'Document source' })).toHaveText('Unsaved edits stay in the first tab');
  const calls = await page.evaluate(() => (window as any).gitMock.calls as { cmd: string; args: Record<string, unknown> }[]);
  expect(calls.filter(call => ['git_status', 'git_history', 'git_diff'].includes(call.cmd)).every(call => typeof call.args.documentPath === 'string')).toBe(true);
});

test('returning focus keeps an open Git panel while the same repository is rechecked', async ({ page }) => {
  await setup(page);
  await icon(page).click();
  await expect(panel(page)).toContainText('History /one');
  await delay(page, 'git_repository');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await pending(page);
  await expect(icon(page)).toBeVisible();
  await expect(panel(page)).toContainText('History /one');
  await release(page);
  await expect(panel(page)).toContainText('History /one');
  await page.evaluate(() => { (window as any).gitMock.missing = true; window.dispatchEvent(new Event('focus')); });
  await expect(icon(page)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
});

test('late repository detection cannot restore a previous tab context', async ({ page }) => {
  await setup(page);
  await tab(page, 'outside.md').click();
  await delay(page, 'git_repository');
  await tab(page, 'one.md').click();
  await pending(page);
  await tab(page, 'untitled.md').click();
  await release(page);
  await expect(icon(page)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  await tab(page, 'two.md').click();
  await icon(page).click();
  await expect(panel(page)).toContainText('History /two');
  await expect(panel(page)).not.toContainText('/one');
});

for (const cmd of ['git_status', 'git_history', 'git_diff']) {
  test(`late ${cmd} cannot leak results after switching repositories`, async ({ page }) => {
    await setup(page);
    if (cmd !== 'git_diff') await delay(page, cmd);
    await icon(page).click();
    if (cmd === 'git_diff') {
      await expect(panel(page)).toContainText('History /one');
      await delay(page, cmd);
      await panel(page).getByRole('button', { name: 'View diff: /one/changed.md', exact: true }).click();
    }
    await pending(page);
    await tab(page, 'two.md').click();
    await expect(panel(page)).toHaveCount(0);
    await release(page);
    await icon(page).click();
    await expect(panel(page)).toContainText('History /two');
    await expect(panel(page)).not.toContainText('/one');
    await panel(page).getByRole('button', { name: 'View diff: /two/changed.md', exact: true }).click();
    await expect(panel(page).getByLabel('Git diff', { exact: true })).toHaveText('Diff /two');
  });
}
