import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const preview = (page: Page) => page.getByRole('region', { name: 'Document preview' });

async function importMarkdown(page: Page, name: string, text: string) {
  await page.locator('input[type=file]').setInputFiles({
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from(text, 'utf8'),
  });
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
}

async function exportedText(page: Page) {
  const pending = page.waitForEvent('download');
  await runCommand(page, 'Save');
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error('Browser did not provide the exported Markdown file.');
  return readFile(path, 'utf8');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('YAML properties hide from preview, preserve comments and unknown fields, and undo as one edit', async ({ page }) => {
  const original = '---\ntitle: "Original" # keep this comment\npublished: false\ntags:\n  - work\ncustom_field: preserve me # keep unknown fields\n---\n# Body heading\n\nBody text stays here.\n';
  await importMarkdown(page, 'properties.md', original);
  await expect(preview(page).getByRole('heading', { name: 'Body heading', exact: true })).toBeVisible();
  await expect(preview(page).getByRole('heading', { name: 'Original', exact: true })).toHaveCount(0);

  await runCommand(page, 'Properties');
  const panel = page.getByRole('region', { name: 'Properties', exact: true });
  const title = panel.getByRole('textbox', { name: 'Property value: title', exact: true });
  await expect(panel.getByRole('combobox', { name: 'Property type: published', exact: true })).toHaveValue('boolean');
  await expect(panel.getByRole('combobox', { name: 'Property type: tags', exact: true })).toHaveValue('list');
  await title.fill('Updated title');
  await panel.getByRole('button', { name: 'Apply property: title', exact: true }).click();

  const updated = await exportedText(page);
  expect(updated).toMatch(/title: ["']?Updated title["']? # keep this comment/u);
  expect(updated).toContain('custom_field: preserve me # keep unknown fields');
  expect(updated.slice(updated.indexOf('---\n# Body heading') + 4)).toBe('# Body heading\n\nBody text stays here.\n');

  await source(page).focus();
  await source(page).press('ControlOrMeta+z');
  expect(await exportedText(page)).toBe(original);
});

test('CRLF properties edits preserve body bytes and a Preview task toggle changes only its marker', async ({ page }) => {
  const original = '---\r\ntitle: "CRLF note"\r\n---\r\n# Body\r\n\r\n- [ ] Keep the task offset\r\n\r\nTrailing paragraph.\r\n';
  await importMarkdown(page, 'crlf-properties.md', original);
  await expect(preview(page).getByRole('heading', { name: 'Body', exact: true })).toBeVisible();
  await runCommand(page, 'Properties');
  const panel = page.getByRole('region', { name: 'Properties', exact: true });
  await panel.getByRole('textbox', { name: 'Property value: title', exact: true }).fill('Edited CRLF note');
  await panel.getByRole('button', { name: 'Apply property: title', exact: true }).click();
  const afterPropertyEdit = await exportedText(page);
  expect(afterPropertyEdit).toContain('# Body\r\n\r\n- [ ] Keep the task offset\r\n\r\nTrailing paragraph.\r\n');

  await runCommand(page, 'Properties');
  await preview(page).getByRole('checkbox', { name: 'Task: Keep the task offset' }).check();
  expect(await exportedText(page)).toBe(afterPropertyEdit.replace('- [ ] Keep the task offset', '- [x] Keep the task offset'));
  await source(page).focus();
  await source(page).press('ControlOrMeta+z');
  expect(await exportedText(page)).toBe(afterPropertyEdit);
  await source(page).focus();
  await source(page).press('ControlOrMeta+z');
  expect(await exportedText(page)).toBe(original);
});

test('invalid frontmatter reports a local repair action without hiding Markdown source', async ({ page }) => {
  const invalid = '---\ntitle: [unterminated\n---\n# Still visible\n';
  await importMarkdown(page, 'invalid-properties.md', invalid);
  await expect(preview(page).getByRole('heading', { name: 'Still visible', exact: true })).toBeVisible();
  await runCommand(page, 'Properties');
  const panel = page.getByRole('region', { name: 'Properties', exact: true });
  await expect(panel.getByRole('alert')).toBeVisible();
  await panel.getByRole('button', { name: 'Edit properties source', exact: true }).click();
  await expect(source(page)).toContainText('title: [unterminated');
  expect(await exportedText(page)).toBe(invalid);
});
