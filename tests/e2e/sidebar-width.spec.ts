import { expect, test, type Page } from '@playwright/test';
import { expectSetting, openSettings, setSetting, settled } from './commands';

const presets = [220, 260, 340] as const;
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'App sidebar' });
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });

type Side = 'left' | 'right';
type Tool = 'Note graph' | 'Explorer';

async function openTool(page: Page, tool: Tool) {
  const region = page.getByRole('region', { name: tool, exact: true });
  if (!(await region.isVisible().catch(() => false))) {
    await sidebar(page).getByRole('button', { name: `${tool} panel`, exact: true }).click();
  }
  await expect(region).toBeVisible();
}

async function setAppearance(page: Page, side: Side, width: number) {
  await openSettings(page);
  await setSetting(page, 'Sidebar position', side);
  await setSetting(page, 'Tool panel width', String(width));
  await expect(page.locator('main.app')).toHaveCSS('--sidebar-width', `${width}px`);
  await settings(page).getByRole('button', { name: 'Close settings' }).click();
  await expect(page.locator('.content-area')).toHaveAttribute('data-sidebar-position', side);
}

async function expectPanelGeometry(page: Page, tool: Tool, side: Side, width: number, overlay = false) {
  // The panel slides in; measure the settled frame.
  await settled(page.locator('.sidebar-panel'));
  const result = await page.evaluate((toolName) => {
    const rect = (selector: string) => {
      const bounds = document.querySelector(selector)!.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, width: bounds.width };
    };
    return {
      panel: rect('.sidebar-panel'),
      tool: rect(toolName === 'Note graph' ? '.graph-panel' : '.explorer-panel'),
      rail: rect('.app-navigation'),
      editor: rect('.content-area > .workspace'),
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  }, tool);

  const expectedWidth = overlay ? Math.min(width, result.viewport - result.rail.width) : width;
  expect(result.panel.width).toBeCloseTo(expectedWidth, 0);
  expect(result.tool.width).toBeGreaterThan(0);
  expect(result.tool.left).toBeGreaterThanOrEqual(result.panel.left - 1);
  expect(result.tool.right).toBeLessThanOrEqual(result.panel.right + 1);
  expect(result.panel.left).toBeGreaterThanOrEqual(0);
  expect(result.panel.right).toBeLessThanOrEqual(result.viewport);
  expect(result.scrollWidth).toBeLessThanOrEqual(result.viewport);

  if (side === 'left') {
    expect(result.rail.left).toBe(0);
    expect(Math.abs(result.rail.right - result.panel.left)).toBeLessThan(1);
    if (!overlay) expect(Math.abs(result.panel.right - result.editor.left)).toBeLessThan(1);
  } else {
    expect(result.rail.right).toBe(result.viewport);
    expect(Math.abs(result.rail.left - result.panel.right)).toBeLessThan(1);
    if (!overlay) expect(Math.abs(result.panel.left - result.editor.right)).toBeLessThan(1);
  }
  if (!overlay) expect(result.editor.width).toBeGreaterThan(160);
}

for (const side of ['left', 'right'] as const) {
  test(`Note graph and Explorer honor width presets on the ${side} and persist after reload`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    for (const width of presets) {
      await setAppearance(page, side, width);
      await openTool(page, 'Note graph');
      await expectPanelGeometry(page, 'Note graph', side, width);
      await openTool(page, 'Explorer');
      await expectPanelGeometry(page, 'Explorer', side, width);
    }

    await openTool(page, 'Note graph');
    await page.reload();
    await expect(page.locator('.content-area')).toHaveAttribute('data-sidebar-position', side);
    await openTool(page, 'Note graph');
    await expectPanelGeometry(page, 'Note graph', side, 340);
    await openSettings(page);
    await expectSetting(page, 'Sidebar position', side);
    await expectSetting(page, 'Tool panel width', '340');
  });
}

test('Note graph and Explorer remain contained and honor width presets in narrow windows', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 640 });
  await page.goto('/');

  for (const side of ['left', 'right'] as const) {
    for (const width of [220, 340] as const) {
      await setAppearance(page, side, width);
      await openTool(page, 'Note graph');
      await expectPanelGeometry(page, 'Note graph', side, width, true);
      await openTool(page, 'Explorer');
      await expectPanelGeometry(page, 'Explorer', side, width, true);
    }
  }
});
