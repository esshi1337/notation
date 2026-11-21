import { expect, test, type Page } from '@playwright/test';
import { enableScripts, openSettings, runCommand, setSetting, expectSetting, settled } from './commands';

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
  // The panel slides in; measure the settled frame.
  await settled(page.locator('.sidebar-panel'));
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
  await source(page).press('ControlOrMeta+End');
  await page.keyboard.type(' appended');
  await sidebar(page).getByRole('button', { name: 'Workspace panel', exact: true }).click();
  await expect(sidebar(page).getByRole('button', { name: 'Workspace panel' })).toHaveAttribute('aria-pressed', 'true');
  await checkGeometry(page, 'left');
  await page.getByRole('textbox', { name: 'Workspace name', exact: true }).fill('Unsubmitted workspace');
  await position(page, 'right');
  await checkGeometry(page, 'right');
  await expect(page.getByRole('textbox', { name: 'Workspace name', exact: true })).toHaveValue('Unsubmitted workspace');
  await expect(source(page)).toHaveText('Original text appended');
  await source(page).focus(); await page.keyboard.press('ControlOrMeta+z');
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
  await page.keyboard.press('ControlOrMeta+Shift+f');
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

test('overlay scrollbar thumbs hide beneath an open header menu and modal dialogs', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 420 });
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Templates panel', exact: true }).click();
  const panel = page.locator('.sidebar-panel .utility-panel');
  await expect(panel).toBeVisible();
  const color = (selector: string) => page.locator(selector).first().evaluate((element) => getComputedStyle(element).scrollbarColor);
  const hidden = 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)';
  const underneath = ['.sidebar-panel .utility-panel', '.cm-scroller', '.sidebar-tools'];

  // Chromium here has classic scrollbars, which already paint beneath overlays.
  await expect(page.locator('html')).toHaveAttribute('data-scrollbars', /^(classic|overlay)$/);
  const appMenu = page.getByRole('button', { name: 'App menu', exact: true });
  const menu = page.getByRole('menu', { name: 'App menu', exact: true });
  if (await page.locator('html').getAttribute('data-scrollbars') === 'classic') {
    await appMenu.click();
    await expect(menu).toBeVisible();
    for (const selector of underneath) expect(await color(selector), selector).not.toBe(hidden);
    await page.keyboard.press('Escape');
  }

  // WebKitGTK and WKWebView composite overlay thumbs above every surface.
  await page.evaluate(() => { document.documentElement.dataset.scrollbars = 'overlay'; });
  // Hover and focus change the thumb shade, so compare against hidden only.
  const restored = async () => { for (const selector of underneath) expect(await color(selector), 'restored ' + selector).not.toBe(hidden); };
  await restored();
  for (const name of ['App menu', 'Layout']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('menu', { name, exact: true })).toBeVisible();
    for (const selector of underneath) expect(await color(selector), name + ' ' + selector).toBe(hidden);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name, exact: true })).toHaveCount(0);
    await restored();
  }

  await appMenu.click();
  await menu.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  for (const selector of underneath) expect(await color(selector), 'settings ' + selector).toBe(hidden);
  // Scrollers inside the dialog keep their thumbs and still scroll.
  expect(await color('.settings-dialog .settings-content')).not.toBe(hidden);
  await settings.locator('.settings-content').hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => settings.locator('.settings-content').evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await expect(settings).toHaveCount(0);
  await restored();

  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Commands', exact: true })).toBeVisible();
  for (const selector of underneath) expect(await color(selector), 'palette ' + selector).toBe(hidden);
  expect(await color('.command-palette .command-results')).not.toBe(hidden);
  await page.keyboard.press('Escape');
  await restored();

  // The sidebar still scrolls once the overlay is gone.
  const before = await panel.evaluate((element) => element.scrollTop);
  await panel.hover();
  await page.mouse.wheel(0, 240);
  await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
});
