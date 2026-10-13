import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source', exact: true });
const templates = (page: Page) => page.getByRole('region', { name: 'Templates', exact: true });

async function exportMarkdown(page: Page) {
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

test('template variables preview safely and insert as one undoable edit', async ({ page }) => {
  const original = '---\nproject:\n  name: Atlas\nstatus: active\n---\n\n';
  await source(page).fill(original);
  await runCommand(page, 'Templates');
  const panel = templates(page);
  await panel.getByRole('textbox', { name: 'Template content', exact: true }).fill('# {{project.name}}\n\nStatus: {{status}}\nFile: {{document.name}}');
  await panel.getByRole('button', { name: 'Preview template', exact: true }).click();
  const prepared = panel.getByLabel('Template preview');
  await expect(prepared).toContainText('# Atlas');
  await expect(prepared).toContainText('Status: active');
  await expect(prepared).toContainText('File: welcome.md');
  await panel.getByRole('button', { name: 'Insert template', exact: true }).click();
  const inserted = await exportMarkdown(page);
  expect(inserted).toBe(original + '# Atlas\n\nStatus: active\nFile: welcome.md');

  await source(page).focus();
  await source(page).press('ControlOrMeta+z');
  expect(await exportMarkdown(page)).toBe(original);
});

test('missing template variables stay visible and block insertion', async ({ page }) => {
  await source(page).fill('');
  await runCommand(page, 'Templates');
  const panel = templates(page);
  await panel.getByRole('textbox', { name: 'Template content', exact: true }).fill('Owner: {{owner.name}}');
  await panel.getByRole('button', { name: 'Preview template', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Missing properties: owner.name');
  await expect(panel.getByLabel('Template preview')).toHaveText('Owner: {{owner.name}}');
  await expect(panel.getByRole('button', { name: 'Insert template', exact: true })).toBeDisabled();
  expect(await exportMarkdown(page)).toBe('');
});

test('inline frontmatter variables render in Preview and Live without replacing source', async ({ page }) => {
  const original = '---\nproject:\n  name: Atlas\n---\n\n# {{project.name}}\n\nOwner: {{owner}}';
  await source(page).fill(original);
  await runCommand(page, 'Preview');
  const preview = page.getByRole('region', { name: 'Document preview', exact: true });
  await expect(preview.getByRole('heading', { name: 'Atlas', exact: true })).toBeVisible();
  await expect(preview).toContainText('Owner: {{owner}}');
  await runCommand(page, 'Live Preview');
  await expect(source(page).locator('.document-variable').first()).toHaveText('Atlas');
  await expect(source(page).locator('.unresolved-variable')).toHaveText('{{owner}}');
  expect(await exportMarkdown(page)).toBe(original);
});

test('template insertion refuses a stale preview after the source changes', async ({ page }) => {
  const original = '# Original';
  await source(page).fill(original);
  await runCommand(page, 'Templates');
  const panel = templates(page);
  await panel.getByRole('textbox', { name: 'Template content', exact: true }).fill('Inserted text');
  await panel.getByRole('button', { name: 'Preview template', exact: true }).click();
  await source(page).fill('# Changed after preview');
  await panel.getByRole('button', { name: 'Insert template', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('document changed after preview');
  expect(await exportMarkdown(page)).toBe('# Changed after preview');
});

test('saved template library can be selected and deleted without changing the document', async ({ page }) => {
  const original = '# Current note';
  await source(page).fill(original);
  await runCommand(page, 'Templates');
  const panel = templates(page);
  await panel.getByRole('textbox', { name: 'Template name', exact: true }).fill('Meeting notes');
  await panel.getByRole('textbox', { name: 'Template content', exact: true }).fill('## Attendees\n\n## Decisions');
  await panel.getByRole('button', { name: 'Save template', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Template saved');
  await page.reload();
  await expect(source(page)).toBeVisible();
  await runCommand(page, 'Templates');
  const reopenedPanel = templates(page);
  const picker = reopenedPanel.getByRole('combobox', { name: 'Saved templates', exact: true });
  await expect(picker.locator('option', { hasText: 'Meeting notes' })).toHaveCount(1);
  await picker.selectOption({ label: 'Meeting notes' });
  await expect(reopenedPanel.getByRole('textbox', { name: 'Template content', exact: true })).toHaveValue('## Attendees\n\n## Decisions');
  await reopenedPanel.getByRole('button', { name: 'Delete template', exact: true }).click();
  await expect(reopenedPanel.getByRole('status')).toContainText('Template deleted');
  await expect(picker.locator('option', { hasText: 'Meeting notes' })).toHaveCount(0);
  expect(await exportMarkdown(page)).toBe(original);
});

test('unsaved template forms survive switching between a saved template and New template', async ({ page }) => {
  await runCommand(page, 'Templates');
  const panel = templates(page);
  await panel.getByRole('textbox', { name: 'Template name', exact: true }).fill('Meeting notes');
  await panel.getByRole('textbox', { name: 'Template content', exact: true }).fill('Saved body');
  await panel.getByRole('button', { name: 'Save template', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Template saved');

  await panel.getByRole('textbox', { name: 'Template name', exact: true }).fill('Meeting notes draft');
  await panel.getByRole('textbox', { name: 'Template content', exact: true }).fill('Unsaved meeting changes');
  await panel.getByRole('button', { name: 'New template', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Template name', exact: true }).fill('Scratch template');
  await panel.getByRole('textbox', { name: 'Template content', exact: true }).fill('Unsaved scratch changes');

  const picker = panel.getByRole('combobox', { name: 'Saved templates', exact: true });
  await picker.selectOption({ label: 'Meeting notes' });
  await expect(panel.getByRole('textbox', { name: 'Template name', exact: true })).toHaveValue('Meeting notes draft');
  await expect(panel.getByRole('textbox', { name: 'Template content', exact: true })).toHaveValue('Unsaved meeting changes');
  await panel.getByRole('button', { name: 'New template', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'Template name', exact: true })).toHaveValue('Scratch template');
  await expect(panel.getByRole('textbox', { name: 'Template content', exact: true })).toHaveValue('Unsaved scratch changes');
});
