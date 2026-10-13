import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { renameDocument, runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const preview = (page: Page) => page.getByRole('region', { name: 'Document preview' });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('renders the starter Markdown and Mermaid diagram', async ({ page }) => {
  await expect(preview(page).getByRole('heading', { name: 'Welcome to Notation' })).toBeVisible();
  await expect(preview(page).locator('svg')).toHaveCount(1);
});

test('updates Markdown while typing and preserves literal code', async ({ page }) => {
  await source(page).fill('# Working draft\n\nSome **important** text.\n\n```css\n.card { color: red; }\n```');
  await expect(preview(page).getByRole('heading', { name: 'Working draft' })).toBeVisible();
  await expect(preview(page).locator('strong')).toHaveText('important');
  await expect(preview(page).locator('pre code')).toContainText('.card { color: red; }');
});

test('renders Mermaid fences and recovers from invalid diagrams', async ({ page }) => {
  await source(page).fill('# Diagrams\n\n```mermaid\nflowchart LR\n  A[Write] --> B[Preview]\n```');
  await expect(preview(page).locator('svg')).toHaveCount(1);
  await expect(preview(page)).toContainText('Write');
  await source(page).fill('# Still readable\n\n```mermaid\nthis is not a diagram\n```');
  await expect(preview(page).getByRole('heading', { name: 'Still readable' })).toBeVisible();
  await expect(preview(page).getByRole('alert')).toContainText('Diagram error');
  await source(page).fill('```mermaid\nflowchart TD\n  A[Recovered] --> B[Ready]\n```');
  await expect(preview(page).locator('svg')).toHaveCount(1);
  await expect(preview(page)).toContainText('Recovered');
  await expect(preview(page).getByRole('alert')).toHaveCount(0);
});

test('imports and renders a standalone Mermaid file', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.locator('input[type=file]').setInputFiles({
    name: 'architecture.mmd', mimeType: 'text/plain',
    buffer: Buffer.from('flowchart LR\n  Editor --> Preview'),
  });
  await expect(page.getByRole('tab', { name: 'architecture.mmd', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(preview(page).locator('svg')).toHaveCount(1);
  await expect(preview(page)).toContainText('Editor');
});

test('downloads the document with its edited contents', async ({ page }) => {
  await renameDocument(page, 'my-notes.md');
  await source(page).fill('# Saved notes\n\nA useful thought.');
  const pending = page.waitForEvent('download');
  await runCommand(page, 'Save');
  const download = await pending;
  expect(download.suggestedFilename()).toBe('my-notes.md');
  const path = await download.path();
  expect(path).not.toBeNull();
  expect(await readFile(path!, 'utf8')).toBe('# Saved notes\n\nA useful thought.');
});

test('restores an unsaved draft after reload', async ({ page }) => {
  await renameDocument(page, 'recovered.md');
  await source(page).fill('# Recover me\n\nUnsaved work.');
  await expect(preview(page).getByRole('heading', { name: 'Recover me' })).toBeVisible();
  await page.reload();
  await expect(source(page)).toContainText('Unsaved work.');
  await expect(page.getByRole('tab', { name: 'recovered.md', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('persists appearance and editing preferences', async ({ page }) => {
  await runCommand(page, 'Settings');
  let settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await settings.getByRole('combobox', { name: 'Theme' }).selectOption('light');
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  await settings.getByRole('spinbutton', { name: 'Font size' }).fill('');
  await settings.getByRole('spinbutton', { name: 'Font size' }).pressSequentially('18');
  await settings.getByRole('checkbox', { name: 'Word wrap' }).uncheck();
  await expect(source(page)).not.toHaveClass(/cm-lineWrapping/);
  await page.reload();
  await runCommand(page, 'Settings');
  settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: 'Theme' })).toHaveValue('light');
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  await expect(settings.getByRole('spinbutton', { name: 'Font size' })).toHaveValue('18');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(source(page)).toHaveCSS('font-size', '18px');
  await expect(settings.getByRole('checkbox', { name: 'Word wrap' })).not.toBeChecked();
  await expect(source(page)).not.toHaveClass(/cm-lineWrapping/);
});

test('switches among source, preview, and split layouts', async ({ page }) => {
  await runCommand(page, 'Source');
  await expect(source(page)).toBeVisible();
  await expect(preview(page)).not.toBeVisible();
  await runCommand(page, 'Preview');
  await expect(source(page)).not.toBeVisible();
  await expect(preview(page)).toBeVisible();
  await runCommand(page, 'Split');
  await expect(source(page)).toBeVisible();
  await expect(preview(page)).toBeVisible();
});

test('sanitizes active HTML in Markdown previews', async ({ page }) => {
  await source(page).fill('# Safe preview\n\n<img src=x onerror="window.__notationUnsafe = true">\n<script>window.__notationUnsafe = true</script>\n\n[unsafe](javascript:alert(1))');
  await expect(preview(page).getByRole('heading', { name: 'Safe preview' })).toBeVisible();
  await expect(preview(page).locator('script, [onerror], a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__notationUnsafe)).toBeUndefined();
});

test('keeps separate diagrams and surrounding Markdown', async ({ page }) => {
  await source(page).fill('# Multiple diagrams\n\n```mermaid\nflowchart LR\n A[First] --> B[Second]\n```\n\nBetween diagrams.\n\n```mermaid\nsequenceDiagram\n Alice->>Bob: Hello\n```');
  await expect(preview(page).locator('svg')).toHaveCount(2);
  await expect(preview(page)).toContainText('Between diagrams.');
  await expect(preview(page)).toContainText('Hello');
});

test('New opens an empty tab without discarding the current draft', async ({ page }) => {
  await source(page).fill('# Keep this draft');
  await runCommand(page, 'New');
  await expect(page.getByRole('tab', { name: 'untitled.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(source(page)).toHaveText('');
  await source(page).press('ControlOrMeta+z');
  await expect(source(page)).toHaveText('');
  await page.getByRole('tab', { name: 'welcome.md', exact: true }).click();
  await expect(source(page)).toHaveText('# Keep this draft');
});

test('starts safely with malformed saved preferences', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('notation.settings', 'null'));
  await page.reload();
  await expect(source(page)).toBeVisible();
  await runCommand(page, 'Settings');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: 'Theme' })).toHaveValue('dark');
});
