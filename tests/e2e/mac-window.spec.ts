import { expect, test, type Page } from '@playwright/test';

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
