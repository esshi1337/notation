import { expect, test, type Page } from '@playwright/test';
import { runCommand, setSetting, expectSetting, commandResults } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('Settings traps focus, closes with Escape, restores focus, and persists preferences', async ({ page }) => {
  await source(page).focus();
  await page.keyboard.press('ControlOrMeta+,');
  const panel = settings(page);
  await expect(panel).toBeVisible();
  const appearance = panel.getByRole('tab', { name: 'Appearance', exact: true });
  await expect(appearance).toBeFocused();

  for (let index = 0; index < 9; index += 1) {
    await page.keyboard.press('Tab');
    const focusState = await page.evaluate(() => {
      const dialog = document.querySelector('dialog[aria-label="Settings"]');
      return { inDialog: !!dialog && dialog.contains(document.activeElement), isModal: dialog?.matches(':modal'), active: document.activeElement?.outerHTML };
    });
    expect(focusState.inDialog, `Tab ${index + 1} escaped Settings; state=${JSON.stringify(focusState)}`).toBe(true);
  }
  await setSetting(page, 'Theme', 'light');
  await panel.getByRole('tab', { name: 'Editor', exact: true }).click();
  await setSetting(page, 'Layout', 'source');
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  await expect(source(page)).toBeFocused();

  await page.reload();
  await runCommand(page, 'Settings');
  await settings(page).getByRole('tab', { name: 'Appearance', exact: true }).click();
  await expectSetting(page, 'Theme', 'light');
  await settings(page).getByRole('tab', { name: 'Editor', exact: true }).click();
  await expectSetting(page, 'Layout', 'source');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(source(page)).toBeVisible();
});

test('Explorer explains its native requirement and Git is unavailable in browser mode', async ({ page }) => {
  await runCommand(page, 'Explorer');
  const explorer = page.getByRole('region', { name: 'Explorer', exact: true });
  await expect(explorer).toBeVisible();
  await expect(explorer).toContainText(/desktop app/i);
  await expect(explorer.getByRole('treeitem')).toHaveCount(0);
  await expect(explorer.getByRole('alert')).toHaveCount(0);

  await page.getByRole('button', { name: 'Close explorer' }).click();
  await expect(page.getByRole('button', { name: 'Git panel', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search commands', exact: true }).fill('Git');
  await expect(commandResults(page).getByRole('option', { name: 'Git', exact: true })).toBeDisabled();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await source(page).focus();
  const text = await source(page).textContent();
  await page.keyboard.press('ControlOrMeta+Shift+g');
  const git = page.getByRole('region', { name: 'Git', exact: true });
  await expect(git).toHaveCount(0);
  await expect(source(page)).toHaveText(text!);
});
