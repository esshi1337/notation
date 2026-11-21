import { expect, test, type Page } from '@playwright/test';
import { setSetting } from './commands';

const documents = (page: Page) => page.getByRole('tablist', { name: 'Documents', exact: true });

declare global {
  interface Window { emitTauri?: (event: string, payload: unknown) => number }
}

/** Load the app as the desktop main window on the given platform, with an event bus. */
async function openDesktop(page: Page, platform: 'MacIntel' | 'Linux x86_64') {
  await page.addInitScript((value) => {
    Object.defineProperty(navigator, 'platform', { get: () => value });
    const callbacks = new Map<number, (message: unknown) => void>();
    const listeners = new Map<string, number[]>();
    let next = 1;
    Object.assign(window, {
      menuShortcuts: [],
      presented: [],
      isTauri: true,
      emitTauri(event: string, payload: unknown) {
        const handlers = listeners.get(event) ?? [];
        for (const id of handlers) callbacks.get(id)?.({ event, id, payload });
        return handlers.length;
      },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback(callback: (message: unknown) => void) { const id = next++; callbacks.set(id, callback); return id; },
        unregisterCallback(id: number) { callbacks.delete(id); },
        convertFileSrc: (path: string) => path,
        async invoke(cmd: string, args: Record<string, unknown> = {}) {
          if (cmd === 'bootstrap_state') return { settings: {}, draft: null, scriptDraft: null, scripts: [], recents: [], workspace: null, workspaceCatalog: { activeId: null, workspaces: [] }, session: null };
          if (cmd === 'plugin:event|listen') { const event = String(args.event); listeners.set(event, [...(listeners.get(event) ?? []), Number(args.handler)]); return Number(args.handler); }
          if (cmd === 'present_main_window') { (window as unknown as { presented: unknown[] }).presented.push({ background: args.background, theme: args.theme }); return null; }
          if (cmd === 'set_menu_shortcuts') { (window as unknown as { menuShortcuts: unknown[] }).menuShortcuts.push(args.shortcuts); return null; }
          if (cmd === 'launch_ready') return [];
          return null;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
    });
  }, platform);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Document source' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.emitTauri!('notation:probe', null))).toBe(0);
}

const emit = (page: Page, payload: unknown) => page.evaluate((value) => window.emitTauri!('notation:menu-command', value), payload);

test('macOS menu commands run through the app command handler', async ({ page }) => {
  await openDesktop(page, 'MacIntel');
  await expect.poll(() => emit(page, 'not.a.command')).toBe(1);
  await expect(documents(page).getByRole('tab')).toHaveCount(1);

  await emit(page, 'file.new');
  await expect(documents(page).getByRole('tab')).toHaveCount(2);
  for (const payload of [null, 42, { id: 'file.new' }, 'file.new ', '__proto__']) await emit(page, payload);
  await expect(documents(page).getByRole('tab')).toHaveCount(2);

  await emit(page, 'tab.close');
  await expect(documents(page).getByRole('tab')).toHaveCount(1);

  await emit(page, 'app.settings');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  // Like keyboard shortcuts, menu commands wait while a modal dialog is open.
  await emit(page, 'file.new');
  await emit(page, 'app.commands');
  await expect(documents(page).getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('dialog', { name: 'Commands', exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await emit(page, 'view.preview');
  await expect(page.getByRole('button', { name: 'Layout', exact: true })).toContainText('Preview');
});

test('the macOS main window makes its top bar the drag region and clears the window controls', async ({ page }) => {
  await openDesktop(page, 'MacIntel');
  await expect(page.locator('html')).toHaveClass(/(^| )platform-mac( |$)/u);
  const bar = page.locator('header.workspace-bar');
  await expect(bar).toHaveAttribute('data-tauri-drag-region', 'deep');
  await expect(bar).toHaveCSS('padding-left', '78px');
  // Controls inside the bar start to the right of the window controls.
  const first = await bar.locator(':scope > *').first().boundingBox();
  expect(first!.x).toBeGreaterThanOrEqual(78);
});

test('other desktop platforms and the browser keep the plain top bar', async ({ page, browser }) => {
  await openDesktop(page, 'Linux x86_64');
  await expect(page.locator('html')).not.toHaveClass(/platform-mac/u);
  const bar = page.locator('header.workspace-bar');
  expect(await bar.getAttribute('data-tauri-drag-region')).toBeNull();
  await expect(bar).toHaveCSS('padding-left', '6px');

  // A Mac browser tab has no window controls to clear.
  const context = await browser.newContext();
  const tab = await context.newPage();
  await tab.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }));
  await tab.goto('/');
  await expect(tab.getByRole('textbox', { name: 'Document source' })).toBeVisible();
  await expect(tab.locator('html')).not.toHaveClass(/platform-mac/u);
  expect(await tab.locator('header.workspace-bar').getAttribute('data-tauri-drag-region')).toBeNull();
  await context.close();
});

const sentShortcuts = (page: Page) => page.evaluate(() => (window as unknown as { menuShortcuts: Array<Record<string, string>> }).menuShortcuts);

test('the macOS menu receives the effective shortcuts, follows remaps and yields keys to shortcut capture', async ({ page }) => {
  await openDesktop(page, 'MacIntel');
  await expect.poll(async () => (await sentShortcuts(page)).length).toBeGreaterThan(0);
  let latest = (await sentShortcuts(page)).at(-1)!;
  // macOS defaults, in the menu library's syntax.
  expect(latest).toMatchObject({ 'file.new': 'CmdOrCtrl+N', 'file.saveAs': 'CmdOrCtrl+Shift+S', 'tab.close': 'CmdOrCtrl+W', 'app.settings': 'CmdOrCtrl+,', 'edit.replace': 'CmdOrCtrl+Alt+F', 'tab.next': 'CmdOrCtrl+Alt+ArrowRight', 'view.source': 'CmdOrCtrl+Alt+1' });
  expect(Object.values(latest).some((value) => /Mod|[⌘⇧⌥]/u.test(value))).toBe(false);
  expect(latest['file.newCanvas']).toBeUndefined();

  // While Settings is open the menu holds no key equivalents, so capture sees every key.
  await emit(page, 'app.settings');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  await expect.poll(async () => Object.keys((await sentShortcuts(page)).at(-1)!).length).toBe(0);
  await settings.getByRole('tab', { name: 'Shortcuts', exact: true }).click();
  const binding = settings.getByRole('textbox', { name: 'Shortcut for New', exact: true });
  await binding.focus();
  await page.keyboard.press('Meta+Shift+j');
  await expect(binding).toHaveValue('⇧⌘J');
  expect(Object.keys((await sentShortcuts(page)).at(-1)!).length).toBe(0);

  // Closing Settings sends the remapped set.
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await expect.poll(async () => (await sentShortcuts(page)).at(-1)!['file.new']).toBe('CmdOrCtrl+Shift+J');
  latest = (await sentShortcuts(page)).at(-1)!;
  expect(latest['file.saveAs']).toBe('CmdOrCtrl+Shift+S');
});

test('other platforms send no menu shortcuts', async ({ page }) => {
  await openDesktop(page, 'Linux x86_64');
  await page.waitForTimeout(300);
  expect(await sentShortcuts(page)).toEqual([]);
});

const presented = (page: Page) => page.evaluate(() => (window as unknown as { presented: Array<{ background: string; theme: string }> }).presented);

for (const platform of ['MacIntel', 'Linux x86_64'] as const) {
  test(`the hidden desktop window is presented with the theme's background on ${platform}`, async ({ page }) => {
    await openDesktop(page, platform);
    await expect.poll(async () => (await presented(page)).length).toBeGreaterThan(0);
    const first = (await presented(page))[0];
    // What the page actually paints, as #rrggbb, and the matching appearance.
    const painted = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const hex = '#' + painted.match(/\d+/gu)!.slice(0, 3).map((value) => Number(value).toString(16).padStart(2, '0')).join('');
    expect(first).toEqual({ background: hex, theme: 'dark' });
    expect(first.background).toMatch(/^#[0-9a-f]{6}$/u);

    // Switching to the light theme hands over the new background and appearance.
    const before = (await presented(page)).length;
    await emit(page, 'app.settings');
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await setSetting(page, 'Theme', 'light');
    await expect.poll(async () => (await presented(page)).length).toBeGreaterThan(before);
    const light = (await presented(page)).at(-1)!;
    const lightPainted = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const lightHex = '#' + lightPainted.match(/\d+/gu)!.slice(0, 3).map((value) => Number(value).toString(16).padStart(2, '0')).join('');
    expect(light).toEqual({ background: lightHex, theme: 'light' });
    expect(light.background).not.toBe(first.background);
  });
}

test('a browser tab never asks to present a window', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Document source' })).toBeVisible();
  expect(await page.evaluate(() => 'presented' in window)).toBe(false);
});
