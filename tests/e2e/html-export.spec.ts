import { expect, test, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });

async function importMarkdown(page: Page, name: string, text: string) {
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) });
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
}

test('self-contained HTML export is static, includes rendered Markdown, and opens offline without changing source', async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
  await importMarkdown(page, 'Target.md', '# Embedded target\n\nRead-only target text.\n');
  await runCommand(page, 'New');
  const document = [
    '# Static export',
    '',
    '- [ ] Exported task',
    '',
    '| Alignment | Center | Right |',
    '| --- | :---: | ---: |',
    '| Values | centered | 42 |',
    '',
    '> [!TIP] Exported callout',
    '> Callout content.',
    '',
    '$$\n\\frac{1}{2}\n$$',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[Offline] --> B[Ready]',
    '```',
    '',
    '![[Target]]',
  ].join('\n');
  await source(page).fill(document);
  await runCommand(page, 'Export');
  const panel = page.getByRole('region', { name: 'Export', exact: true });
  await panel.getByRole('combobox', { name: 'Export format' }).selectOption('self-contained');
  const pending = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export document', exact: true }).click();
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error('HTML export did not provide a file.');
  const html = await readFile(path, 'utf8');
  expect(html).toContain('<!doctype html>');
  expect(html).toContain('Static export');
  expect(html).toContain('Embedded target');
  expect(html).toContain('Read-only target text.');
  expect(html).toContain('Exported task');
  expect(html).toContain('Exported callout');
  expect(html).toContain('.katex');
  expect(html).toContain('Offline');
  expect(html).not.toMatch(/<script\b|https?:\/\/fonts\.(?:googleapis|gstatic)\.com/iu);
  expect(html).not.toMatch(/data-callout-edit|data-callout-toggle|aria-label="Refresh embed:/u);

  const offlinePath = resolve('test-results/notation-export-offline.html');
  await writeFile(offlinePath, html, 'utf8');
  const offline = await page.context().newPage();
  await offline.route('**/*', route => route.request().url().startsWith('file:') ? route.continue() : route.abort());
  await offline.goto(pathToFileURL(offlinePath).href);
  await expect(offline.getByRole('heading', { name: 'Static export', exact: true })).toBeVisible();
  await expect(offline.getByRole('heading', { name: 'Embedded target', exact: true })).toBeVisible();
  await expect(offline.locator('.katex')).toHaveCount(1);
  await expect(offline.locator('.diagram svg')).toHaveCount(1);
  const alignment = await offline.locator('.markdown-body table').evaluate(table => {
    const headers = Array.from(table.querySelectorAll('th'));
    const cells = Array.from(table.querySelectorAll('tbody tr:first-child td'));
    return { center: [getComputedStyle(headers[1]).textAlign, getComputedStyle(cells[1]).textAlign], right: [getComputedStyle(headers[2]).textAlign, getComputedStyle(cells[2]).textAlign] };
  });
  expect(alignment).toEqual({ center: ['center', 'center'], right: ['right', 'right'] });
  await expect(offline.getByRole('checkbox', { name: 'Exported task' })).toBeDisabled();
  await offline.close();
  await expect(source(page)).toHaveText(document, { useInnerText: true });
});

test('native converter receives actual KaTeX annotations from the rendered HTML export', async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
  const markdown = '# Converter math\n\nInline $\\frac{1}{2}$ and display:\n\n$$\\sqrt{x}$$\n';
  await source(page).fill(markdown);
  await runCommand(page, 'Preview');
  await expect(page.getByRole('region', { name: 'Document preview', exact: true }).locator('.katex')).toHaveCount(2);
  const rendered = await page.evaluate(async text => {
    const { buildHtmlExport } = await import('/src/export-html.ts');
    const { prepareConverterHtml } = await import('/src/export-converter.ts');
    const built = await buildHtmlExport({ name: 'math-converter.md', text, documentId: 1 }, { format: 'self-contained', theme: 'light' });
    const sourceHtml = document.createElement('template');
    sourceHtml.innerHTML = built.html;
    const annotations = Array.from(sourceHtml.content.querySelectorAll('annotation[encoding="application/x-tex"]'), annotation => annotation.textContent);
    const converted = prepareConverterHtml(built.html);
    return { annotations, content: converted.content, assets: converted.assets };
  }, markdown);
  expect(rendered.annotations).toEqual(['\\frac{1}{2}', '\\sqrt{x}']);
  expect(rendered.content).toContain('\\(\\frac{1}{2}\\)');
  expect(rendered.content).toContain('\\[\\sqrt{x}\\]');
  expect(rendered.content).not.toContain('<annotation');
  expect(rendered.content).not.toContain('class="katex"');
  expect(rendered.assets).toEqual([]);
  await runCommand(page, 'Source');
  await expect(source(page)).toHaveText(markdown, { useInnerText: true });
});

test('converter math path keeps untrusted TeX inert', async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
  const markdown = '# Untrusted TeX\n\n$\\href{javascript:alert(1)}{blocked}$\n';
  await source(page).fill(markdown);
  const converted = await page.evaluate(async text => {
    const { buildHtmlExport } = await import('/src/export-html.ts');
    const { prepareConverterHtml } = await import('/src/export-converter.ts');
    const built = await buildHtmlExport({ name: 'untrusted-math.md', text, documentId: 2 }, { format: 'self-contained', theme: 'light' });
    return prepareConverterHtml(built.html).content;
  }, markdown);
  expect(converted).not.toMatch(/<script\b|href=["']javascript:/iu);
  expect(converted).toContain('\\href{javascript:alert(1)}{blocked}');
  expect(await page.getByRole('region', { name: 'Document preview', exact: true }).locator('a[href^="javascript:"], script, [onerror]').count()).toBe(0);
  await expect(source(page)).toHaveText(markdown, { useInnerText: true });
});
