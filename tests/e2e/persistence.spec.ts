import { expect, test, type Page } from '@playwright/test';
import { runCommand, expectSetting } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const scripts = (page: Page) => page.getByRole('dialog', { name: 'Scripts', exact: true });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('saves, selects, and deletes named scripts without running them', async ({ page }) => {
  await runCommand(page, 'Scripts');
  const panel = scripts(page);
  await panel.getByRole('textbox', { name: 'Script name' }).fill('Uppercase');
  await panel.getByRole('textbox', { name: 'Script code' }).fill('return api.context.document.text.toUpperCase();');
  await panel.getByRole('button', { name: 'Save script', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: 'Saved script' }).locator('option').filter({ hasText: /^Uppercase$/ })).toHaveCount(1);
  await panel.getByRole('button', { name: 'New script', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Script name' }).fill('Lowercase');
  await panel.getByRole('textbox', { name: 'Script code' }).fill('return api.context.document.text.toLowerCase();');
  await panel.getByRole('button', { name: 'Save script', exact: true }).click();
  await panel.getByRole('combobox', { name: 'Saved script' }).selectOption({ label: 'Uppercase' });
  await expect(panel.getByRole('textbox', { name: 'Script code' })).toHaveValue('return api.context.document.text.toUpperCase();');
  await expect(panel.getByRole('button', { name: 'Apply to document' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Delete script', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: 'Saved script' }).locator('option').filter({ hasText: /^Uppercase$/ })).toHaveCount(0);
  await page.reload();
  await runCommand(page, 'Scripts');
  await scripts(page).getByRole('combobox', { name: 'Saved script' }).selectOption({ label: 'Lowercase' });
  await expect(scripts(page).getByRole('textbox', { name: 'Script code' })).toHaveValue('return api.context.document.text.toLowerCase();');
});

test('preserves an unsaved script draft separately and updates the same saved entry', async ({ page }) => {
  await runCommand(page, 'Scripts');
  let panel = scripts(page);
  await panel.getByRole('textbox', { name: 'Script name' }).fill('Draft test');
  await panel.getByRole('textbox', { name: 'Script code' }).fill('return "saved";');
  await panel.getByRole('button', { name: 'Save script', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Script code' }).fill('return "unsaved working draft";');
  await panel.getByRole('button', { name: 'Close scripts' }).click();
  await page.reload();
  await runCommand(page, 'Scripts');
  panel = scripts(page);
  await expect(panel.getByRole('textbox', { name: 'Script code' })).toHaveValue('return "unsaved working draft";');
  await panel.getByRole('button', { name: 'Save script', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: 'Saved script' }).locator('option').filter({ hasText: /^Draft test$/ })).toHaveCount(1);
});

test('keeps legacy preferences, document recovery, and the existing script', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('notation.session');
    localStorage.setItem('notation.settings', JSON.stringify({ theme: 'light', fontSize: 17, wrap: false, layout: 'source' }));
    localStorage.setItem('notation.draft', JSON.stringify({ name: 'legacy.md', content: '# Legacy draft', savedContent: '# Legacy draft', savedName: 'legacy.md', path: null }));
    localStorage.setItem('notation.scripts', JSON.stringify({ name: 'Legacy script', code: 'return "legacy";', cwd: '/tmp' }));
  });
  await page.reload();
  await expect(source(page)).toHaveText('# Legacy draft');
  await runCommand(page, 'Settings');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await expectSetting(page, 'Theme', 'light');
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  await expect(settings.getByRole('spinbutton', { name: 'Font size' })).toHaveValue('17');
  await expect(settings.getByRole('checkbox', { name: 'Word wrap' })).not.toBeChecked();
  await page.keyboard.press('Escape');
  await runCommand(page, 'Scripts');
  await expect(scripts(page).getByRole('textbox', { name: 'Script name' })).toHaveValue('Legacy script');
  await expect(scripts(page).getByRole('textbox', { name: 'Script code' })).toHaveValue('return "legacy";');
  await expect(scripts(page).getByRole('button', { name: 'Apply to document' })).toBeDisabled();
});

test('workspace tools explain the native requirement in browser mode', async ({ page }) => {
  await runCommand(page, 'Workspace');
  const panel = page.getByRole('region', { name: 'Workspace', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/desktop/i);
  await panel.getByRole('textbox', { name: 'Workspace name', exact: true }).fill('Browser views');
  await panel.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Add files', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Refresh index', exact: true })).toBeDisabled();
  await expect(source(page)).toContainText('Welcome to Notation');
});

test('tool panels are mutually exclusive and leave the document intact', async ({ page }) => {
  await source(page).fill('# My working draft');
  await runCommand(page, 'Workspace');
  await expect(page.getByRole('region', { name: 'Workspace', exact: true })).toBeVisible();
  await runCommand(page, 'History');
  await expect(page.getByRole('region', { name: 'Workspace', exact: true })).not.toBeVisible();
  await expect(page.getByRole('region', { name: 'History', exact: true })).toBeVisible();
  await runCommand(page, 'Scripts');
  await expect(page.getByRole('region', { name: 'History', exact: true })).not.toBeVisible();
  await expect(scripts(page)).toBeVisible();
  await expect(source(page)).toHaveText('# My working draft');
});

test('recovery-cache failures are visible while editing remains usable', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
  });
  await page.reload();
  await expect(source(page)).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/recovery cache.*unavailable/i);
  await source(page).fill('# Still editable');
  await expect(source(page)).toHaveText('# Still editable');
});

test('restores script edits without running them or changing the saved library', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('notation.script-library', JSON.stringify([
      { id: 'saved-script', name: 'Saved transform', code: 'return "saved";', cwd: null, updatedAt: Date.now() },
    ]));
    localStorage.setItem('notation.pending-recovery', JSON.stringify({
      failedAt: Date.now(),
      scriptDraft: { name: 'Recovered transform', code: 'throw new Error("recovered script must not run");', cwd: null, updatedAt: Date.now() },
    }));
  });
  await page.reload();
  const banner = page.locator('.recovery-banner');
  await expect(banner).toContainText('Work available to restore');
  await expect(banner.getByRole('button', { name: 'Restore tabs' })).toHaveCount(0);
  await expect(banner.getByRole('button', { name: 'Restore document' })).toHaveCount(0);
  await banner.getByRole('button', { name: 'Restore script edits' }).click();

  const panel = scripts(page);
  await expect(panel.getByRole('textbox', { name: 'Script code' })).toHaveValue('throw new Error("recovered script must not run");');
  await expect(panel.getByRole('combobox', { name: 'Saved script' })).toHaveValue('');
  await expect(panel.getByRole('combobox', { name: 'Saved script' }).locator('option').filter({ hasText: /^Saved transform$/ })).toHaveCount(1);
  await expect(panel.getByRole('combobox', { name: 'Saved script' }).locator('option').filter({ hasText: /^Recovered transform$/ })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Apply to document' })).toBeDisabled();
  await expect(panel.locator('.script-error')).toHaveCount(0);
  await expect(page.locator('.status-message')).toContainText('Script edits restored from backup');
  await expect(source(page)).toContainText('Welcome to Notation');
});

test('keeps current document and script work when the offer is dismissed, then restores a document', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('recovery-test-seeded')) return;
    sessionStorage.setItem('recovery-test-seeded', '1');
    const updatedAt = Date.now();
    localStorage.setItem('notation.session', JSON.stringify({
      activeTabId: 'current-tab', updatedAt,
      tabs: [{ id: 'current-tab', name: 'current.md', path: null, content: '# Current work', savedContent: '# Current work', savedName: 'current.md', updatedAt }],
    }));
    localStorage.setItem('notation.scripts', JSON.stringify({ name: 'Current script draft', code: 'return "current";', cwd: null }));
    localStorage.setItem('notation.script-library', JSON.stringify([
      { id: 'saved-script', name: 'Saved transform', code: 'return "saved";', cwd: null, updatedAt },
    ]));
    localStorage.setItem('notation.pending-recovery', JSON.stringify({
      failedAt: updatedAt,
      draft: { id: 'offered-document', name: 'offered.md', path: null, content: '# Offered document', savedContent: '# Offered document', savedName: 'offered.md', updatedAt },
      scriptDraft: { name: 'Offered script', code: 'return "offered";', cwd: null, updatedAt },
    }));
  });
  await page.reload();
  await expect(source(page)).toHaveText('# Current work');

  const banner = page.locator('.recovery-banner');
  await expect(banner).toContainText('Work available to restore');
  await expect(banner.getByRole('button', { name: 'Restore document' })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Restore script edits' })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Restore tabs' })).toHaveCount(0);
  await banner.getByRole('button', { name: 'Keep current work' }).click();
  await expect(banner).toHaveCount(0);
  await expect(source(page)).toHaveText('# Current work');

  await runCommand(page, 'Scripts');
  const panel = scripts(page);
  await expect(panel.getByRole('textbox', { name: 'Script name' })).toHaveValue('Current script draft');
  await expect(panel.getByRole('textbox', { name: 'Script code' })).toHaveValue('return "current";');
  await panel.getByRole('button', { name: 'Close scripts' }).click();

  // The guarded init script keeps current work; offer a different document for restore.
  await page.evaluate(() => {
    const updatedAt = Date.now();
    localStorage.setItem('notation.pending-recovery', JSON.stringify({
      failedAt: updatedAt,
      draft: { id: 'second-offer', name: 'second.md', path: null, content: '# Restored document', savedContent: '# Restored document', savedName: 'second.md', updatedAt },
    }));
  });
  await page.reload();
  await expect(source(page)).toHaveText('# Current work');
  const nextBanner = page.locator('.recovery-banner');
  await expect(nextBanner.getByRole('button', { name: 'Restore document' })).toBeVisible();
  await nextBanner.getByRole('button', { name: 'Restore document' }).click();
  await expect(source(page)).toHaveText('# Restored document');
  await expect(page.locator('.status-message')).toContainText('Document restored from backup');
  await expect(nextBanner).toHaveCount(0);
});

test('restores tabs from the recovery offer', async ({ page }) => {
  await page.addInitScript(() => {
    const updatedAt = Date.now();
    localStorage.setItem('notation.pending-recovery', JSON.stringify({
      failedAt: updatedAt,
      session: {
        activeTabId: 'session-tab', updatedAt,
        tabs: [{ id: 'session-tab', name: 'session-backup.md', path: null, content: '# Session backup', savedContent: '# Session backup', savedName: 'session-backup.md', updatedAt }],
      },
    }));
  });
  await page.reload();
  const banner = page.locator('.recovery-banner');
  await expect(banner).toContainText('Restore tabs replaces your current open tabs');
  await expect(banner.getByRole('button', { name: 'Restore document' })).toHaveCount(0);
  await expect(banner.getByRole('button', { name: 'Restore script edits' })).toHaveCount(0);
  await banner.getByRole('button', { name: 'Restore tabs' }).click();
  await expect(page.getByRole('tab', { name: 'session-backup.md', exact: true })).toBeVisible();
  await expect(source(page)).toHaveText('# Session backup');
  await expect(page.locator('.status-message')).toContainText('Tabs restored from backup');
  await expect(banner).toHaveCount(0);
});
