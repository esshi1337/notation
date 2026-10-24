import { expect, test, type Page } from '@playwright/test';
import { openSettings, setSetting, expectSetting } from './commands';

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const closeSettings = (page: Page) => settings(page).getByRole('button', { name: 'Close settings' }).click();
const railWidth = (page: Page) => page.locator('.app-navigation').evaluate(el => el.getBoundingClientRect().width);

test('Sidebar width resizes the icon strip on both sides in both densities with no tool open', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await openSettings(page);
  for (const side of ['left', 'right']) {
    await setSetting(page, 'Sidebar position', side);
    for (const density of ['compact', 'comfortable']) {
      await setSetting(page, 'Density', density);
      for (const [preset, width] of [['Narrow', 40], ['Standard', 44], ['Wide', 60]] as const) {
        await setSetting(page, 'Sidebar width', preset);
        await expect.poll(() => railWidth(page)).toBe(width + (density === 'comfortable' ? 4 : 0));
        expect(await page.locator('.sidebar-button').first().evaluate(el => {
          const button = el.getBoundingClientRect();
          const rail = document.querySelector('.app-navigation')!.getBoundingClientRect();
          return Math.abs((button.left + button.right - rail.left - rail.right) / 2);
        })).toBeLessThan(2);
        await expect(page.locator('.sidebar-panel')).toHaveCount(0);
      }
    }
  }
  await closeSettings(page);
  await page.screenshot({ path: 'test-results/sidebar-rail-wide.png' });
  await page.reload();
  await expect.poll(() => railWidth(page)).toBe(64);
  await openSettings(page);
  await expectSetting(page, 'Sidebar width', 'Wide');
  await setSetting(page, 'Tool panel width', '340');
  await settings(page).getByRole('button', { name: 'Reset appearance', exact: true }).click();
  await expect.poll(() => railWidth(page)).toBe(44);
  await expectSetting(page, 'Sidebar width', 'Standard');
  await expectSetting(page, 'Tool panel width', '260');
  await closeSettings(page); await page.reload(); await openSettings(page);
  await expectSetting(page, 'Sidebar width', 'Standard');
  await expectSetting(page, 'Tool panel width', '260');
});

test('rail and panel sizes are independent and narrow overlays follow the selected rail', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Explorer panel', exact: true }).click();
  for (const side of ['left', 'right']) {
    await openSettings(page);
    await setSetting(page, 'Sidebar position', side);
    await setSetting(page, 'Sidebar width', 'Wide');
    await setSetting(page, 'Tool panel width', '220');
    await closeSettings(page);
    expect(await railWidth(page)).toBe(60);
    expect(await page.locator('.sidebar-panel').evaluate(el => el.getBoundingClientRect().width)).toBe(220);
    await openSettings(page);
    await setSetting(page, 'Tool panel width', '340');
    await closeSettings(page);
    const bounds = await page.evaluate(() => {
      const rail = document.querySelector('.app-navigation')!.getBoundingClientRect();
      const panel = document.querySelector('.sidebar-panel')!.getBoundingClientRect();
      return { rail: { left: rail.left, right: rail.right, width: rail.width }, panel: { left: panel.left, right: panel.right }, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(bounds.rail.width).toBe(60);
    expect(bounds.overflow).toBe(false);
    expect(bounds.panel.left).toBeGreaterThanOrEqual(0);
    expect(bounds.panel.right).toBeLessThanOrEqual(400);
    expect(Math.abs(side === 'left' ? bounds.panel.left - bounds.rail.right : bounds.panel.right - bounds.rail.left)).toBeLessThan(1);
  }
});

test('legacy custom panel widths survive adding an independent icon strip preference', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('notation.settings')) localStorage.setItem('notation.settings', JSON.stringify({ sidebarWidth: 310 }));
  });
  await page.goto('/'); await openSettings(page);
  await expectSetting(page, 'Sidebar width', 'Standard');
  await expect(settings(page).getByRole('combobox', { name: 'Tool panel width', exact: true })).toContainText('310');
  await setSetting(page, 'Sidebar width', 'Wide');
  await closeSettings(page); await page.reload(); await openSettings(page);
  await expectSetting(page, 'Sidebar width', 'Wide');
  await expect(settings(page).getByRole('combobox', { name: 'Tool panel width', exact: true })).toContainText('310');
});
