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

async function setToolPanelWidth(page: Page, width: '220' | '260' | '340') {
  await openSettings(page);
  await setSetting(page, 'Tool panel width', width);
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.locator('main.app')).toHaveCSS('--sidebar-width', `${width}px`);
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

for (const viewportWidth of [480, 1280] as const) {
  test(`app menu covers an overflowing sidebar scrollbar edge at ${viewportWidth}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewportWidth, height: 420 });
    await page.goto('/');
    await setToolPanelWidth(page, '220');
    await sidebar(page).getByRole('button', { name: 'Templates panel', exact: true }).click();
    const templates = page.getByRole('region', { name: 'Templates', exact: true });
    await expect(templates).toBeVisible();

    const panel = page.locator('.sidebar-panel .utility-panel');
    const overflow = await panel.evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight }));
    expect(overflow.scroll).toBeGreaterThan(overflow.client + 40);

    const appMenu = page.getByRole('button', { name: 'App menu', exact: true });
    const menu = page.getByRole('menu', { name: 'App menu', exact: true });
    await appMenu.click();
    await expect(menu).toBeVisible();

    const edge = await page.evaluate(() => {
      const utility = document.querySelector<HTMLElement>('.sidebar-panel .utility-panel')!;
      const openMenu = document.querySelector<HTMLElement>('.compact-menu')!;
      const utilityRect = utility.getBoundingClientRect();
      const menuRect = openMenu.getBoundingClientRect();
      const x = utilityRect.right - 5;
      const y = utilityRect.top + Math.min(80, utilityRect.height / 2);
      return {
        x, y,
        menu: { left: menuRect.left, right: menuRect.right, top: menuRect.top, bottom: menuRect.bottom },
        covered: document.elementFromPoint(x, y)?.closest('.compact-menu') === openMenu,
      };
    });
    expect(edge.menu.left).toBeLessThan(edge.x);
    expect(edge.menu.right).toBeGreaterThan(edge.x);
    expect(edge.menu.top).toBeLessThan(edge.y);
    expect(edge.menu.bottom).toBeGreaterThan(edge.y);
    expect(edge.covered).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`sidebar-menu-over-scrollbar-${viewportWidth}.png`) });

    await menu.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await appMenu.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    const before = await panel.evaluate(element => element.scrollTop);
    await page.mouse.move(edge.x, edge.y);
    await page.mouse.wheel(0, 240);
    await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(before);
    await page.screenshot({ path: testInfo.outputPath(`sidebar-scroll-after-dismiss-${viewportWidth}.png`) });
  });
}
