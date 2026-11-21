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

test('menus animate in and out faster, and a leaving menu cannot be used', async ({ page }) => {
  await page.goto('/');
  // Record menu animations as they start and slow the exit, so the leaving
  // state can be observed however busy the machine is.
  await page.evaluate(() => {
    const original = Element.prototype.animate;
    const state = window as unknown as { menuDurations: number[] };
    state.menuDurations = [];
    Element.prototype.animate = function (keyframes, options) {
      const animation = original.call(this, keyframes, options);
      const duration = Number((options as KeyframeAnimationOptions).duration);
      // Svelte first pins the starting frame with a zero-length animation.
      if (duration > 0 && this instanceof HTMLElement && this.classList.contains('compact-menu')) {
        state.menuDurations.push(duration);
        if (state.menuDurations.length === 2) animation.playbackRate = 0.1;
      }
      return animation;
    };
  });
  const durations = () => page.evaluate(() => (window as unknown as { menuDurations: number[] }).menuDurations);
  const trigger = page.getByRole('button', { name: 'App menu', exact: true });
  const menu = page.locator('.compact-menu');
  await trigger.click();
  await expect(menu).toBeVisible();
  expect(await durations()).toEqual([180]);
  await menu.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await expect(menu).toHaveCSS('opacity', '1');

  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(menu).toHaveCount(1);
  expect(await menu.evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  const [enter, exit] = await durations();
  expect(enter).toBe(180);
  expect(exit).toBeCloseTo(126, 3);
  // The document underneath is usable while the menu fades.
  await page.locator('.cm-content').first().click();
  await expect(page.locator('.cm-content').first()).toBeFocused();
  await expect(menu).toHaveCount(0);
});

test('dialogs ease in, close without delaying focus and fade only their dim', async ({ page }) => {
  await page.goto('/');
  const commands = page.getByRole('button', { name: 'Commands', exact: true });
  await commands.click();
  const palette = page.getByRole('dialog', { name: 'Commands', exact: true });
  await expect(palette).toHaveCSS('animation-name', 'palette-in');
  await expect(palette).toHaveCSS('animation-duration', '0.18s');
  // Typing works during the entrance.
  await page.keyboard.type('settings');
  await expect(palette.getByRole('textbox', { name: 'Search commands' })).toHaveValue('settings');
  await palette.getByRole('option', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toHaveCSS('animation-name', 'dialog-in');
  await expect(settings).toHaveCSS('animation-duration', '0.24s');
  await expect(settings.getByRole('tab', { name: 'Appearance', exact: true })).toBeFocused();
  await settings.evaluate((dialog) => Promise.all(dialog.getAnimations().map((animation) => animation.finished)));
  await expect(settings).toHaveCSS('opacity', '1');
  expect(await settings.evaluate((dialog) => getComputedStyle(dialog).transform)).toBe('none');

  // Count section fades as they start; the 120 ms animation may already be over when read back.
  await page.evaluate(() => {
    const original = Element.prototype.animate;
    const state = window as unknown as { sectionFades: number[] };
    state.sectionFades = [];
    Element.prototype.animate = function (keyframes, options) {
      if (this instanceof HTMLElement && this.classList.contains('settings-content')) state.sectionFades.push(Number((options as KeyframeAnimationOptions).duration));
      return original.call(this, keyframes, options);
    };
  });
  await settings.getByRole('tab', { name: 'Shortcuts', exact: true }).click();
  await expect(settings.getByRole('searchbox', { name: 'Search shortcuts' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { sectionFades: number[] }).sectionFades)).toEqual([120]);

  const focusAtClose = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>('dialog.settings-dialog')!;
    dialog.querySelector<HTMLButtonElement>('.settings-close')!.click();
    return new Promise<{ open: number; scrims: number; pointerEvents: string }>((resolve) => queueMicrotask(() => {
      const scrim = document.querySelector('.modal-scrim-exit');
      resolve({ open: document.querySelectorAll('dialog[open]').length, scrims: document.querySelectorAll('.modal-scrim-exit').length, pointerEvents: scrim ? getComputedStyle(scrim).pointerEvents : '' });
    }));
  });
  expect(focusAtClose).toEqual({ open: 0, scrims: 1, pointerEvents: 'none' });
  await expect(page.locator('.modal-scrim-exit')).toHaveCount(0);

  // Reduced motion: nothing animates and no dim element is created.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await commands.click();
  await expect(palette).toBeVisible();
  await expect(palette).toHaveCSS('animation-duration', '0s');
  const scrims = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('.palette-close')!.click();
    return new Promise<number>((resolve) => queueMicrotask(() => resolve(document.querySelectorAll('.modal-scrim-exit').length)));
  });
  expect(scrims).toBe(0);
  await expect(palette).toHaveCount(0);
  await page.getByRole('button', { name: 'App menu', exact: true }).click();
  await expect(page.locator('.compact-menu')).toBeVisible();
  expect(await page.locator('.compact-menu').evaluate((element) => element.getAnimations().length)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.compact-menu')).toHaveCount(0);
});

test('sidebar panels slide from the rail side, leave the layout at once and get a scrim when narrow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  // Record panel animations as they start and slow exits so they can be observed.
  await page.evaluate(() => {
    const original = Element.prototype.animate;
    const state = window as unknown as { panelAnimations: { duration: number; from: string }[] };
    state.panelAnimations = [];
    Element.prototype.animate = function (keyframes, options) {
      const animation = original.call(this, keyframes, options);
      const duration = Number((options as KeyframeAnimationOptions).duration);
      if (duration > 0 && this instanceof HTMLElement && this.classList.contains('sidebar-panel')) {
        const frames = keyframes as Keyframe[];
        state.panelAnimations.push({ duration, from: String(frames[0].transform ?? frames[0].opacity) });
        if (this.classList.contains('leaving')) animation.playbackRate = 0.1;
      }
      return animation;
    };
  });
  const animations = () => page.evaluate(() => (window as unknown as { panelAnimations: { duration: number; from: string }[] }).panelAnimations);
  const rail = page.getByRole('navigation', { name: 'App sidebar' });
  const panel = page.locator('.sidebar-panel');
  const scrim = page.locator('.sidebar-scrim');
  const workspaceWidth = () => page.locator('.content-area > .workspace').evaluate((element) => element.getBoundingClientRect().width);

  const closedWidth = await workspaceWidth();
  await rail.getByRole('button', { name: 'Templates panel', exact: true }).click();
  await expect(panel).toBeVisible();
  let recorded = await animations();
  expect(recorded).toHaveLength(1);
  expect(recorded[0].duration).toBe(240);
  expect(recorded[0].from).toContain('translate(-16px');
  await panel.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await expect(scrim).toBeHidden();
  const openWidth = await workspaceWidth();
  expect(openWidth).toBeLessThan(closedWidth - 200);

  // Switching panels fades the incoming content, not the panel.
  await rail.getByRole('button', { name: 'Table editor panel', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Table editor', exact: true })).toBeVisible();
  expect(await animations()).toHaveLength(1);

  await rail.getByRole('button', { name: 'Table editor panel', exact: true }).click();
  await expect(panel).toHaveClass(/leaving/);
  expect(await panel.evaluate((element) => ({ inert: (element as HTMLElement).inert, position: getComputedStyle(element).position, hasContent: element.childElementCount > 0 }))).toEqual({ inert: true, position: 'absolute', hasContent: true });
  // The editor already has its full width while the panel fades over it.
  expect(await workspaceWidth()).toBe(closedWidth);
  recorded = await animations();
  expect(recorded).toHaveLength(2);
  expect(recorded[1].duration).toBeCloseTo(168, 3);
  await expect(panel).toHaveCount(0);

  // Right-hand sidebar slides from the right.
  await page.evaluate(() => { (window as unknown as { panelAnimations: unknown[] }).panelAnimations.length = 0; });
  await openSettings(page);
  await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('radiogroup', { name: 'Sidebar position', exact: true }).getByRole('radio', { name: 'Right', exact: true }).click();
  await page.keyboard.press('Escape');
  await rail.getByRole('button', { name: 'Templates panel', exact: true }).click();
  await expect(panel).toBeVisible();
  await expect.poll(async () => (await animations())[0]?.from ?? '').toContain('translate(16px');
  await panel.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));

  // Narrow window: drawer with a scrim; the rail stays usable and the scrim closes.
  await page.setViewportSize({ width: 720, height: 480 });
  await expect(scrim).toBeVisible();
  expect(await scrim.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0.55)');
  const box = (await page.locator('.content-area > .workspace').boundingBox())!;
  const covered = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className, [box.x + 40, box.y + 200]);
  expect(covered).toContain('sidebar-scrim');
  await rail.getByRole('button', { name: 'Explorer panel', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Explorer', exact: true })).toBeVisible();
  await page.mouse.click(box.x + 40, box.y + 200);
  await expect(panel).toHaveCount(0);
  await expect(scrim).toHaveCount(0);
  // The click only dismissed the drawer; the next one reaches the editor.
  await page.locator('.cm-content').first().click();
  await expect(page.locator('.cm-content').first()).toBeFocused();
});
