import { expect, test, type Page } from '@playwright/test';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const panel = (page: Page) => page.getByRole('region', { name: 'Workspace', exact: true });
async function create(page: Page, name: string) {
  if (!await panel(page).isVisible()) await runCommand(page, 'Workspace');
  await panel(page).getByRole('textbox', { name: 'Workspace name', exact: true }).fill(name);
  await panel(page).getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Active workspace' })).toHaveValue(await page.getByRole('option', { name, exact: true }).getAttribute('value') as string);
}
async function importShared(page: Page) {
  await page.locator('input[type=file]').setInputFiles({ name: 'shared.md', mimeType: 'text/markdown', buffer: Buffer.from('First line\nSecond line\nThird line') });
  await expect(source(page)).toContainText('First line');
}

test('workspaces share file edits while retaining separate tabs, cursors and layouts across restart', async ({ page }) => {
  await page.goto('/');
  await create(page, 'Research');
  await importShared(page);
  await runCommand(page, 'Source');
  await source(page).focus();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowRight');
  await create(page, 'Writing');
  await expect(source(page)).toHaveText('');
  await importShared(page);
  await source(page).focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' shared edit');
  await runCommand(page, 'Live Preview');
  const switcher = page.getByRole('combobox', { name: 'Active workspace' });
  await switcher.selectOption({ label: 'Research' });
  await expect(source(page)).toContainText('shared edit');
  await expect(page.getByRole('button', { name: 'Layout', exact: true })).toContainText('Source');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('notation.session')!).tabs.find((t: {name:string}) => t.name === 'shared.md').selection.head)).toBe(1);
  await switcher.selectOption({ label: 'Writing' });
  await expect(page.getByRole('button', { name: 'Layout', exact: true })).toContainText('Live');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('notation.session')!).tabs.find((t: {name:string}) => t.name === 'shared.md').selection.head)).toBe('First line\nSecond line\nThird line shared edit'.length);
  await page.reload();
  await expect(switcher.locator('option:checked')).toHaveText('Writing');
  await expect(source(page)).toContainText('shared edit');
  await switcher.selectOption({ label: 'Research' });
  await expect(source(page)).toContainText('shared edit');
  await expect(page.getByRole('button', { name: 'Layout', exact: true })).toContainText('Source');
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem('notation.session')!));
  expect(session.tabs.filter((tab: { name: string }) => tab.name === 'shared.md')).toHaveLength(1);
  await page.screenshot({ path: 'test-results/workspaces-shared-file.png' });
});

test('closing a shared dirty tab only closes that view and deleting a workspace retains its drafts', async ({ page }) => {
  await page.goto('/');
  await create(page, 'First');
  await importShared(page);
  await create(page, 'Second');
  await importShared(page);
  await source(page).focus(); await page.keyboard.press('Control+End'); await page.keyboard.type(' unsaved');
  let dialogs = 0;
  page.on('dialog', async dialog => { dialogs++; await dialog.accept(); });
  await runCommand(page, 'Close tab');
  expect(dialogs).toBe(0);
  await page.getByRole('combobox', { name: 'Active workspace' }).selectOption({ label: 'First' });
  await expect(source(page)).toContainText('unsaved');
  await runCommand(page, 'Workspace');
  // The panel may already be open; keep it visible before the deletion.
  if (!await panel(page).isVisible()) await runCommand(page, 'Workspace');
  await panel(page).getByRole('button', { name: 'Delete workspace', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Active workspace' }).locator('option:checked')).toHaveText('Second');
  await page.getByRole('tab', { name: /shared.md/ }).click();
  await expect(source(page)).toContainText('unsaved');
  expect(dialogs).toBe(1);
});

test('first workspace keeps existing drafts and rename/delete change metadata only', async ({ page }) => {
  await page.goto('/');
  await source(page).fill('An existing unsaved draft');
  await create(page, 'Initial workspace');
  await expect(source(page)).toHaveText('An existing unsaved draft');
  await panel(page).getByRole('textbox', { name: 'Workspace name', exact: true }).fill('Renamed workspace');
  await panel(page).getByRole('button', { name: 'Rename workspace', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Active workspace' }).locator('option:checked')).toHaveText('Renamed workspace');
  page.on('dialog', dialog => dialog.accept());
  await panel(page).getByRole('button', { name: 'Delete workspace', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Active workspace' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'welcome.md', exact: true }).click();
  await expect(source(page)).toHaveText('An existing unsaved draft');
  await page.reload();
  await expect(source(page)).toHaveText('An existing unsaved draft');
});
