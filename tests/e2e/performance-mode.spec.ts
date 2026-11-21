import { test, expect } from '@playwright/test';
import { mac, openSettings, runCommand } from './commands';

const source = (page: import('@playwright/test').Page) => page.getByRole('textbox', { name: 'Document source' }).filter({ visible: true });
async function editorSettings(page: import('@playwright/test').Page) {
  await openSettings(page);
  await page.getByRole('tab', { name: 'Editor', exact: true }).click();
}

test('performance mode suspends expensive views and restores settings and undo', async ({ page }) => {
  await page.goto('/');
  await runCommand(page, 'Source');
  await source(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nPreserve this edit');
  await runCommand(page, 'Split');
  await editorSettings(page);
  await expect(page.getByRole('checkbox', { name: 'Performance mode', exact: true })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Language intelligence', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Performance mode', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Language intelligence', exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Smooth scrolling', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Layout', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(page.locator('main.app')).toHaveAttribute('data-performance-mode', 'true');
  await expect(page.locator('.preview-pane')).toBeHidden();
  await expect(page.locator('.preview-pane')).not.toContainText('Preserve this edit');
  await expect(source(page)).toContainText('Preserve this edit');
  await page.keyboard.press('ControlOrMeta+Alt+3');
  await expect(page.locator('.preview-pane')).toBeHidden();
  await editorSettings(page);
  await page.getByRole('checkbox', { name: 'Performance mode', exact: true }).uncheck();
  await expect(page.getByRole('checkbox', { name: 'Language intelligence', exact: true })).toBeChecked();
  // Smooth scrolling returns to its default, which is off on macOS.
  const smooth = page.getByRole('checkbox', { name: 'Smooth scrolling', exact: true });
  if (mac) await expect(smooth).not.toBeChecked(); else await expect(smooth).toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Layout', exact: true })).toHaveText('Split');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(page.locator('.preview-pane')).toBeVisible();
  await runCommand(page, 'Undo');
  await expect(source(page)).not.toContainText('Preserve this edit');
});

test('persisted performance mode skips code syntax loading and remains editable', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('notation.settings', JSON.stringify({ performanceMode: true, languageIntelligenceEnabled: true })));
  const syntaxRequests: string[] = [];
  page.on('request', request => { if (/\/src\/(code-syntax|language-intelligence)\.ts/.test(request.url())) syntaxRequests.push(request.url()); });
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'low-memory.ts', mimeType: 'text/plain', buffer: Buffer.from('export const answer: number = 42;\n') });
  await expect(source(page)).toContainText('export const answer');
  await source(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('// still editable');
  await expect(source(page)).toContainText('// still editable');
  await expect(page.locator('.cm-editor')).toHaveCount(1);
  expect(syntaxRequests).toEqual([]);
});
