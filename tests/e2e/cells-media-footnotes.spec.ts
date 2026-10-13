import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const preview = (page: Page) => page.getByRole('region', { name: 'Document preview' });

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

test('JavaScript cells run only by request, enforce ordering, and mark stale output', async ({ page }) => {
  const document = [
    '# Cells',
    '',
    '```javascript cell:first',
    'return {n: 2};',
    '```',
    '',
    '```javascript cell:second',
    'return inputs.first.n * 3;',
    '```',
  ].join('\n');
  await source(page).fill(document);
  const first = preview(page).getByRole('region', { name: 'Code cell: first', exact: true });
  const second = preview(page).getByRole('region', { name: 'Code cell: second', exact: true });
  const firstOutput = first.locator('[aria-label="Output: first"]');
  const secondOutput = second.locator('[aria-label="Output: second"]');
  await expect(firstOutput).toContainText('Not run');
  await expect(secondOutput).toContainText('Not run');
  await expect(first).toContainText('return {n: 2};');

  await second.getByRole('button', { name: 'Run cell: second', exact: true }).click();
  await expect(second.getByRole('alert')).toContainText('Run preceding cells first');
  await second.getByRole('button', { name: 'Run through: second', exact: true }).click();
  await expect(firstOutput).toContainText('"n": 2');
  await expect(secondOutput).toContainText('6');
  expect(await exportedText(page)).toBe(document);

  const edited = document.replace('return {n: 2};', 'return {n: 4};');
  await source(page).fill(edited);
  await expect(preview(page).getByRole('region', { name: 'Code cell: first' }).getByText(/Output is stale/i)).toBeVisible();
  await expect(preview(page).getByRole('region', { name: 'Code cell: second' }).getByText(/Output is stale/i)).toBeVisible();
  await expect(source(page)).toHaveText(edited, { useInnerText: true });
});

test('external media stays unloaded until the reader asks for it', async ({ page }) => {
  let externalRequests = 0;
  await page.route('https://example.test/**', async route => {
    externalRequests += 1;
    await route.abort();
  });
  const document = '![Remote preview](https://example.test/image.png)';
  await source(page).fill(document);
  const media = preview(page).getByRole('region', { name: 'Media: Remote preview', exact: true });
  await expect(media.getByRole('button', { name: 'Load external media: Remote preview', exact: true })).toBeVisible();
  expect(externalRequests).toBe(0);
  await media.getByRole('button', { name: 'Load external media: Remote preview', exact: true }).click();
  await expect.poll(() => externalRequests).toBe(1);
  await expect(media).toContainText(/Could not load image/i);
  expect(await exportedText(page)).toBe(document);
});

test('passive HTML resource attributes are stripped before rendering', async ({ page }) => {
  let externalRequests = 0;
  await page.route('https://example.test/**', async route => {
    externalRequests += 1;
    await route.abort();
  });
  const document = [
    '<img srcset="https://example.test/image-1.png 1x, https://example.test/image-2.png 2x" alt="Unrequested image">',
    '<video poster="https://example.test/poster.png"></video>',
    '<div background="https://example.test/background.png">Safe text</div>',
    '<a href="https://example.test/page" ping="https://example.test/ping">External link</a>',
  ].join('\n');
  await source(page).fill(document);
  await expect(preview(page)).toContainText('External link');
  await expect(preview(page)).toHaveAttribute('aria-busy', 'false');
  const residual = await preview(page).evaluate(element =>
    Array.from(element.querySelectorAll('[srcset],[poster],[background],[ping]'))
      .map(node => Array.from(node.attributes).filter(attribute => ['srcset','poster','background','ping'].includes(attribute.name)).map(attribute => attribute.name)),
  );
  expect(residual.flat()).toEqual([]);
  expect(externalRequests).toBe(0);
  expect(await exportedText(page)).toBe(document);
});

test('footnotes link to definitions and back without changing Markdown', async ({ page }) => {
  const document = 'A sentence with a note[^details].\n\n[^details]: The footnote definition.';
  await source(page).fill(document);
  const footnotes = preview(page).getByRole('region', { name: 'Footnotes', exact: true });
  const reference = preview(page).getByRole('link', { name: 'Footnote details', exact: true });
  await expect(footnotes).toContainText('The footnote definition.');
  await reference.click();
  await expect(footnotes.locator('[data-footnote-id="details"]')).toBeFocused();
  await footnotes.getByRole('link', { name: 'Back to footnote details', exact: true }).click();
  await expect(reference).toBeFocused();
  expect(await exportedText(page)).toBe(document);
});

test('Graphviz DOT fences render locally without external services', async ({ page }) => {
  const document = '```dot\ndigraph { A -> B }\n```';
  await source(page).fill(document);
  const graph = preview(page).locator('.advanced-diagram');
  await expect(graph.locator('svg')).toBeVisible({ timeout: 20000 });
  await expect(graph.locator('svg text')).toContainText(['A', 'B']);
  expect(await exportedText(page)).toBe(document);
});
