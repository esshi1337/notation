import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source', exact: true });

async function exportedText(page: Page) {
  const pending = page.waitForEvent('download');
  await runCommand(page, 'Save');
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error('Markdown export did not provide a file.');
  return readFile(path, 'utf8');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('Live Preview task checkboxes map to Markdown and undo restores the marker', async ({ page }) => {
  const document = '# Tasks\n\n- [ ] Keep source mapping\n';
  await source(page).fill(document);
  await runCommand(page, 'Live Preview');
  const task = source(page).getByRole('checkbox', { name: 'Task: Keep source mapping', exact: true });
  await expect(task).toBeVisible();
  await task.check();
  expect(await exportedText(page)).toBe('# Tasks\n\n- [x] Keep source mapping\n');
  await source(page).focus();
  await source(page).press('ControlOrMeta+z');
  expect(await exportedText(page)).toBe(document);
});

test('Live Preview tables stay read-only until the reader chooses to reveal source', async ({ page }) => {
  const document = '# Table\n\n| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n| Beta | 2 |\n';
  await source(page).fill(document);
  await runCommand(page, 'Live Preview');
  const table = source(page).locator('.cm-live-table');
  await expect(table).toBeVisible();
  await expect(table.locator('table tbody tr')).toHaveCount(2);
  await expect(table.locator('button,input,textarea,select')).toHaveCount(0);
  await table.dblclick();
  await expect(source(page).locator('.cm-line').filter({ hasText: '| Alpha | 1 |' })).toBeVisible();
  expect(await exportedText(page)).toBe(document);
});
