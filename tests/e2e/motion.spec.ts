import { expect, test, type Page } from '@playwright/test';
import { openSettings } from './commands';

const durations = (page: Page, selector: string) => page.locator(selector).first().evaluate((element) => getComputedStyle(element).transitionDuration.split(',').map((value) => value.trim()));
const token = (page: Page, name: string) => page.evaluate((property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(), name);

test('chrome controls ease their states with the shared motion tokens', async ({ page }) => {
  await page.goto('/');
  expect(await token(page, '--motion-fast')).toBe('120ms');
  expect(await token(page, '--motion-base')).toBe('180ms');
  expect(await token(page, '--motion-slow')).toBe('240ms');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  for (const selector of ['.sidebar-button', '.commands-trigger', '.compact-menu-trigger', '.new-tab-button', '.document-tab > button[role="tab"]']) {
    const values = await durations(page, selector);
    expect(values.length, selector).toBeGreaterThan(0);
    expect(values.every((value) => value === '0.12s'), selector + ' ' + values.join()).toBe(true);
  }
  // The ring animation exists only on the focused state, so it leaves at once.
  const commands = page.getByRole('button', { name: 'Commands', exact: true });
  await expect(commands).toHaveCSS('animation-name', 'none');
  await page.keyboard.press('Tab');
  await commands.focus();
  expect(await commands.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
  await expect(commands).toHaveCSS('animation-name', 'focus-ring-in');
  await expect(commands).toHaveCSS('animation-duration', '0.12s');
  await expect(page.locator('.cm-content').first()).toHaveCSS('animation-name', 'none');
  // Palette selection lands at once; only the released row fades.
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  const options = page.getByRole('dialog', { name: 'Commands', exact: true }).getByRole('option');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await expect(options.first()).toHaveCSS('transition-duration', '0s');
  expect((await options.nth(1).evaluate((element) => getComputedStyle(element).transitionDuration)).startsWith('0.12s')).toBe(true);
  await page.keyboard.press('Escape');
  await expect(commands).toHaveCSS('outline-width', '2px');
});

test('system reduced motion, the Appearance toggle and Performance mode all switch motion off', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  expect(await token(page, '--motion-fast')).toBe('0ms');
  expect((await durations(page, '.sidebar-button')).every((value) => value === '0s')).toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await token(page, '--motion-slow')).toBe('240ms');

  await openSettings(page);
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const toggle = settings.getByRole('checkbox', { name: 'Reduce motion', exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  for (const name of ['--motion-fast', '--motion-base', '--motion-slow']) expect(await token(page, name)).toBe('0ms');
  expect((await durations(page, '.sidebar-button')).every((value) => value === '0s')).toBe(true);
  await settings.getByRole('button', { name: 'Close settings' }).click();

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await openSettings(page);
  await expect(toggle).toBeChecked();
  await settings.getByRole('button', { name: 'Reset appearance', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');

  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  await settings.getByRole('checkbox', { name: 'Performance mode', exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  expect(await token(page, '--motion-base')).toBe('0ms');
});

test('a pointer-opened menu shows no keyboard focus until a key is used', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'App menu', exact: true });
  const menu = page.getByRole('menu', { name: 'App menu', exact: true });
  await trigger.click();
  await expect(menu).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-input', 'pointer');
  await expect(menu.locator(':focus')).toHaveCount(0);

  await page.keyboard.press('ArrowDown');
  await expect(page.locator('html')).toHaveAttribute('data-input', 'keyboard');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // Keyboard activation still lands on the first item, with its ring.
  await page.keyboard.press('Enter');
  const first = menu.getByRole('menuitem').first();
  await expect(first).toBeFocused();
  await expect(first).toHaveCSS('outline-style', 'solid');
  await expect(first).not.toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');
  await page.keyboard.press('Escape');

  // A script-focused control after a click keeps focus but hides its ring.
  await trigger.click();
  await menu.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const tab = page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Appearance', exact: true });
  await expect(tab).toBeFocused();
  // Chromium does not match :focus-visible here, WebKit does. Force the state
  // to prove the ring stays hidden after pointer input.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.settings-sections [data-section="Appearance"]' });
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus-visible'] });
  await expect(tab).toHaveCSS('outline-style', 'solid');
  await expect(tab).toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
  await cdp.detach();
  await page.keyboard.press('ArrowDown');
  const editor = page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Editor', exact: true });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveCSS('outline-width', '2px');
  await expect(editor).not.toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');
});
