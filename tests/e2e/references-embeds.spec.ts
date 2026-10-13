import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const preview = (page: Page) => page.getByRole('region', { name: 'Document preview' });

async function importMarkdown(page: Page, name: string, text: string) {
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) });
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
}

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

test('heading and block embeds are read-only and keep their source text unchanged', async ({ page }) => {
  const target = '# Target\n\n## Deep heading\n\nHeading excerpt.\n\nParagraph block. ^intro\n\n- [ ] Embedded task\n';
  const document = '![[Target#Deep heading]]\n\n![[Target#^intro]]\n';
  await importMarkdown(page, 'Target.md', target);
  await runCommand(page, 'New');
  await importMarkdown(page, 'Source.md', document);

  const headingEmbed = preview(page).getByRole('region', { name: 'Embedded note: Target#Deep heading', exact: true });
  const blockEmbed = preview(page).getByRole('region', { name: 'Embedded note: Target#^intro', exact: true });
  await expect(headingEmbed).toContainText('Heading excerpt.');
  await expect(blockEmbed).toContainText('Paragraph block.');
  await expect(blockEmbed.locator('.embed-body')).not.toContainText('^intro');
  await expect(headingEmbed.getByRole('checkbox', { name: 'Task: Embedded task' })).toBeDisabled();
  expect(await exportedText(page)).toBe(document);
});

test('recursive embeds show a cycle error rather than expanding indefinitely', async ({ page }) => {
  const sourceText = '# Source\n\n![[Target]]\n';
  await importMarkdown(page, 'Target.md', '# Target\n\n![[Source]]\n');
  await runCommand(page, 'New');
  await importMarkdown(page, 'Source.md', sourceText);

  const targetEmbed = preview(page).getByRole('region', { name: 'Embedded note: Target', exact: true });
  const recursiveEmbed = targetEmbed.getByRole('region', { name: 'Embedded note: Source', exact: true });
  await expect(recursiveEmbed.getByRole('alert')).toContainText(/circular embed/i);
  expect(await exportedText(page)).toBe(sourceText);
});

test('query fences report their desktop requirement in browser mode without changing source', async ({ page }) => {
  const query = [
    '# Query results',
    '',
    '```query',
    'view: table',
    'columns: [title, status]',
    'where:',
    '  - key: status',
    '    op: eq',
    '    value: active',
    '```',
  ].join('\n');
  await source(page).fill(query);
  const databaseView = preview(page).getByRole('region', { name: 'Database view', exact: true });
  await expect(databaseView.getByRole('alert')).toContainText(/workspace queries require the desktop app/i);
  await databaseView.getByRole('button', { name: 'Refresh query', exact: true }).click();
  await expect(databaseView.getByRole('alert')).toContainText(/workspace queries require the desktop app/i);
  expect(await exportedText(page)).toBe(query);
});

test('note graph explains that workspace indexing requires the desktop app in browser mode', async ({ page }) => {
  await runCommand(page, 'Note graph');
  const graph = page.getByRole('region', { name: 'Note graph', exact: true });
  await expect(graph).toBeVisible();
  await expect(graph.getByRole('alert')).toContainText(/requires a desktop workspace/i);
  await expect(graph.getByRole('img', { name: 'Workspace note connections' })).toHaveCount(0);
});
