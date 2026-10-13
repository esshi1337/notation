import { expect, test, type Page } from '@playwright/test';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const preview = (page: Page) => page.getByRole('region', { name: 'Document preview' });

async function saveText(page: Page) {
  const pending = page.waitForEvent('download');
  await runCommand(page, 'Save');
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error('Markdown export did not provide a file.');
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('fold and unfold heading blocks without changing Markdown or hiding reading preview', async ({ page }) => {
  const text = '# Project notes\n\nA paragraph under the heading.\n\n- first item\n- second item\n\n## Details\n\nMore content.\n\n```js\nconst ready = true;\n```\n\n> [!NOTE] Quoted block\n> Quote body.\n';
  await source(page).fill(text);
  await source(page).locator('.cm-line').filter({ hasText: 'Project notes' }).click();
  await runCommand(page, 'Fold block');
  await expect(source(page).locator('.cm-foldPlaceholder')).toHaveCount(1);
  await expect(preview(page).getByRole('heading', { name: 'Project notes', exact: true })).toBeVisible();
  await expect(preview(page)).toContainText('More content.');
  expect(await saveText(page)).toBe(text);

  await runCommand(page, 'Unfold all');
  await runCommand(page, 'Fold all');
  expect(await source(page).locator('.cm-foldPlaceholder').count()).toBeGreaterThan(0);
  await runCommand(page, 'Live Preview');
  await expect(source(page).locator('.cm-foldPlaceholder').first()).toBeVisible();
  await runCommand(page, 'Source');
  await expect(source(page).locator('.cm-foldPlaceholder').first()).toBeVisible();
  expect(await saveText(page)).toBe(text);
  await runCommand(page, 'Unfold all');
  await expect(source(page).locator('.cm-foldPlaceholder')).toHaveCount(0);
  expect(await saveText(page)).toBe(text);
});

test('Fold block works on code, quotes, and nested lists across Source and Live Preview', async ({ page }) => {
  const fixtures = [
    ['```js\nconst first = 1;\nconst second = 2;\n```', 'const first'],
    ['> Quote first line.\n> Quote second line.', 'Quote first line'],
    ['- Parent\n  - Nested first\n  - Nested second\n- Sibling', 'Nested first'],
  ] as const;

  for (const [text, selected] of fixtures) {
    await source(page).fill(text);
    await source(page).locator('.cm-line').filter({ hasText: selected }).click();
    await runCommand(page, 'Fold block');
    await expect(source(page).locator('.cm-foldPlaceholder')).toHaveCount(1);
    await runCommand(page, 'Live Preview');
    await expect(source(page).locator('.cm-foldPlaceholder')).toHaveCount(1);
    await runCommand(page, 'Source');
    expect(await saveText(page)).toBe(text);
    await runCommand(page, 'Unfold all');
    await expect(source(page).locator('.cm-foldPlaceholder')).toHaveCount(0);
  }
});
