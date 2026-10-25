import { expect, test, type Page } from '@playwright/test';
import { commandResults, enableScripts, openSettings, runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const scripts = (page: Page) => page.getByRole('dialog', { name: 'Scripts', exact: true });
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'App sidebar' });
const scriptsButton = (page: Page) => sidebar(page).getByRole('button', { name: 'Scripts panel', exact: true });
const scriptsToggle = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('checkbox', { name: 'Enable scripts', exact: true });

test('scripts are hidden on a fresh install and Settings explains the opt-in', async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
  await expect(scriptsButton(page)).toHaveCount(0);
  await openSettings(page);
  await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Editor', exact: true }).click();
  await expect(scriptsToggle(page)).not.toBeChecked();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toContainText('Off by default. Shows the Scripts panel and its command.');
});

test('invalid stored values keep scripts off and the disabled command explains how to enable them', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('notation.settings', JSON.stringify({ scriptsEnabled: 'true' })));
  await page.goto('/');
  await expect(source(page)).toBeVisible();
  await expect(scriptsButton(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search commands', exact: true }).fill('Scripts');
  const option = commandResults(page).getByRole('option', { name: 'Scripts (enable in Settings → Editor)', exact: true });
  await expect(option).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Alt+s');
  await expect(scripts(page)).toHaveCount(0);
  await expect(page.locator('.status-message')).toContainText('Enable scripts in Settings → Editor');
});

test('enabling scripts persists and shows the saved library and draft without running it', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('scripts-opt-in-seeded')) return;
    sessionStorage.setItem('scripts-opt-in-seeded', '1');
    localStorage.setItem('notation.settings', JSON.stringify({ scriptsEnabled: false }));
  });
  await page.goto('/');
  await expect(source(page)).toBeVisible();
  await expect(scriptsButton(page)).toHaveCount(0);
  await page.evaluate(() => {
    const updatedAt = Date.now();
    localStorage.setItem('notation.scripts', JSON.stringify({ name: 'Kept draft', code: 'throw new Error("must not run");', cwd: null, updatedAt }));
    localStorage.setItem('notation.script-library', JSON.stringify([
      { id: 'kept-script', name: 'Kept library', code: 'return "library";', cwd: null, updatedAt },
    ]));
  });
  await page.reload();
  await expect(scriptsButton(page)).toHaveCount(0);

  await enableScripts(page);
  await expect(scriptsButton(page)).toBeVisible();
  await page.reload();
  await expect(scriptsButton(page)).toBeVisible();

  await scriptsButton(page).click();
  const panel = scripts(page);
  await expect(panel.getByRole('textbox', { name: 'Script name' })).toHaveValue('Kept draft');
  await expect(panel.getByRole('textbox', { name: 'Script code' })).toHaveValue('throw new Error("must not run");');
  await expect(panel.getByRole('combobox', { name: 'Saved script' }).locator('option').filter({ hasText: /^Kept library$/ })).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Apply to document' })).toBeDisabled();
  await expect(panel.locator('.script-error')).toHaveCount(0);
});

test('disabling scripts unmounts a running panel, stops it, and preserves the draft', async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
  await enableScripts(page);
  await scriptsButton(page).click();
  const panel = scripts(page);
  await panel.getByRole('textbox', { name: 'Script code' }).fill('while (true) {}');
  await panel.getByRole('button', { name: 'Run script' }).click();
  await expect(panel.getByRole('button', { name: 'Stop script' })).toBeEnabled();

  await openSettings(page);
  await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Editor', exact: true }).click();
  await scriptsToggle(page).uncheck();
  await expect(panel).toHaveCount(0);
  await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close settings' }).click();
  await expect(scriptsButton(page)).toHaveCount(0);

  await enableScripts(page);
  await scriptsButton(page).click();
  const reopened = scripts(page);
  await expect(reopened.getByRole('textbox', { name: 'Script code' })).toHaveValue('while (true) {}');
  await expect(reopened.getByRole('button', { name: 'Run script' })).toBeEnabled();
  await expect(reopened.getByRole('button', { name: 'Stop script' })).toBeDisabled();
  await expect(reopened.getByLabel('Script output')).toHaveCount(0);
});

test('script recovery cannot bypass the toggle and becomes available when enabled', async ({ page }) => {
  await page.addInitScript(() => {
    const updatedAt = Date.now();
    localStorage.setItem('notation.settings', JSON.stringify({ scriptsEnabled: false }));
    localStorage.setItem('notation.pending-recovery', JSON.stringify({
      failedAt: updatedAt,
      scriptDraft: { name: 'Recovered transform', code: 'throw new Error("recovered script must not run");', cwd: null, updatedAt },
    }));
  });
  await page.goto('/');
  await expect(source(page)).toBeVisible();
  const banner = page.locator('.recovery-banner');
  await expect(banner).toContainText('Enable scripts in Settings → Editor to restore these edits.');
  await expect(banner.getByRole('button', { name: 'Restore script edits' })).toHaveCount(0);
  await page.keyboard.press('Control+Alt+s');
  await expect(scripts(page)).toHaveCount(0);

  await enableScripts(page);
  await expect(banner.getByRole('button', { name: 'Restore script edits' })).toBeVisible();
  await banner.getByRole('button', { name: 'Restore script edits' }).click();
  const panel = scripts(page);
  await expect(panel.getByRole('textbox', { name: 'Script code' })).toHaveValue('throw new Error("recovered script must not run");');
  await expect(panel.locator('.script-error')).toHaveCount(0);
  await expect(page.locator('.status-message')).toContainText('Script edits restored from backup');
});

test('script commands remain reachable through the palette once enabled', async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
  await enableScripts(page);
  await runCommand(page, 'Scripts');
  await expect(scripts(page)).toBeVisible();
});
