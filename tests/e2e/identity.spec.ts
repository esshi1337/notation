import { expect, test, type Locator, type Page } from '@playwright/test';

function localAssets(page: Page) {
  const requested: string[] = [];
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/identity/') && response.ok()) requested.push(path);
  });
  return requested;
}

async function expectAsset(page: Page, requested: string[], source: string) {
  await expect(page.locator(`svg.identity-icon[data-icon-source="${source}"]`).first()).toBeVisible();
  await expect.poll(() => requested.includes(source), `Loaded exact local asset ${source}`).toBe(true);
}

async function expectCenteredInButton(icon: Locator, width: number, height: number) {
  const geometry = await icon.evaluate(element => {
    const box = element.getBoundingClientRect();
    const image = element.querySelector('image')!.getBoundingClientRect();
    const button = element.parentElement!.getBoundingClientRect();
    return {
      width: box.width, height: box.height,
      imageDelta: Math.max(Math.abs(box.x - image.x), Math.abs(box.y - image.y), Math.abs(box.width - image.width), Math.abs(box.height - image.height)),
      centerDelta: Math.max(Math.abs(box.x + box.width / 2 - button.x - button.width / 2), Math.abs(box.y + box.height / 2 - button.y - button.height / 2)),
    };
  });
  expect(geometry.width).toBeCloseTo(width, 2);
  expect(geometry.height).toBeCloseTo(height, 2);
  expect(geometry.imageDelta).toBeLessThanOrEqual(.05);
  expect(geometry.centerDelta).toBeLessThanOrEqual(.05);
}

test('dark chrome loads exact exports, centers icons, and distinguishes unsaved changes', async ({ page }) => {
  const requested = localAssets(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveCSS('--bg', '#111111');
  for (const source of ['/identity/0-9dfae.svg', '/identity/0-cdc53.svg', '/identity/0-a3bc6.svg', '/identity/0-2cf7a.svg', '/identity/0-9bd4d.svg']) await expectAsset(page, requested, source);
  await expectCenteredInButton(page.getByRole('button', { name: 'App menu', exact: true }).locator('svg'), 18, 15.27);
  await expectCenteredInButton(page.getByRole('button', { name: 'New document', exact: true }).locator('svg'), 18, 18);
  const saved = page.locator('.save-state');
  await expect(saved).toHaveAttribute('data-state', 'saved');
  const check = saved.locator('svg[data-icon="check"]');
  const centered = await check.evaluate(element => {
    const icon = element.getBoundingClientRect(), footer = element.closest('.statusbar')!;
    const status = footer.getBoundingClientRect(), style = getComputedStyle(footer);
    const topBorder = parseFloat(style.borderTopWidth), bottomBorder = parseFloat(style.borderBottomWidth);
    const contentCenter = status.y + topBorder + (status.height - topBorder - bottomBorder) / 2;
    return { width: icon.width, height: icon.height, delta: Math.abs(icon.y + icon.height / 2 - contentCenter) };
  });
  expect(centered).toEqual({ width: 12, height: 12, delta: 0 });
  await page.getByRole('textbox', { name: 'Document source' }).fill('Unsaved identity check');
  await expect(saved).toHaveAttribute('data-state', 'dirty');
  await expect(saved).toHaveText('Unsaved changes');
  await expect(saved.locator('svg')).toHaveCount(0);
  await expect(page.locator('[src*="figma.com"], image[href*="figma.com"]')).toHaveCount(0);
});

test('light chrome switches to the exact light exports and approved tokens', async ({ page }) => {
  const requested = localAssets(page);
  await page.addInitScript(() => localStorage.setItem('notation.settings', JSON.stringify({ theme: 'light' })));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveCSS('--bg', '#faf9f7');
  for (const source of ['/identity/4-7cd9f.svg', '/identity/4-53750.svg', '/identity/4-0e332.svg', '/identity/4-6002f.svg', '/identity/4-7bfac.svg']) await expectAsset(page, requested, source);
  await expect(page.locator('svg.identity-icon[data-icon-theme="dark"]:visible')).toHaveCount(0);
});

test('compact windows contain the chrome and keep document tabs scrollable', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 520 });
  await page.goto('/');
  for (let index = 0; index < 6; index++) await page.getByRole('button', { name: 'New document', exact: true }).click();
  const tabs = page.getByRole('tablist', { name: 'Documents', exact: true });
  await expect(tabs.getByRole('tab')).toHaveCount(7);
  expect(await tabs.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  for (const width of [720, 480, 360]) {
    await page.setViewportSize({ width, height: 520 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'New document', exact: true })).toBeInViewport();
    expect(await page.locator('.workspace-bar').evaluate(element => element.getBoundingClientRect().height)).toBe(44);
    expect(await tabs.evaluate(element => element.getBoundingClientRect().height)).toBe(32);
    expect(await page.locator('.sidebar-tools').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
});

test('app menu keeps arrow, Enter, and Escape keyboard operation', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'App menu', exact: true });
  await trigger.click();
  const menu = page.getByRole('menu', { name: 'App menu', exact: true });
  await expect(menu.locator('svg[data-icon="mark"]')).toHaveCount(1);
  const fresh = menu.getByRole('menuitem', { name: 'New', exact: true });
  const canvas = menu.getByRole('menuitem', { name: 'New canvas', exact: true });
  await expect(fresh).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(canvas).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(fresh).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('tablist', { name: 'Documents' }).getByRole('tab')).toHaveCount(2);
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('keyboard tab closing preserves focus and respects discard cancellation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  const tabs = page.getByRole('tablist', { name: 'Documents', exact: true });
  await page.getByRole('textbox', { name: 'Document source' }).fill('Keep this draft');
  const close = page.locator('.document-tab.active .tab-close');
  await close.focus();
  page.once('dialog', dialog => dialog.dismiss());
  await page.keyboard.press('Enter');
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  await expect(close).toBeFocused();
  page.once('dialog', dialog => dialog.accept());
  await page.keyboard.press('Enter');
  await expect(tabs.getByRole('tab')).toHaveCount(1);
  await expect(tabs.getByRole('tab', { selected: true })).toBeFocused();
});

test('closing Settings restores usable focus after Focus mode removes its opener', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('checkbox', { name: 'Focus mode', exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Search commands' })).toBeFocused();
});

test('settings sections stay contained with native keyboard-accessible checkboxes', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 520 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  const original = await dialog.boundingBox();
  expect(original).not.toBeNull();
  expect(original!.width).toBeLessThanOrEqual(760);
  expect(original!.height).toBeLessThanOrEqual(620);
  for (const section of ['Appearance', 'Editor', 'Shortcuts', 'Agents']) {
    await dialog.getByRole('tab', { name: section, exact: true }).click();
    const box = await dialog.boundingBox();
    expect(Math.abs(box!.x - original!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(box!.y - original!.y)).toBeLessThanOrEqual(1);
    expect(box!.width).toBe(original!.width);
    expect(box!.height).toBe(original!.height);
    expect(await dialog.locator('.settings-content').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await dialog.getByRole('tab', { name: 'Appearance', exact: true }).click();
  const checkbox = dialog.getByRole('checkbox', { name: 'Show status bar', exact: true });
  expect(await checkbox.evaluate(element => element instanceof HTMLInputElement && element.type === 'checkbox')).toBe(true);
  const mark = checkbox.locator('..').locator('.settings-checkbox-mark');
  const geometry = await mark.evaluate(element => {
    const box = element.getBoundingClientRect(), input = element.parentElement!.querySelector('input')!.getBoundingClientRect();
    return { width: box.width, height: box.height, offset: Math.abs(box.y + box.height / 2 - input.y - input.height / 2) };
  });
  expect(geometry).toEqual({ width: 14, height: 14, offset: 0 });
  await checkbox.focus();
  const checked = await checkbox.isChecked();
  await checkbox.press('Space');
  expect(await checkbox.isChecked()).toBe(!checked);
  await expect(mark.locator('svg')).toHaveCSS('visibility', checked ? 'hidden' : 'visible');
  await dialog.getByRole('tab', { name: 'Shortcuts', exact: true }).click();
  const list = dialog.getByRole('region', { name: 'Keyboard shortcuts', exact: true });
  await list.hover();
  await page.mouse.wheel(0, 700);
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(dialog.getByRole('searchbox', { name: 'Search shortcuts' })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Reset shortcuts', exact: true })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeInViewport();
});
