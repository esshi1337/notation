import { expect, test, type Page } from '@playwright/test';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
// A 1×1 PNG.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
type Mock = { calls: Array<{ path: string; known: string | null }>; version: number; sent: number; fail: boolean };
const mock = (page: Page) => page.evaluate(() => structuredClone((window as unknown as { mediaMock: Mock }).mediaMock));

async function setup(page: Page) {
  await page.addInitScript((pixel) => {
    const state: Mock = { calls: [], version: 1, sent: 0, fail: false };
    const tabs = [{ id: 'one', name: 'one.md', path: '/notes/one.md', content: '# Media\n\n![Pixel](pixel.png)\n', savedContent: '', savedName: 'one.md', updatedAt: 1 }];
    Object.assign(window, { mediaMock: state, isTauri: true, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: (path: string) => path,
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        if (cmd === 'bootstrap_state') return { settings: { layout: 'split' }, draft: null, scriptDraft: null, scripts: [], recents: [], workspace: null, workspaceCatalog: { activeId: null, workspaces: [] }, session: { activeTabId: 'one', tabs, updatedAt: 1 } };
        if (cmd === 'read_workspace_asset') {
          state.calls.push({ path: String(args.path), known: typeof args.known === 'string' ? args.known : null });
          if (state.fail) throw new Error('Choose a workspace-local media path.');
          const fingerprint = '70:' + state.version + ':1:1';
          if (args.known === fingerprint) return { unchanged: true, fingerprint };
          state.sent++;
          return { mime: 'image/png', dataUrl: pixel + '#v' + state.version, fingerprint };
        }
        if (cmd === 'launch_ready') return [];
        if (cmd === 'plugin:event|listen') return 1;
        return null;
      },
    }, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} } });
  }, PIXEL);
  await page.goto('/');
  await expect(source(page)).toBeVisible();
}

test('an unchanged local image is confirmed, not transferred again, on later renders', async ({ page }) => {
  await setup(page);
  const image = page.locator('.preview-scroll img[alt="Pixel"]');
  await expect(image).toHaveAttribute('src', PIXEL + '#v1');
  expect(await mock(page)).toMatchObject({ sent: 1, calls: [{ path: 'pixel.png', known: null }] });

  // Each edit re-renders the preview: the image is asked about, not re-sent.
  for (let edit = 0; edit < 3; edit++) {
    const before = (await mock(page)).calls.length;
    await source(page).press('ControlOrMeta+End');
    await page.keyboard.type('\nedit ' + edit);
    await expect.poll(async () => (await mock(page)).calls.length).toBeGreaterThan(before);
    await expect(image).toHaveAttribute('src', PIXEL + '#v1');
  }
  const afterEdits = await mock(page);
  expect(afterEdits.sent).toBe(1);
  expect(afterEdits.calls.slice(1).every((call) => call.known === '70:1:1:1')).toBe(true);

  // The file changes: the next render gets the new image.
  await page.evaluate(() => { (window as unknown as { mediaMock: Mock }).mediaMock.version = 2; });
  await page.keyboard.type('\nchanged');
  await expect(image).toHaveAttribute('src', PIXEL + '#v2');
  expect((await mock(page)).sent).toBe(2);

  // A refused request shows the error; the kept copy is not used around it.
  await page.evaluate(() => { (window as unknown as { mediaMock: Mock }).mediaMock.fail = true; });
  await page.keyboard.type('\nrefused');
  await expect(page.locator('.preview-scroll .media-embed[role="alert"]')).toContainText('workspace-local media path');
  await expect(image).toHaveCount(0);
});

test('the same file name under another note is requested on its own', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.preview-scroll img[alt="Pixel"]')).toHaveCount(1);
  await runCommand(page, 'New');
  await source(page).fill('![Pixel](pixel.png)\n');
  // An unsaved note has no folder: the request carries no known fingerprint from the other note.
  await expect.poll(async () => (await mock(page)).calls.length).toBeGreaterThan(1);
  expect((await mock(page)).calls.at(-1)).toEqual({ path: 'pixel.png', known: null });
});
