import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { renameDocument, runCommand, setSetting, expectSetting } from './commands';

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
  await setSetting(page, 'Theme', 'light');
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  await settings.getByRole('spinbutton', { name: 'Font size' }).fill('');
  await settings.getByRole('spinbutton', { name: 'Font size' }).pressSequentially('18');
  await settings.getByRole('checkbox', { name: 'Word wrap' }).uncheck();
  await expect(source(page)).not.toHaveClass(/cm-lineWrapping/);
  await page.reload();
  await runCommand(page, 'Settings');
  settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await expectSetting(page, 'Theme', 'light');
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
  await expectSetting(page, 'Theme', 'dark');
});

test('unchanged diagrams are reused across renders with unique ids, errors and themes are not', async ({ page }) => {
  const diagram = '```mermaid\nflowchart LR\n  A[Same] --> B[Diagram]\n```';
  await source(page).fill(`# Twice\n\n${diagram}\n\nBetween.\n\n${diagram}\n\n\`\`\`mermaid\nthis is not a diagram\n\`\`\`\n`);
  const diagrams = preview(page).locator('.diagram');
  await expect(diagrams.locator('svg')).toHaveCount(2);
  await expect(preview(page).getByRole('alert')).toContainText('Diagram error');
  const ids = () => page.evaluate(() => [...document.querySelectorAll('[id]')].map((element) => element.id));
  const unique = async () => { const all = await ids(); return all.length === new Set(all).size; };
  expect(await unique()).toBe(true);
  const firstIds = await diagrams.locator('svg').evaluateAll((list) => list.map((svg) => svg.id));
  expect(new Set(firstIds).size).toBe(2);

  // An edit outside the diagrams re-renders the preview. The diagrams come
  // back without a loading placeholder being shown, under new unique ids,
  // and the broken diagram reports its error again.
  await page.evaluate(() => {
    const seen = window as unknown as { placeholders: number };
    seen.placeholders = 0;
    new MutationObserver((records) => { for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement && node.classList.contains('diagram-loading') && /Same|Diagram/u.test(node.closest('.markdown-body')?.textContent ?? '') ) seen.placeholders++; }).observe(document.body, { childList: true, subtree: true });
  });
  await source(page).press('Control+End');
  await page.keyboard.type('\nA new last line.');
  await expect(preview(page).getByText('A new last line.')).toBeVisible();
  await expect(diagrams.locator('svg')).toHaveCount(2);
  await expect(preview(page).getByRole('alert')).toContainText('Diagram error');
  await expect(preview(page).getByText('Diagram', { exact: true })).toHaveCount(2);
  expect(await unique()).toBe(true);
  const secondIds = await diagrams.locator('svg').evaluateAll((list) => list.map((svg) => svg.id));
  expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  // Only the broken diagram went through a fresh render (one placeholder).
  expect(await page.evaluate(() => (window as unknown as { placeholders: number }).placeholders)).toBe(1);
  // Arrowheads still resolve inside each copy: marker references name ids that exist.
  expect(await diagrams.locator('svg').evaluateAll((list) => list.every((svg) => [...svg.querySelectorAll('[marker-end]')].every((path) => { const match = /url\(#([^)]+)\)/u.exec(path.getAttribute('marker-end') ?? ''); return !match || svg.querySelector('#' + CSS.escape(match[1])) !== null; })))).toBe(true);

  // The other theme renders its own diagrams rather than reusing these.
  const before = await diagrams.first().locator('svg').evaluate((svg) => svg.querySelector('style')?.textContent ?? '');
  await page.getByRole('button', { name: 'App menu' }).click();
  await page.getByRole('menu', { name: 'App menu' }).getByRole('menuitem', { name: 'Settings' }).click();
  await setSetting(page, 'Theme', 'light');
  await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close settings' }).click();
  await expect(diagrams.locator('svg')).toHaveCount(2);
  await expect.poll(async () => (await diagrams.first().locator('svg').evaluate((svg) => svg.querySelector('style')?.textContent ?? '')).replace(/notation-diagram-\d+/gu, '') !== before.replace(/notation-diagram-\d+/gu, '')).toBe(true);
});
