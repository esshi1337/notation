import { expect, test } from '@playwright/test';
import { runCommand, setSetting } from './commands';

for (const size of [{ width: 720, height: 520 }, { width: 1266, height: 1357 }]) {
  test(`Settings stays fixed and shortcuts scroll internally at ${size.width}x${size.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await runCommand(page, 'Settings');
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    const original = await dialog.boundingBox();
    expect(original).not.toBeNull();
    expect(original!.height).toBeLessThanOrEqual(620);
    for (const section of ['Shortcuts', 'Agents', 'Editor', 'Appearance', 'Shortcuts']) {
      await dialog.getByRole('tab', { name: section, exact: true }).click();
      const box = await dialog.boundingBox();
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(box![key] - original![key]), `${section} changed ${key}`).toBeLessThanOrEqual(1);
      }
    }
    const close = dialog.getByRole('button', { name: 'Close settings' });
    const closeShape = await close.evaluate(element => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { width: box.width, height: box.height, radius: style.borderRadius, border: style.borderTopWidth };
    });
    expect(closeShape.width).toBe(closeShape.height);
    expect(closeShape.width).toBeGreaterThanOrEqual(24);
    expect(parseFloat(closeShape.radius)).toBeGreaterThan(0);
    expect(parseFloat(closeShape.radius)).toBeLessThan(closeShape.width / 2);
    expect(closeShape.radius).not.toContain('%');
    expect(closeShape.border).toBe('1px');
    const list = dialog.getByRole('region', { name: 'Keyboard shortcuts' });
    const before = await page.evaluate(() => ({ document: document.documentElement.scrollTop, preview: document.querySelector('.preview-scroll')?.scrollTop }));
    await list.hover();
    await page.mouse.wheel(0, 800);
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(dialog.getByRole('searchbox', { name: 'Search shortcuts' })).toBeInViewport();
    await expect(close).toBeInViewport();
    expect(await dialog.boundingBox()).toEqual(original);
    expect(await page.evaluate(() => ({ document: document.documentElement.scrollTop, preview: document.querySelector('.preview-scroll')?.scrollTop }))).toEqual(before);
    await list.focus();
    await page.keyboard.press('End');
    await expect(list.getByRole('button').last()).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('settings-shortcuts.png') });
  });
}

test('smooth scrolling can be disabled and the choice survives a reload', async ({ page }) => {
  await page.goto('/');
  await runCommand(page, 'Settings');
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('tab', { name: 'Editor', exact: true }).click();
  const toggle = dialog.getByRole('checkbox', { name: 'Smooth scrolling', exact: true });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await page.reload();
  await runCommand(page, 'Settings');
  await dialog.getByRole('tab', { name: 'Editor', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Reset editor', exact: true }).click();
  await expect(toggle).toBeChecked();
});


test('Settings checkboxes keep centered square marks and keyboard feedback in both densities', async ({ page }, testInfo) => {
  await page.goto('/');
  await runCommand(page, 'Settings');
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  for (const density of ['compact', 'comfortable']) {
    await dialog.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await setSetting(page, 'Density', density);
    for (const section of ['Appearance', 'Editor', 'Agents']) {
      await dialog.getByRole('tab', { name: section, exact: true }).click();
      const labels = dialog.locator('.settings-checkbox');
      for (const label of await labels.all()) {
        const box = label.locator('input');
        const mark = label.locator('.settings-checkbox-mark');
        const geometry = await label.evaluate(element => {
          const mark = element.querySelector('.settings-checkbox-mark')!.getBoundingClientRect();
          const input = element.querySelector('input')!.getBoundingClientRect();
          return { width: mark.width, height: mark.height, offset: Math.abs(mark.y + mark.height / 2 - input.y - input.height / 2) };
        });
        expect(geometry).toEqual({ width: 14, height: 14, offset: 0 });
        const checked = await box.isChecked();
        await page.keyboard.press('Tab');
        await box.focus();
        await expect(mark).toHaveCSS('outline-style', 'solid');
        await page.keyboard.press('Space');
        expect(await box.isChecked()).toBe(!checked);
        await expect(mark.locator('svg')).toHaveCSS('visibility', checked ? 'hidden' : 'visible');
        await page.keyboard.press('Space');
      }
      await dialog.screenshot({ path: testInfo.outputPath(`checkboxes-${density}-${section}.png`) });
    }
  }
});

test('small wheel steps animate in the real split editor, preview, and Live Preview', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Document source' }).fill(Array.from({ length: 100 }, (_, i) => `Paragraph ${i + 1}: mouse wheel scrolling.\n`).join('\n'));
  for (const mode of ['Split', 'Live Preview']) {
    await runCommand(page, mode);
    const regions = mode === 'Split' ? ['.cm-scroller', '.preview-scroll'] : ['.cm-scroller'];
    for (const selector of regions) {
      const region = page.locator(selector);
      await expect.poll(() => region.evaluate(e => e.scrollHeight - e.clientHeight)).toBeGreaterThan(100);
      const first = await region.evaluate(element => {
        element.scrollTop = 0;
        const wheel = new WheelEvent('wheel', { deltaY: 15.8, bubbles: true, cancelable: true });
        (element.querySelector('.cm-content, p') ?? element).dispatchEvent(wheel);
        return { consumed: wheel.defaultPrevented, initial: element.scrollTop };
      });
      expect(first).toEqual({ consumed: true, initial: 0 });
      await expect.poll(() => region.evaluate(e => Math.abs(e.scrollTop - 15.8))).toBeLessThanOrEqual(1);
      await page.waitForTimeout(200);
    }
  }
});
