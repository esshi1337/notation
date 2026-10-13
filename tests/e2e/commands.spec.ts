import { expect, test, type Page } from '@playwright/test';
import { commandPalette, commandResults, runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const documents = (page: Page) => page.getByRole('tablist', { name: 'Documents', exact: true });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('searches command labels, runs a command by keyboard, and restores focus on Escape', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Commands', exact: true });
  await trigger.click();
  const palette = commandPalette(page);
  const search = palette.getByRole('textbox', { name: 'Search commands', exact: true });
  await expect(search).toBeFocused();
  await search.fill('New');
  const createTab = commandResults(page).getByRole('option', { name: 'New', exact: true });
  await expect(createTab).toBeVisible();
  await expect(createTab).toHaveAttribute('aria-selected', 'true');
  await search.press('Enter');
  await expect(palette).not.toBeVisible();
  await expect(documents(page).getByRole('tab')).toHaveCount(2);
  await expect(documents(page).getByRole('tab', { name: 'untitled.md', exact: true })).toHaveAttribute('aria-selected', 'true');

  await trigger.click();
  await palette.getByRole('textbox', { name: 'Search commands', exact: true }).fill('Git');
  await expect(commandResults(page).getByRole('option', { name: 'Git', exact: true })).toBeVisible();
  await expect(commandResults(page).getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(palette).not.toBeVisible();
  await expect(trigger).toBeFocused();

  await source(page).focus();
  await page.keyboard.press('Control+k');
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('textbox', { name: 'Search commands' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(source(page)).toBeFocused();
});

test('Enter on Close commands closes the palette without running the selected command', async ({ page }) => {
  const tabs = documents(page);
  await expect(tabs.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  const palette = commandPalette(page);
  await palette.getByRole('button', { name: 'Close commands', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(palette).not.toBeVisible();
  await expect(tabs.getByRole('tab')).toHaveCount(1);
});

test('Ctrl+N works in the editor, while shortcut actions are guarded by modal settings', async ({ page }) => {
  const initialTabCount = () => documents(page).getByRole('tab').count();
  await source(page).press('ControlOrMeta+n');
  await expect(documents(page).getByRole('tab')).toHaveCount(2);
  await expect(documents(page).getByRole('tab', { name: 'untitled.md', exact: true })).toHaveAttribute('aria-selected', 'true');

  const before = await initialTabCount();
  await runCommand(page, 'Settings');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  await page.keyboard.press('ControlOrMeta+n');
  await expect(settings).toBeVisible();
  await expect(documents(page).getByRole('tab')).toHaveCount(before);
  await page.keyboard.press('Escape');
  await expect(settings).not.toBeVisible();
});
