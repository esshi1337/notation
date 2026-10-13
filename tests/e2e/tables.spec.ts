import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const tablePanel = (page: Page) => page.getByRole('region', { name: 'Table editor', exact: true });

async function openDetails(panel: ReturnType<typeof tablePanel>, selector: string) {
  const details = panel.locator(selector);
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await details.locator('summary').click();
}

async function exportMarkdown(page: Page) {
  const pending = page.waitForEvent('download');
  await runCommand(page, 'Save');
  const file = await pending;
  const path = await file.path();
  if (!path) throw new Error('Markdown export did not provide a file.');
  return readFile(path, 'utf8');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('smart table edits apply once, preserve escaped cells, export CSV, and undo', async ({ page }) => {
  const original = '# Inventory\n\n| Name | Details |\n| --- | --- |\n| Alpha | keeps a \\| escaped pipe |\n| Beta | line one<br>line two |\n\nAfter the table.\n';
  await page.locator('input[type=file]').setInputFiles({ name: 'inventory.md', mimeType: 'text/markdown', buffer: Buffer.from(original) });
  await expect(page.getByRole('tab', { name: 'inventory.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await source(page).locator('.cm-line').filter({ hasText: 'Alpha' }).click();
  await runCommand(page, 'Table editor');
  const panel = tablePanel(page);
  const details = panel.getByRole('textbox', { name: 'Cell row 2 column 2', exact: true });
  await expect(details).toHaveValue('keeps a | escaped pipe');
  await details.fill('quoted, pipe | value\nsecond line');
  await panel.getByRole('combobox', { name: 'Column alignment', exact: true }).selectOption('center');
  await panel.getByRole('combobox', { name: 'Sort column', exact: true }).selectOption({ label: 'Name' });
  await panel.getByRole('button', { name: 'Sort descending', exact: true }).click();
  await panel.getByRole('button', { name: 'Apply table', exact: true }).click();
  const saved = await exportMarkdown(page);
  expect(saved).toContain('| --- | :---: |');
  expect(saved.indexOf('| Beta | line one<br>line two |')).toBeLessThan(saved.indexOf('| Alpha | quoted, pipe \\| value<br>second line |'));
  expect(saved).toContain('After the table.');

  await panel.getByRole('button', { name: 'Edit table 1', exact: true }).click();
  await openDetails(panel, 'details.table-csv');
  const csvPending = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export CSV', exact: true }).click();
  const csv = await csvPending;
  const csvPath = await csv.path();
  if (!csvPath) throw new Error('CSV export did not provide a file.');
  expect(await readFile(csvPath, 'utf8')).toBe('Name,Details\r\nBeta,"line one\nline two"\r\nAlpha,"quoted, pipe | value\nsecond line"\r\n');

  await source(page).focus();
  await source(page).press('ControlOrMeta+z');
  expect(await exportMarkdown(page)).toBe(original);
});

test('CSV import parses quoted commas, quotes, pipes, and multiline cells before Apply', async ({ page }) => {
  const initial = '# Imported table\n\nExisting body.\n';
  await source(page).fill(initial);
  await runCommand(page, 'Table editor');
  const panel = tablePanel(page);
  await openDetails(panel, 'details.table-csv');
  const csv = 'Name,Notes\r\nAlpha,"comma, ""quoted"" | value"\r\nBeta,"first line\r\nsecond line"\r\n';
  await page.locator('input[aria-label="Import CSV file"]').setInputFiles({
    name: 'records.csv', mimeType: 'text/csv', buffer: Buffer.from(csv),
  });
  await expect(panel.getByRole('textbox', { name: 'Cell row 2 column 2', exact: true })).toHaveValue('comma, "quoted" | value');
  await expect(panel.getByRole('textbox', { name: 'Cell row 3 column 2', exact: true })).toHaveValue('first line\nsecond line');
  await expect(source(page)).toHaveText(initial, { useInnerText: true });

  await panel.getByRole('button', { name: 'Apply table', exact: true }).click();
  const markdown = await exportMarkdown(page);
  expect(markdown).toContain('| Alpha | comma, "quoted" \\| value |');
  expect(markdown).toContain('| Beta | first line<br>second line |');
  expect(markdown).toContain('Existing body.');

  await openDetails(panel, 'details.table-csv');
  const csvPending = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export CSV', exact: true }).click();
  const download = await csvPending;
  const path = await download.path();
  if (!path) throw new Error('CSV export did not provide a file.');
  expect(await readFile(path, 'utf8')).toBe('Name,Notes\r\nAlpha,"comma, ""quoted"" | value"\r\nBeta,"first line\nsecond line"\r\n');
});

test('Preview and Live table headers align with body columns without a row gap', async ({ page }) => {
  const markdown = '# Project matrix\n\n| Project | Center | Right |\n| --- | :---: | ---: |\n| North star planning | Stable first column | 120 |\n| Beta | Short | 42 |\n';
  await source(page).fill(markdown);
  await runCommand(page, 'Preview');
  const previewTable = page.getByRole('region', { name: 'Document preview', exact: true }).locator('table');
  await expect(previewTable).toBeVisible();

  const expectAlignedGrid = async (table: ReturnType<typeof page.locator>) => {
    const geometry = await table.evaluate(element => {
      const headers = Array.from(element.querySelectorAll('th'));
      const firstBodyRow = element.querySelector('tbody tr');
      const bodyCells = Array.from(firstBodyRow?.querySelectorAll('td') ?? []);
      const header = headers[0];
      const firstCell = element.querySelector('tbody td:first-child');
      if (!header || !firstCell || headers.length < 3 || bodyCells.length < 3) throw new Error('Table is missing its first header/body cell.');
      const headerRect = header.getBoundingClientRect();
      const bodyRect = firstCell.getBoundingClientRect();
      return {
        widthDelta: Math.abs(headerRect.width - bodyRect.width),
        verticalGap: Math.abs(bodyRect.top - headerRect.bottom),
        center: [getComputedStyle(headers[1]).textAlign, getComputedStyle(bodyCells[1]).textAlign],
        right: [getComputedStyle(headers[2]).textAlign, getComputedStyle(bodyCells[2]).textAlign],
      };
    });
    expect(geometry.widthDelta).toBeLessThanOrEqual(1);
    expect(geometry.verticalGap).toBeLessThanOrEqual(1);
    expect(geometry.center).toEqual(['center', 'center']);
    expect(geometry.right).toEqual(['right', 'right']);
  };
  await expectAlignedGrid(previewTable);

  await runCommand(page, 'Live Preview');
  const liveTable = source(page).locator('.cm-live-table table');
  await expect(liveTable).toBeVisible();
  await expectAlignedGrid(liveTable);
  expect(await exportMarkdown(page)).toBe(markdown);
});
