import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { blurEditor, renameDocument, runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const diagrams = (page: Page) => page.locator('.cm-live-mermaid');

async function saveText(page: Page) {
  const downloading = page.waitForEvent('download');
  await runCommand(page, 'Save');
  const download = await downloading;
  return readFile((await download.path())!, 'utf8');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('formats Markdown inline and reveals the active line for editing', async ({ page }) => {
  await source(page).fill('# Rich title\n\nSome **bold** and *italic* with `code`.\n\n[Example](https://example.test)\n\nEnd.');
  await runCommand(page, 'Live Preview');
  await expect(page.locator('.cm-live-preview')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Document preview' })).not.toBeVisible();
  await expect(source(page)).toContainText('Rich title');
  await expect(source(page)).not.toContainText('# Rich title');
  await expect(source(page)).not.toContainText('**bold**');
  await expect(source(page)).not.toContainText('*italic*');
  await expect(source(page)).not.toContainText('`code`');
  await expect(source(page)).not.toContainText('https://example.test');
  await page.locator('.cm-live-heading').filter({ hasText: 'Rich title' }).click();
  await expect(source(page)).toContainText('# Rich title');
  await source(page).press('ControlOrMeta+End');
  await expect(source(page)).not.toContainText('# Rich title');
});

test('renders Mermaid inside the editor and supports click-to-edit', async ({ page }) => {
  await source(page).fill('# Diagram\n\n```mermaid\nflowchart LR\n  A[Before] --> B[Preview]\n```\n\nAfter block.');
  await runCommand(page, 'Live Preview');
  await expect(diagrams(page).locator('svg')).toHaveCount(1);
  await expect(diagrams(page)).toContainText('Before');
  await page.getByRole('button', { name: 'Edit Mermaid diagram' }).click();
  await expect(diagrams(page)).toHaveCount(0);
  await expect(source(page)).toContainText('```mermaid');
  await source(page).locator('.cm-line').filter({ hasText: 'A[Before]' }).click();
  await source(page).press('Home');
  await source(page).press('Shift+End');
  await page.keyboard.insertText('  A[After] --> B[Preview]');
  await source(page).press('ControlOrMeta+End');
  await expect(diagrams(page).locator('svg')).toHaveCount(1);
  await expect(diagrams(page)).toContainText('After');
  await expect(diagrams(page)).not.toContainText('Before');
  await expect(page.locator('.cm-lineNumbers')).toHaveCount(0);
  await runCommand(page, 'Source');
  await expect(page.locator('.cm-lineNumbers')).toBeVisible();
  await expect(page.locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: /^8$/ })).toBeVisible();
});

test('preserves exact Markdown through mode changes and saving', async ({ page }) => {
  const text = '# Exact **source**\n\n> A quote with `code`\n\n- first\n- second\n\n```mermaid\nflowchart TD\n A --> B\n```\n\n[Link](https://example.test "title")\n';
  await source(page).fill(text);
  await runCommand(page, 'Live Preview');
  await expect(diagrams(page).locator('svg')).toHaveCount(1);
  await runCommand(page, 'Preview');
  await runCommand(page, 'Source');
  await runCommand(page, 'Live Preview');
  expect(await saveText(page)).toBe(text);
});

test('keeps undo history across Live Preview and Source modes', async ({ page }) => {
  const original = await saveText(page);
  await source(page).press('ControlOrMeta+End');
  await page.keyboard.insertText('\n\nA later sentence.');
  await runCommand(page, 'Live Preview');
  await runCommand(page, 'Source');
  await source(page).press('ControlOrMeta+z');
  expect(await saveText(page)).toBe(original);
});

test('shows editable errors for invalid inline diagrams and recovers', async ({ page }) => {
  await source(page).fill('# Still readable\n\n```mermaid\nnot a valid diagram\n```\n\nEnd.');
  await runCommand(page, 'Live Preview');
  await expect(diagrams(page).getByRole('alert')).toContainText('Diagram error');
  await expect(source(page)).toContainText('Still readable');
  await page.getByRole('button', { name: 'Edit Mermaid diagram' }).click();
  await expect(source(page)).toContainText('not a valid diagram');
  await runCommand(page, 'Source');
  await source(page).fill('```mermaid\nflowchart LR\n A[Recovered] --> B[Ready]\n```\n\nEnd.');
  await runCommand(page, 'Live Preview');
  await expect(diagrams(page).locator('svg')).toHaveCount(1);
  await expect(diagrams(page)).toContainText('Recovered');
  await expect(diagrams(page).getByRole('alert')).toHaveCount(0);
});

test('previews standalone Mermaid on blur and reveals its source on click', async ({ page }) => {
  await renameDocument(page, 'diagram.mmd');
  await source(page).fill('flowchart LR\n  A[Standalone] --> B[Diagram]\n');
  await runCommand(page, 'Live Preview');
  await expect(diagrams(page).locator('svg')).toHaveCount(1);
  await expect(diagrams(page)).toContainText('Standalone');
  await page.getByRole('button', { name: 'Edit Mermaid diagram' }).click();
  await expect(diagrams(page)).toHaveCount(0);
  await expect(source(page)).toContainText('flowchart LR');
  await blurEditor(page);
  await expect(diagrams(page).locator('svg')).toHaveCount(1);
});

test('preserves literal Markdown inside ordinary code fences', async ({ page }) => {
  const text = '# Real heading\n\n```text\n# Not a heading\n**literal emphasis**\n[not a link](example)\n```\n\nEnd.';
  await source(page).fill(text);
  await runCommand(page, 'Live Preview');
  await expect(source(page)).toContainText('# Not a heading');
  await expect(source(page)).toContainText('**literal emphasis**');
  await expect(source(page)).toContainText('[not a link](example)');
  await expect(page.locator('.cm-live-heading').filter({ hasText: 'Not a heading' })).toHaveCount(0);
  expect(await saveText(page)).toBe(text);
});

test('restores Live Preview mode and the draft after reload', async ({ page }) => {
  await source(page).fill('# Restored live draft\n\n```mermaid\nflowchart LR\n A --> B\n```\n');
  await runCommand(page, 'Live Preview');
  await expect(diagrams(page).locator('svg')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.cm-live-preview')).toBeVisible();
  await expect(diagrams(page).locator('svg')).toHaveCount(1);
  await expect(source(page)).toContainText('Restored live draft');
});

test('renders multiple inline diagrams and updates their theme', async ({ page }) => {
  await source(page).fill('# Two diagrams\n\n```mermaid\nflowchart LR\n A[First] --> B[Second]\n```\n\n```mermaid\nsequenceDiagram\n Alice->>Bob: Hello\n```\n\nEnd.');
  await runCommand(page, 'Live Preview');
  await expect(diagrams(page).locator('svg')).toHaveCount(2);
  await expect(diagrams(page).nth(0)).toContainText('First');
  await expect(diagrams(page).nth(1)).toContainText('Hello');
  const oldStyle = await diagrams(page).first().locator('svg style').textContent();
  await runCommand(page, 'Settings');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await settings.getByRole('combobox', { name: 'Theme' }).selectOption('light');
  await page.keyboard.press('Escape');
  await expect(diagrams(page).locator('svg')).toHaveCount(2);
  await expect.poll(() => diagrams(page).first().locator('svg style').textContent()).not.toBe(oldStyle);
  await expect(diagrams(page).nth(0)).toContainText('First');
});

test('can enter a diagram with the keyboard and reveal a full selection', async ({ page }) => {
  await source(page).fill('# Keyboard\n\n```mermaid\nflowchart LR\n A --> B\n```\n\nEnd.');
  await runCommand(page, 'Live Preview');
  const diagram = page.getByRole('button', { name: 'Edit Mermaid diagram' });
  await expect(diagram.locator('svg')).toHaveCount(1);
  await diagram.focus();
  await diagram.press('Enter');
  await expect(source(page)).toBeFocused();
  await expect(source(page)).toContainText('flowchart LR');
  await source(page).press('ControlOrMeta+a');
  await expect(source(page)).toContainText('# Keyboard');
  await expect(source(page)).toContainText('```mermaid');
});

test('renders a diagram after leaving its source across mode changes', async ({ page }) => {
  const text = '# Focus lifecycle\n\n```mermaid\nflowchart LR\n A[Focus] --> B[Restored]\n```\n\nEnd.';
  await source(page).fill(text);
  await runCommand(page, 'Live Preview');
  await expect(diagrams(page).locator('svg')).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit Mermaid diagram' }).click();
  await expect(diagrams(page)).toHaveCount(0);
  await expect(source(page)).toBeFocused();
  await runCommand(page, 'Source');
  await runCommand(page, 'Live Preview');
  await blurEditor(page);
  await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeFocused();
  await expect(diagrams(page).locator('svg')).toHaveCount(1);
  await expect(diagrams(page)).toContainText('Restored');
  expect(await saveText(page)).toBe(text);
});
