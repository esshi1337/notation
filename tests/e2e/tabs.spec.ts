import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { renameDocument, runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const documents = (page: Page) => page.getByRole('tablist', { name: 'Documents', exact: true });
const tab = (page: Page, name: string) => documents(page).getByRole('tab', { name, exact: true });
const closeTab = (tab: Locator, name: string) => tab.locator('xpath=..').getByRole('button', { name: `Close tab: ${name}`, exact: true });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
  await expect(documents(page)).toBeVisible();
});

test('keeps tab contents, dirty state, and undo history independent', async ({ page }) => {
  await renameDocument(page, 'alpha.md');
  await source(page).fill('alpha base');
  await source(page).press('End');
  await source(page).press('Enter');
  await source(page).pressSequentially('Alpha second edit');
  await expect(tab(page, 'alpha.md')).toHaveAttribute('aria-selected', 'true');
  await expect(documents(page).getByLabel('Unsaved changes: alpha.md')).toBeVisible();

  await runCommand(page, 'New');
  await renameDocument(page, 'beta.md');
  await source(page).fill('beta base');
  await source(page).press('End');
  await source(page).press('Enter');
  await source(page).pressSequentially('Beta second edit');
  await expect(tab(page, 'beta.md')).toHaveAttribute('aria-selected', 'true');

  await tab(page, 'alpha.md').click();
  await expect(source(page)).toHaveText('alpha base\nAlpha second edit', { useInnerText: true });
  await source(page).press('ControlOrMeta+z');
  await expect(source(page)).toHaveText('alpha base');

  await tab(page, 'beta.md').click();
  await expect(source(page)).toHaveText('beta base\nBeta second edit', { useInnerText: true });
  await source(page).press('ControlOrMeta+z');
  await expect(source(page)).toHaveText('beta base');
  await tab(page, 'alpha.md').click();
  await expect(source(page)).toHaveText('alpha base');
  await expect(documents(page).getByLabel('Unsaved changes: alpha.md')).toBeVisible();
});

test('cancelling a dirty-tab close preserves it; confirming closes only that tab', async ({ page }) => {
  await runCommand(page, 'New');
  await renameDocument(page, 'draft.md');
  await source(page).fill('# Keep until confirmed');
  await expect(tab(page, 'draft.md')).toHaveAttribute('aria-selected', 'true');

  let cancelled = false;
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    cancelled = true;
    await dialog.dismiss();
  });
  await closeTab(tab(page, 'draft.md'), 'draft.md').click();
  expect(cancelled).toBe(true);
  await expect(tab(page, 'draft.md')).toBeVisible();
  await expect(source(page)).toHaveText('# Keep until confirmed');

  let accepted = false;
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    accepted = true;
    await dialog.accept();
  });
  await closeTab(tab(page, 'draft.md'), 'draft.md').click();
  expect(accepted).toBe(true);
  await expect(tab(page, 'draft.md')).toHaveCount(0);
  await expect(tab(page, 'welcome.md')).toHaveAttribute('aria-selected', 'true');
  await expect(source(page)).toContainText('Welcome to Notation');
});

test('Save targets the active tab and leaves the other tab dirty', async ({ page }) => {
  await renameDocument(page, 'alpha.md');
  await source(page).fill('# Alpha stays unsaved');
  await runCommand(page, 'New');
  await renameDocument(page, 'beta.md');
  await source(page).fill('# Beta is saved first');

  let pendingDownload = page.waitForEvent('download');
  await runCommand(page, 'Save');
  let download = await pendingDownload;
  expect(download.suggestedFilename()).toBe('beta.md');
  expect(await readFile((await download.path())!, 'utf8')).toBe('# Beta is saved first');
  await expect(tab(page, 'beta.md')).not.toContainText('•');
  await expect(documents(page).getByLabel('Unsaved changes: alpha.md')).toBeVisible();

  await tab(page, 'alpha.md').click();
  pendingDownload = page.waitForEvent('download');
  await runCommand(page, 'Save');
  download = await pendingDownload;
  expect(download.suggestedFilename()).toBe('alpha.md');
  expect(await readFile((await download.path())!, 'utf8')).toBe('# Alpha stays unsaved');
  await expect(documents(page).getByLabel('Unsaved changes: alpha.md')).toHaveCount(0);
});

test('persists the active tab and an inactive document larger than 64 KiB', async ({ page }) => {
  await runCommand(page, 'New');
  await renameDocument(page, 'large.md');
  const large = '# Large tab\n' + '0123456789abcdef'.repeat(5000);
  await source(page).fill(large);
  const storedLarge = () => page.evaluate((name) => {
    const session = JSON.parse(localStorage.getItem('notation.session') || 'null');
    return session?.tabs?.find((item: { name: string }) => item.name === name)?.content ?? null;
  }, 'large.md');
  await expect.poll(storedLarge).toBe(large);

  await runCommand(page, 'New');
  await renameDocument(page, 'active.md');
  await source(page).fill('# Active tab remains selected');
  await expect(tab(page, 'active.md')).toHaveAttribute('aria-selected', 'true');

  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.reload();
  await expect(documents(page).getByRole('tab')).toHaveCount(3);
  await expect(tab(page, 'active.md')).toHaveAttribute('aria-selected', 'true');
  await expect(source(page)).toHaveText('# Active tab remains selected');

  await tab(page, 'large.md').click();
  await expect.poll(storedLarge).toBe(large);
  const restoredLength = await source(page).evaluate((element) => element.textContent?.length ?? 0);
  expect(restoredLength).toBeGreaterThan(0);
  const pending = page.waitForEvent('download');
  await runCommand(page, 'Save');
  const download = await pending;
  expect(download.suggestedFilename()).toBe('large.md');
  expect(await readFile((await download.path())!, 'utf8')).toBe(large);
});
