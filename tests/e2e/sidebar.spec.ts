import { expect, test, type Page } from '@playwright/test';
import { enableScripts, openSettings, runCommand, setSetting, expectSetting } from './commands';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'App sidebar' });
const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
async function position(page: Page, side: 'left' | 'right') {
  await openSettings(page);
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await setSetting(page, 'Sidebar position', side);
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.locator('.content-area')).toHaveAttribute('data-sidebar-position', side);
}
async function checkGeometry(page: Page, side: 'left' | 'right', overlay = false) {
  const result = await page.evaluate(() => {
    const rect = (selector: string) => { const r = document.querySelector(selector)!.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
    return { rail: rect('.app-navigation'), panel: rect('.sidebar-panel'), editor: rect('.content-area > .workspace'), width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
  });
  expect(result.scrollWidth).toBeLessThanOrEqual(result.width);
  expect(result.panel.left).toBeGreaterThanOrEqual(0);
  expect(result.panel.right).toBeLessThanOrEqual(result.width);
  if (side === 'left') {
    expect(result.rail.left).toBe(0);
    expect(Math.abs(result.rail.right - result.panel.left)).toBeLessThan(2);
    if (!overlay) expect(Math.abs(result.panel.right - result.editor.left)).toBeLessThan(2);
  } else {
    expect(result.rail.right).toBe(result.width);
    expect(Math.abs(result.rail.left - result.panel.right)).toBeLessThan(2);
    if (!overlay) expect(Math.abs(result.panel.left - result.editor.right)).toBeLessThan(2);
  }
  expect(result.editor.width).toBeGreaterThan(160);
}

test('sidebar moves the active tool with it, preserves edits and undo, and persists its setting', async ({ page }) => {
  await page.goto('/');
  await runCommand(page, 'Source');
  await source(page).fill('Original text');
  await source(page).press('Control+End');
  await page.keyboard.type(' appended');
  await sidebar(page).getByRole('button', { name: 'Workspace panel', exact: true }).click();
  await expect(sidebar(page).getByRole('button', { name: 'Workspace panel' })).toHaveAttribute('aria-pressed', 'true');
  await checkGeometry(page, 'left');
  await page.getByRole('textbox', { name: 'Workspace name', exact: true }).fill('Unsubmitted workspace');
  await position(page, 'right');
  await checkGeometry(page, 'right');
  await expect(page.getByRole('textbox', { name: 'Workspace name', exact: true })).toHaveValue('Unsubmitted workspace');
  await expect(source(page)).toHaveText('Original text appended');
  await source(page).focus(); await page.keyboard.press('Control+z');
  await expect(source(page)).toHaveText('Original text');
  await page.screenshot({ path: 'test-results/sidebar-right.png' });
  await page.reload();
  await expect(page.locator('.content-area')).toHaveAttribute('data-sidebar-position', 'right');
  await expect(source(page)).toHaveText('Original text');
  await sidebar(page).getByRole('button', { name: 'Explorer panel', exact: true }).click();
  await checkGeometry(page, 'right');
  await position(page, 'left');
  await checkGeometry(page, 'left');
  await page.screenshot({ path: 'test-results/sidebar-left.png' });
});

test('sidebar supports keyboard navigation, panel toggling and Focus mode', async ({ page }) => {
  await page.goto('/');
  await enableScripts(page);
  const explorer = sidebar(page).getByRole('button', { name: 'Explorer panel', exact: true });
  const workspace = sidebar(page).getByRole('button', { name: 'Workspace panel', exact: true });
  await explorer.focus(); await page.keyboard.press('ArrowDown');
  await expect(workspace).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Workspace', exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Workspace', exact: true })).toHaveCount(0);
  await page.keyboard.press('End');
  await expect(sidebar(page).getByRole('button', { name: 'Scripts panel' })).toBeFocused();
  await page.keyboard.press('Home'); await expect(explorer).toBeFocused();
  await page.keyboard.press('Enter');
  await runCommand(page, 'Focus mode');
  await expect(sidebar(page)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Explorer', exact: true })).toHaveCount(0);
  await page.keyboard.press('Control+Shift+f');
  await expect(sidebar(page)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Explorer', exact: true })).toBeVisible();
});

test('narrow windows keep tools reachable on either side and appearance reset restores left', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 420 });
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Workspace panel', exact: true }).click();
  await checkGeometry(page, 'left', true);
  await position(page, 'right');
  await checkGeometry(page, 'right', true);
  await openSettings(page);
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  await settings.getByRole('button', { name: 'Reset editor', exact: true }).click();
  await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await expectSetting(page, 'Sidebar position', 'right');
  await settings.getByRole('button', { name: 'Reset appearance', exact: true }).click();
  await expectSetting(page, 'Sidebar position', 'left');
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await checkGeometry(page, 'left', true);
  await page.screenshot({ path: 'test-results/sidebar-narrow.png' });
});
