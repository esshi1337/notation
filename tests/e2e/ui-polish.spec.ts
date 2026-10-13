import { expect, test } from '@playwright/test';
import { runCommand } from './commands';

test('settings filter shortcuts and disable irrelevant appearance controls', async ({ page }) => {
  await page.goto('/');
  await runCommand(page, 'Settings');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('light');
  await expect(settings.getByRole('combobox', { name: 'Dark preset' })).toBeDisabled();
  await settings.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('dark');
  await expect(settings.getByRole('combobox', { name: 'Dark preset' })).toBeEnabled();
  await settings.getByRole('tab', { name: 'Shortcuts', exact: true }).click();
  const search = settings.getByRole('searchbox', { name: 'Search shortcuts' });
  await search.fill('table');
  await expect(settings.getByRole('textbox', { name: 'Shortcut for Table editor', exact: true })).toBeVisible();
  await expect(settings.getByRole('textbox', { name: 'Shortcut for New', exact: true })).toHaveCount(0);
  await search.fill('no such shortcut');
  await expect(settings.getByText('No matching shortcuts.', { exact: true })).toBeVisible();
});

test('canvas offers only meaningful layout choices in a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 520 });
  await page.goto('/');
  await runCommand(page, 'New canvas');
  const layout = page.getByRole('button', { name: 'Layout', exact: true });
  await expect(layout).toHaveText('Canvas');
  await layout.click();
  const menu = page.getByRole('menu', { name: 'Layout', exact: true });
  await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
  await expect(menu.getByRole('menuitemradio', { name: 'Canvas', exact: true })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: 'Source', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Document source', exact: true })).toBeVisible();
  await layout.click();
  await menu.getByRole('menuitemradio', { name: 'Canvas', exact: true }).click();
  await expect(page.getByRole('application', { name: 'Canvas board', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
