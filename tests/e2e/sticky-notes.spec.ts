import { expect, test, type Page } from '@playwright/test';
import { runCommand } from './commands';

const id = '0123456789abcdef0123456789abcdef';

async function stickyWindow(page: Page, options: { loadDelay?: number; failLoad?: boolean; failSave?: boolean; failDestroy?: boolean } = {}) {
  await page.addInitScript(({ id, options }) => {
    const callbacks = new Map<number, (event: unknown) => void>();
    let next = 1;
    const state = {
      calls: [] as { cmd: string; args: Record<string, unknown> }[],
      updates: [] as Record<string, unknown>[],
      failSave: !!options.failSave, failLoad: !!options.failLoad, failDestroy: !!options.failDestroy,
      delay: 0, active: 0, maxActive: 0, destroyed: false, closeHandler: 0,
      readDelays: [] as number[],
    };
    Object.assign(window, { stickyMock: state, isTauri: true, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: `sticky-${id}` }, currentWebview: { label: `sticky-${id}` } },
      transformCallback(callback: (event: unknown) => void) { const n = next++; callbacks.set(n, callback); return n; },
      unregisterCallback(n: number) { callbacks.delete(n); },
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        state.calls.push({ cmd, args });
        if (cmd === 'plugin:event|listen') { state.closeHandler = Number(args.handler); return 1; }
        if (cmd === 'plugin:event|unlisten') return;
        if (cmd === 'read_sticky_note') {
          await new Promise(resolve => setTimeout(resolve, state.readDelays.shift() ?? options.loadDelay ?? 0));
          if (state.failLoad) throw new Error('read unavailable');
          return { id, title: 'Saved title', text: 'Saved body' };
        }
        if (cmd === 'update_sticky_note') {
          state.active++; state.maxActive = Math.max(state.maxActive, state.active);
          await new Promise(resolve => setTimeout(resolve, state.delay));
          state.active--;
          if (state.failSave) throw new Error('disk full');
          state.updates.push(args); return;
        }
        if (cmd === 'close_sticky_note') {
          if (state.failDestroy) throw new Error('destroy unavailable');
          state.destroyed = true; return;
        }
        throw new Error(`Unexpected native call: ${cmd}`);
      },
    }, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
    requestStickyClose: () => callbacks.get(state.closeHandler)?.({ event: 'tauri://close-requested', id: 1, payload: null }),
    });
  }, { id, options });
  await page.goto(`/?sticky=${id}`);
}

async function mockState(page: Page) {
  return page.evaluate(() => (window as unknown as { stickyMock: { calls: { cmd: string }[]; updates: { title: string; text: string }[]; maxActive: number; destroyed: boolean } }).stickyMock);
}
async function configure(page: Page, values: Record<string, unknown>) {
  await page.evaluate(values => Object.assign((window as unknown as { stickyMock: object }).stickyMock, values), values);
}

test('browser new sticky explains desktop-only without native commands or changing the ordinary draft', async ({ page }) => {
  await page.goto('/');
  const source = page.getByRole('textbox', { name: 'Document source' });
  await source.fill('Ordinary draft is untouched');
  await runCommand(page, 'New sticky note');
  const panel = page.getByRole('region', { name: 'Sticky notes', exact: true });
  await expect(panel).toContainText('Sticky notes require the desktop app');
  await expect(panel.getByRole('button', { name: 'New sticky note' })).toBeDisabled();
  await expect(source).toHaveText('Ordinary draft is untouched');
});

test('browser sticky query never bootstraps ordinary App', async ({ page }) => {
  await page.goto(`/?sticky=${id}`);
  await expect(page.locator('#app')).toHaveText('Sticky notes require a matching native desktop window.');
  await expect(page.getByRole('textbox', { name: 'Document source' })).toHaveCount(0);
});

test('main panel creates, reopens and confirms deletion through native commands with visible errors', async ({ page }) => {
  await page.goto('/');
  // Switch only newly mounted panel to native mode; ordinary App remains a browser
  // session. This tests command flow, not real native windows or dialogs.
  await page.evaluate(id => {
    const state = { calls: [] as string[], exists: false, open: false, confirm: false };
    Object.assign(window, { panelMock: state, isTauri: true, __TAURI_INTERNALS__: {
      async invoke(cmd: string) {
        state.calls.push(cmd);
        if (cmd === 'list_sticky_notes') return state.exists ? [{ id, title: 'Saved sticky', updatedAt: 1 }] : [];
        if (cmd === 'create_sticky_note') { state.exists = true; return { id, title: 'Saved sticky', updatedAt: 1 }; }
        if (cmd === 'open_sticky_note') { state.open = true; return; }
        if (cmd === 'plugin:dialog|message') return state.confirm ? 'Delete' : 'Cancel';
        if (cmd === 'delete_sticky_note') { if (state.open) throw new Error('Close this sticky window before deleting its note.'); state.exists = false; return; }
        throw new Error(`Unexpected panel command: ${cmd}`);
      },
    } });
  }, id);
  await runCommand(page, 'New sticky note');
  const panel = page.getByRole('region', { name: 'Sticky notes', exact: true });
  const saved = panel.getByRole('button', { name: 'Saved sticky', exact: true });
  await expect(saved).toBeVisible();
  await saved.click();
  await panel.getByRole('button', { name: 'Delete Saved sticky', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { panelMock: { exists: boolean } }).panelMock.exists)).toBe(true);
  await page.evaluate(() => { (window as unknown as { panelMock: { confirm: boolean } }).panelMock.confirm = true; });
  await panel.getByRole('button', { name: 'Delete Saved sticky', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Close this sticky window');
  await page.evaluate(() => { (window as unknown as { panelMock: { open: boolean } }).panelMock.open = false; });
  await panel.getByRole('button', { name: 'Delete Saved sticky', exact: true }).click();
  await expect(saved).toHaveCount(0);
  const calls = await page.evaluate(() => (window as unknown as { panelMock: { calls: string[] } }).panelMock.calls);
  expect(calls.filter(cmd => cmd === 'create_sticky_note')).toHaveLength(1);
  expect(calls.filter(cmd => cmd === 'open_sticky_note')).toHaveLength(2);
  expect(calls.filter(cmd => cmd === 'delete_sticky_note')).toHaveLength(2);
});

test('isolated native entry disables initial editing, renders plaintext, and never touches session metadata', async ({ page }) => {
  await stickyWindow(page, { loadDelay: 500 });
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await expect(text).toBeDisabled();
  await expect(text).toBeEnabled();
  await text.fill('<img src=x onerror=alert(1)> **not rich text**');
  await expect(page.getByRole('status')).toHaveText('Saved');
  await expect(page.locator('img')).toHaveCount(0);
  const state = await mockState(page);
  expect(state.updates.at(-1)?.text).toBe('<img src=x onerror=alert(1)> **not rich text**');
  expect(state.calls.every(call => ['plugin:event|listen', 'read_sticky_note', 'update_sticky_note'].includes(call.cmd))).toBe(true);
});

test('autosave serializes coalesced writes and close waits for latest title and text', async ({ page }) => {
  await stickyWindow(page);
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await expect(text).toBeEnabled();
  await configure(page, { delay: 650 });
  await text.fill('first');
  await expect(page.getByRole('status')).toHaveText('Saving…');
  await text.fill('second');
  await text.fill('latest');
  await page.getByRole('textbox', { name: 'Sticky title' }).fill('latest title');
  await page.evaluate(() => (window as unknown as { requestStickyClose: () => void }).requestStickyClose());
  await expect(text).toBeDisabled();
  expect((await mockState(page)).destroyed).toBe(false);
  await expect.poll(async () => (await mockState(page)).destroyed).toBe(true);
  const state = await mockState(page);
  expect(state.maxActive).toBe(1);
  expect(state.updates).toHaveLength(2);
  expect(state.updates.at(-1)).toMatchObject({ title: 'latest title', text: 'latest' });
  expect(state.calls.at(-1)?.cmd).toBe('close_sticky_note');
});

test('save failure preserves editable unsaved input and prevents close until retry succeeds', async ({ page }) => {
  await stickyWindow(page, { failSave: true });
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await expect(text).toBeEnabled();
  await text.fill('must not lose this');
  await page.getByRole('button', { name: 'Close sticky', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('disk full');
  await expect(text).toBeEnabled();
  await expect(text).toHaveValue('must not lose this');
  expect((await mockState(page)).destroyed).toBe(false);
  await configure(page, { failSave: false });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Close sticky', exact: true }).click();
  await expect.poll(async () => (await mockState(page)).destroyed).toBe(true);
  expect((await mockState(page)).updates.at(-1)?.text).toBe('must not lose this');
});

test('read errors keep editing disabled and can be retried; native destroy errors stay visible', async ({ page }) => {
  await stickyWindow(page, { failLoad: true, failDestroy: true });
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await expect(page.getByRole('alert')).toContainText('read unavailable');
  await expect(text).toBeDisabled();
  await configure(page, { failLoad: false });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(text).toHaveValue('Saved body');
  await expect(text).toBeEnabled();
  await page.getByRole('button', { name: 'Close sticky', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('destroy unavailable');
  await expect(text).toBeEnabled();
  await configure(page, { failDestroy: false });
  await page.getByRole('button', { name: 'Close sticky', exact: true }).click();
  await expect.poll(async () => (await mockState(page)).destroyed).toBe(true);
});

test('rapid load retries cannot overwrite text entered after recovery', async ({ page }) => {
  await stickyWindow(page, { failLoad: true });
  await expect(page.getByRole('alert')).toContainText('read unavailable');
  await configure(page, { failLoad: false, readDelays: [50, 900] });
  // Two queued clicks model a double click before the DOM updates its disabled state.
  await page.getByRole('button', { name: 'Retry', exact: true }).evaluate(button => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await expect(text).toBeEnabled();
  await text.fill('Fresh input after recovery');
  await expect(page.getByRole('status')).toHaveText('Saved');
  expect((await mockState(page)).calls.filter(call => call.cmd === 'read_sticky_note')).toHaveLength(2);
  await expect(text).toHaveValue('Fresh input after recovery');
  expect((await mockState(page)).updates.at(-1)?.text).toBe('Fresh input after recovery');
});
