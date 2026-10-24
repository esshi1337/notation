import { expect, test } from '@playwright/test';
import { openSettings, setSetting, expectSetting } from './commands';

const dialog = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: 'Settings', exact: true });

test('segmented theme and density are keyboard accessible and visibly affect chrome', async ({ page }) => {
  await page.goto('/'); await openSettings(page);
  const settings = dialog(page);
  const preset = settings.getByRole('combobox', { name: 'Dark preset', exact: true });
  await setSetting(page, 'Dark preset', 'charcoal');
  const dark = settings.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: 'Dark', exact: true });
  await dark.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(preset).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await expectSetting(page, 'Dark preset', 'charcoal');
  const before = await page.locator('.workspace-bar').boundingBox();
  const controlBefore = await settings.getByRole('combobox', { name: 'Tool panel width' }).boundingBox();
  await setSetting(page, 'Density', 'comfortable');
  await expect.poll(async () => (await page.locator('.workspace-bar').boundingBox())!.height).toBeGreaterThan(before!.height);
  await expect.poll(async () => (await settings.getByRole('combobox', { name: 'Tool panel width' }).boundingBox())!.height).toBeGreaterThan(controlBefore!.height);
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await page.reload(); await openSettings(page);
  await expectSetting(page, 'Density', 'comfortable');
});

test('custom dropdown supports keyboard commit, escape, outside click and narrow containment', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 480 });
  await page.goto('/'); await openSettings(page);
  const settings = dialog(page);
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  const font = settings.getByRole('combobox', { name: 'Editor font', exact: true });
  await font.focus(); await page.keyboard.press('Enter');
  await expect(font).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await expectSetting(page, 'Editor font', 'sans');
  await expect(font).toBeFocused();
  await font.click(); await page.keyboard.press('Escape');
  await expect(settings).toBeVisible();
  await expect(font).toHaveAttribute('aria-expanded', 'false');
  await font.click();
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  await expect(font).toHaveAttribute('aria-expanded', 'false');
  const layout = settings.getByRole('combobox', { name: 'Layout', exact: true });
  await layout.click();
  const list = settings.getByRole('listbox');
  await expect(list).toBeVisible();
  const box = await list.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(561); expect(box!.y + box!.height).toBeLessThanOrEqual(481);
  await page.keyboard.press('Tab');
  await expect(layout).toHaveAttribute('aria-expanded', 'false');
  expect(await settings.evaluate(e => e.contains(document.activeElement))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await setSetting(page, 'Layout', 'preview');
  await layout.focus();
  await page.keyboard.type('ss'); await page.keyboard.press('Enter');
  await expectSetting(page, 'Layout', 'split');
  await layout.focus();
  await page.keyboard.type('sou'); await page.keyboard.press('Enter');
  await expectSetting(page, 'Layout', 'source');
});

test('width presets preserve an existing custom width until explicitly changed', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('notation.settings', JSON.stringify({ sidebarWidth: 310 })));
  await page.goto('/'); await openSettings(page);
  await expect(dialog(page).getByRole('combobox', { name: 'Tool panel width' })).toContainText('310');
  await setSetting(page, 'Theme', 'light');
  await dialog(page).getByRole('button', { name: 'Close settings' }).click();
  await page.reload(); await openSettings(page);
  await expect(dialog(page).getByRole('combobox', { name: 'Tool panel width' })).toContainText('310');
  await setSetting(page, 'Tool panel width', '340');
  await expect(page.locator('main.app')).toHaveCSS('--sidebar-width', '340px');
});

test('numeric settings retain typed values and enforce bounds with custom steppers', async ({ page }) => {
  await page.goto('/'); await openSettings(page);
  const settings = dialog(page);
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  const size = settings.getByRole('spinbutton', { name: 'Font size', exact: true });
  await size.fill('24'); await size.press('Tab');
  await expect(settings.getByRole('button', { name: 'Increase Font size', exact: true })).toBeDisabled();
  await settings.getByRole('button', { name: 'Decrease Font size', exact: true }).click();
  await expect(size).toHaveValue('23');
  const slider = settings.getByRole('slider', { name: 'Font size slider', exact: true });
  await slider.focus(); await slider.press('Home'); await slider.press('ArrowRight');
  await expect(size).toHaveValue('11');
  await size.fill('100'); await size.press('Tab'); await expect(size).toHaveValue('24');
  const height = settings.getByRole('spinbutton', { name: 'Line height', exact: true });
  await height.fill('1.3'); await height.press('Tab');
  await settings.getByRole('button', { name: 'Increase Line height', exact: true }).click();
  await expect(height).toHaveValue('1.4');
  const width = settings.getByRole('spinbutton', { name: 'Reading width', exact: true });
  await width.fill('756'); await width.press('Tab'); await expect(width).toHaveValue('756');
  await width.fill(''); await width.press('Tab');
  expect(Number(await width.inputValue())).toBeGreaterThanOrEqual(480);
  await expect(settings.locator('select')).toHaveCount(0);
});

test('editor specimen responds to typography, width and layout without mounting extra editors', async ({ page }) => {
  await page.goto('/'); await openSettings(page);
  const settings = dialog(page);
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  const preview = settings.getByRole('region', { name: 'Editor preview' });
  const editors = await page.locator('.cm-editor').count();
  await setSetting(page, 'Editor font', 'sans');
  await settings.getByRole('spinbutton', { name: 'Font size', exact: true }).fill('20');
  await settings.getByRole('spinbutton', { name: 'Line height', exact: true }).fill('2');
  await settings.getByRole('spinbutton', { name: 'Reading width', exact: true }).fill('600');
  await expect(preview).toBeInViewport();
  await expect(preview).toContainText('20 px'); await expect(preview).toContainText('600 px');
  const text = preview.locator('.settings-specimen-text').first();
  await expect(text).toHaveCSS('font-size', '20px'); await expect(text).toHaveCSS('line-height', '40px');
  expect(await text.evaluate(e => getComputedStyle(e).fontFamily)).toContain('Source Sans 3');
  await setSetting(page, 'Layout', 'preview');
  await expect(preview.locator('.settings-specimen-editor')).toHaveCount(0);
  await expect(preview.locator('.settings-specimen-reading')).toBeVisible();
  expect(await page.locator('.cm-editor').count()).toBe(editors);
});

test('editor controls use optional smooth scrolling without moving the pinned specimen', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('/'); await openSettings(page);
  const settings = dialog(page);
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  const controls = settings.locator('.settings-editor-controls');
  const preview = settings.getByRole('region', { name: 'Editor preview' });
  const before = await preview.boundingBox();
  const consumed = await controls.evaluate(element => {
    const event = new WheelEvent('wheel', { deltaY: 80, bubbles: true, cancelable: true });
    element.dispatchEvent(event); return event.defaultPrevented;
  });
  expect(consumed).toBe(true);
  await expect.poll(() => controls.evaluate(e => e.scrollTop)).toBeGreaterThan(0);
  expect((await preview.boundingBox())!.y).toBe(before!.y);
  await settings.getByRole('checkbox', { name: 'Smooth scrolling' }).uncheck();
  expect(await controls.evaluate(element => {
    const event = new WheelEvent('wheel', { deltaY: 80, bubbles: true, cancelable: true });
    element.dispatchEvent(event); return event.defaultPrevented;
  })).toBe(false);
});

for (const theme of ['dark', 'light']) {
  test(`${theme} settings controls remain contained with themed scrolling`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/'); await openSettings(page);
    const settings = dialog(page);
    await setSetting(page, 'Theme', theme);
    for (const section of ['Appearance', 'Editor', 'Agents', 'Shortcuts']) {
      await settings.getByRole('tab', { name: section, exact: true }).click();
      await expect(settings.getByRole('button', { name: 'Close settings' })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await settings.screenshot({ path: testInfo.outputPath(`${theme}-${section}.png`) });
    }
    const list = settings.getByRole('region', { name: 'Keyboard shortcuts' });
    const colors = await list.evaluate(e => ({ color: getComputedStyle(e).scrollbarColor, width: getComputedStyle(e).scrollbarWidth }));
    expect(colors.color).not.toBe('auto'); expect(colors.width).toBe('thin');
    await list.hover(); await page.mouse.wheel(0, 700);
    await expect.poll(() => list.evaluate(e => e.scrollTop)).toBeGreaterThan(0);
  });
}

test('Agents explains unavailable desktop connection without implying edits are authorized by status', async ({ page }) => {
  await page.goto('/'); await openSettings(page);
  const settings = dialog(page);
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText('MCP unavailable');
  await expect(settings.getByRole('status')).toContainText('desktop app');
  await expect(settings.getByRole('button', { name: 'Refresh MCP status' })).toBeDisabled();
  const permission = settings.getByRole('checkbox', { name: 'Agent edits enabled' });
  await permission.uncheck(); await expect(permission).not.toBeChecked();
  await expect(settings.getByRole('status')).toContainText('MCP unavailable');
  await expect(settings.getByRole('textbox', { name: 'MCP command' })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Copy MCP command' })).toHaveCount(0);
});
