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
      reads: [],
      agentResults: [],
      quitGuard: [],
      failPersist: false,
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
          if (cmd === 'set_quit_guard') { (window as unknown as { quitGuard: boolean[] }).quitGuard.push(Boolean(args.needed)); return null; }
          if (cmd === 'persist_state' && (window as unknown as { failPersist: boolean }).failPersist) throw new Error('disk full');
          if (cmd === 'read_document') { const reads = (window as unknown as { reads: string[] }).reads; reads.push(String(args.path)); return { path: '/vault/Readme.md', content: '# Stored spelling\n', warning: null }; }
          if (cmd === 'complete_agent_request') { (window as unknown as { agentResults: unknown[] }).agentResults.push(args); return null; }
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

const quitGuard = (page: Page) => page.evaluate(() => (window as unknown as { quitGuard: boolean[] }).quitGuard);

test('macOS tells the backend when a system quit must go through the close guard', async ({ page }) => {
  await openDesktop(page, 'MacIntel');
  const source = page.getByRole('textbox', { name: 'Document source' });
  await expect(source).toBeVisible();
  // A failed state write needs the guard (it holds the recovery prompt).
  await page.evaluate(() => { (window as unknown as { failPersist: boolean }).failPersist = true; });
  await source.click();
  await page.keyboard.type('unsaved words');
  await expect.poll(async () => (await quitGuard(page)).at(-1)).toBe(true);
  // Once writes succeed again nothing is pending and a system quit may proceed.
  await page.evaluate(() => { (window as unknown as { failPersist: boolean }).failPersist = false; });
  await page.keyboard.type(' more');
  await expect.poll(async () => (await quitGuard(page)).at(-1), { timeout: 15000 }).toBe(false);
});

test('other platforms never report a quit guard', async ({ page }) => {
  await openDesktop(page, 'Linux x86_64');
  const source = page.getByRole('textbox', { name: 'Document source' });
  await source.click();
  await page.keyboard.type('words');
  await page.waitForTimeout(1500);
  expect(await quitGuard(page)).toEqual([]);
});

test('a file opened under another spelling of its path is found under the stored one', async ({ page }) => {
  await openDesktop(page, 'MacIntel');
  await expect(page.getByRole('textbox', { name: 'Document source' })).toBeVisible();
  const ask = (id: string, path: string) => page.evaluate(([requestId, requestPath]) => window.emitTauri!('notation:agent-request', { id: requestId, operation: 'open_document', path: requestPath, expiresAt: Date.now() + 60000 }), [id, path]);
  const results = () => page.evaluate(() => (window as unknown as { agentResults: Array<{ id: string; result?: { path: string; id: string }; error?: string }> }).agentResults);

  // The backend stores Readme.md; the request names it in another letter case.
  await ask('one', '/vault/README.MD');
  await expect.poll(async () => (await results()).length).toBe(1);
  const first = (await results())[0];
  expect(first.error).toBeUndefined();
  expect(first.result!.path).toBe('/vault/Readme.md');
  await expect(page.getByRole('tab', { name: /Readme\.md/u })).toHaveCount(1);

  // The same spelling again, and the stored spelling, both reuse that tab.
  await ask('two', '/vault/README.MD');
  await ask('three', '/vault/Readme.md');
  await expect.poll(async () => (await results()).length).toBe(3);
  const all = await results();
  expect(all.map((entry) => entry.error)).toEqual([undefined, undefined, undefined]);
  expect(new Set(all.map((entry) => entry.result!.id)).size).toBe(1);
  await expect(page.getByRole('tab', { name: /Readme\.md/u })).toHaveCount(1);
  // The stored spelling is answered from the open tab without another read.
  expect(await page.evaluate(() => (window as unknown as { reads: string[] }).reads)).toEqual(['/vault/README.MD', '/vault/README.MD']);
});
