import { expect, test, type Page } from '@playwright/test';
import { runCommand } from './commands';

const id = '0123456789abcdef0123456789abcdef';

async function stickyWindow(page: Page, options: { holdRead?: boolean; holdDestroy?: boolean; loadDelay?: number; failLoad?: boolean; failSave?: boolean; failDestroy?: boolean; note?: { title: string; text: string; html?: string | null; color?: string }; listenerDelay?: number } = {}) {
  await page.addInitScript(({ id, options }) => {
    const callbacks = new Map<number, (event: unknown) => void>();
    let next = 1;
    const state = {
      calls: [] as { cmd: string; args: Record<string, unknown> }[],
      updates: [] as Record<string, unknown>[],
      failSave: !!options.failSave, failLoad: !!options.failLoad, failDestroy: !!options.failDestroy,
      delay: 0, active: 0, maxActive: 0, destroyed: false, closeHandler: 0,
      readDelays: [] as number[], readFinished: false,
      releaseRead: undefined as (() => void) | undefined, releaseDestroy: undefined as (() => void) | undefined,
      note: options.note ?? { title: 'Saved title', text: 'Saved body', html: null, color: 'yellow' },
    };
    Object.assign(window, { stickyMock: state, isTauri: true, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: `sticky-${id}` }, currentWebview: { label: `sticky-${id}` } },
      transformCallback(callback: (event: unknown) => void) { const n = next++; callbacks.set(n, callback); return n; },
      unregisterCallback(n: number) { callbacks.delete(n); },
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        state.calls.push({ cmd, args });
        if (cmd === 'plugin:event|listen') { await new Promise(resolve => setTimeout(resolve, options.listenerDelay ?? 0)); state.closeHandler = Number(args.handler); return 1; }
        if (cmd === 'plugin:event|unlisten') return;
        if (cmd === 'read_sticky_note') {
          if (options.holdRead && !state.readFinished) await new Promise<void>(resolve => { state.releaseRead = resolve; });
          await new Promise(resolve => setTimeout(resolve, state.readDelays.shift() ?? options.loadDelay ?? 0));
          if (state.failLoad) throw new Error('read unavailable');
          state.readFinished = true;
          return { id, ...state.note };
        }
        if (cmd === 'update_sticky_note') {
          state.active++; state.maxActive = Math.max(state.maxActive, state.active);
          await new Promise(resolve => setTimeout(resolve, state.delay));
          state.active--;
          if (state.failSave) throw new Error('disk full');
            state.updates.push(args); Object.assign(state.note, args); return;
        }
        if (cmd === 'close_sticky_note') {
          if (options.holdDestroy) await new Promise<void>(resolve => { state.releaseDestroy = resolve; });
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
  return page.evaluate(() => (window as unknown as { stickyMock: { calls: { cmd: string }[]; updates: { title: string; text: string; html: string; color: string }[]; maxActive: number; active: number; destroyed: boolean } }).stickyMock);
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
  await panel.screenshot({ path: 'test-results/sticky-notes-list.png' });
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
  await expect.poll(async () => (await mockState(page)).updates.at(-1)?.text).toBe('<img src=x onerror=alert(1)> **not rich text**');
  await expect(page.getByRole('textbox', { name: 'Sticky title' })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('Saved');
  await expect(page.locator('img')).toHaveCount(0);
  const state = await mockState(page);
  expect(state.updates.at(-1)?.text).toBe('<img src=x onerror=alert(1)> **not rich text**');
  expect(state.calls.every(call => ['plugin:event|listen', 'read_sticky_note', 'update_sticky_note'].includes(call.cmd))).toBe(true);
});

test('autosave serializes coalesced writes and close waits for latest text, format and color', async ({ page }) => {
  await stickyWindow(page);
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await expect(text).toBeEnabled();
  await configure(page, { delay: 650 });
  await text.fill('first');
  await expect.poll(async () => (await mockState(page)).active).toBe(1);
  await text.fill('second');
  await text.fill('latest');
  await selectText(page);
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await page.getByRole('button', { name: 'Blue paper' }).click();
  await page.evaluate(() => (window as unknown as { requestStickyClose: () => void }).requestStickyClose());
  await expect(text).toBeDisabled();
  expect((await mockState(page)).destroyed).toBe(false);
  await expect.poll(async () => (await mockState(page)).destroyed).toBe(true);
  const state = await mockState(page);
  expect(state.maxActive).toBe(1);
  expect(state.updates).toHaveLength(2);
  expect(state.updates.at(-1)).toMatchObject({ title: 'latest', text: 'latest', color: 'blue' });
  expect(state.updates.at(-1)?.html).toMatch(/<(b|strong)>latest<\/(b|strong)>/);
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
  await expect(text).toHaveText('must not lose this');
  expect((await mockState(page)).destroyed).toBe(false);
  await configure(page, { failSave: false });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
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
  await expect(text).toHaveText('Saved title\nSaved body');
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
  await expect.poll(async () => (await mockState(page)).updates.at(-1)?.text).toBe('Fresh input after recovery');
  expect((await mockState(page)).calls.filter(call => call.cmd === 'read_sticky_note')).toHaveLength(2);
  await expect(text).toHaveText('Fresh input after recovery');
  expect((await mockState(page)).updates.at(-1)?.text).toBe('Fresh input after recovery');
});

async function selectText(page: Page) {
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await text.focus();
  await text.evaluate(editor => {
    const range = document.createRange(); range.selectNodeContents(editor);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
}

test('small toolbar preserves selection for pointer and keyboard, native undo and bullets toggle', async ({ page }) => {
  await stickyWindow(page);
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await expect(text).toBeEnabled();
  await text.fill('Format these words');
  await selectText(page);
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(text.locator('b,strong')).toHaveText('Format these words');
  await page.keyboard.press('Control+z');
  await expect(text.locator('b,strong')).toHaveCount(0);
  await page.keyboard.press('Control+b');
  await expect(text.locator('b,strong')).toHaveText('Format these words');
  // Keyboard activation moves focus out of the editor but must retain its range.
  await page.getByRole('button', { name: 'Italic', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(text.locator('i,em')).toHaveText('Format these words');
  await page.keyboard.press('Control+i');
  await expect(text.locator('i,em')).toHaveCount(0);
  await page.getByRole('button', { name: 'Bullets', exact: true }).click();
  await expect(text.locator('ul > li')).toHaveText('Format these words');
  await page.getByRole('button', { name: 'Bullets', exact: true }).click();
  await expect(text.locator('ul')).toHaveCount(0);
  await expect.poll(async () => (await mockState(page)).updates.at(-1)?.html).toMatch(/<(b|strong)>/);
});

test('all colors, formatted text and bullets survive reopening the component', async ({ page }) => {
  await stickyWindow(page);
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await expect(text).toBeEnabled();
  await text.fill('Saved formatting'); await selectText(page);
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await page.getByRole('button', { name: 'Italic', exact: true }).click();
  await page.getByRole('button', { name: 'Bullets', exact: true }).click();
  for (const color of ['Green', 'Blue', 'Pink', 'Purple', 'Gray', 'Yellow']) {
    await page.getByRole('button', { name: `${color} paper` }).click();
    await expect(page.getByRole('button', { name: `${color} paper` })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await mockState(page)).updates.at(-1)?.color).toBe(color.toLowerCase());
  }
  const saved = (await mockState(page)).updates.at(-1)!;
  expect(saved.text).toContain('Saved formatting');
  await page.getByRole('button', { name: 'Close sticky', exact: true }).click();
  await stickyWindow(page, { note: saved });
  await expect(text.locator('ul > li')).toHaveText('Saved formatting');
  await expect(text.locator('b,strong')).toHaveText('Saved formatting');
  await expect(text.locator('i,em')).toHaveText('Saved formatting');
  await expect(page.getByRole('button', { name: 'Yellow paper' })).toHaveAttribute('aria-pressed', 'true');
  expect((await mockState(page)).updates).toHaveLength(0);
});

test('stored HTML is inert and paste/drop insert only literal plain text without remote resources', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('sticky-attacker.invalid')) requests.push(request.url()); });
  await stickyWindow(page, { note: { title: 'Ignored formatted title', text: 'fallback', color: 'pink', html: '<p style="background:url(https://sticky-attacker.invalid/css)" onclick="window.pwned=1">Safe <b>bold</b><img src="https://sticky-attacker.invalid/image" onerror="window.pwned=1"><a href="https://sticky-attacker.invalid/link">link text</a><script>window.pwned=1</script><iframe src="https://sticky-attacker.invalid/frame"></iframe></p>' } });
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await expect(text).toBeEnabled();
  await expect(text.locator('b')).toHaveText('bold');
  await expect(text.locator('img,a,script,iframe,[style],[onclick]')).toHaveCount(0);
  await selectText(page);
  for (const type of ['paste', 'drop']) {
    await text.evaluate((editor, type) => {
      const data = new DataTransfer();
      data.setData('text/html', '<img src="https://sticky-attacker.invalid/paste" onerror="window.pwned=1"><b>rich</b>');
      data.setData('text/plain', '<img src=x> literal ' + type);
      editor.dispatchEvent(type === 'paste' ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }) : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    }, type);
    await expect(text).toHaveText('<img src=x> literal ' + type);
    await selectText(page);
  }
  await expect.poll(async () => (await mockState(page)).updates.at(-1)?.text).toBe('<img src=x> literal drop');
  expect((await mockState(page)).updates.at(-1)?.html).not.toContain('<img');
  expect(await page.evaluate(() => 'pwned' in window)).toBe(false);
  expect(requests).toEqual([]);
  // Unsupported rich beforeinput is canceled before it reaches the live DOM.
  expect(await text.evaluate(editor => editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'formatUnderline', cancelable: true, bubbles: true })))).toBe(false);
});

test('legacy title-only, literal markup and maximum body are not rewritten or truncated on load', async ({ page }) => {
  for (const note of [
    { title: '<b>Title only</b>', text: '' },
    { title: 'Distinct title', text: '<img src=x> literal body' },
    { title: 'Same first line', text: 'Same first line\nBody' },
    { title: 'Untitled sticky', text: 'Body without default title' },
    { title: 'Distinct title', text: 'x'.repeat(65536) },
  ]) {
    await stickyWindow(page, { note });
    const text = page.getByRole('textbox', { name: 'Sticky text' });
    await expect(text).toBeEnabled();
    const expected = note.title === 'Untitled sticky' || note.text.startsWith(note.title) ? note.text : note.title + (note.text ? '\n' + note.text : '');
    await expect(text).toHaveText(expected);
    await expect(text.locator('img,b')).toHaveCount(0);
    expect((await mockState(page)).updates).toHaveLength(0);
    if (note.text.length === 65536) {
      await expect(page.getByRole('alert')).toContainText('Nothing was truncated');
      await text.press('End'); await text.press('a');
      await page.getByRole('button', { name: 'Close sticky', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Nothing was truncated');
      expect((await mockState(page)).destroyed).toBe(false);
      expect((await mockState(page)).updates).toHaveLength(0);
    }
  }
});

test('listener registration gates load and Unicode-derived titles stay within the byte limit', async ({ page }) => {
  await stickyWindow(page, { listenerDelay: 700 });
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await expect(text).toBeDisabled();
  expect((await mockState(page)).calls.some(call => call.cmd === 'read_sticky_note')).toBe(false);
  await expect(text).toBeEnabled();
  await text.fill('😀'.repeat(100) + '\nrest');
  await expect.poll(async () => (await mockState(page)).updates.length).toBe(1);
  expect((await mockState(page)).updates[0].title).toBe('😀'.repeat(64));
});

test('typing, paragraphs and line breaks retain the native editor and undo history across autosave', async ({ page }) => {
  await stickyWindow(page, { note: { title: 'Untitled sticky', text: '' } });
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await expect(text).toBeEnabled();
  const original = await text.elementHandle();
  await text.focus(); await page.keyboard.type('First line');
  await expect.poll(async () => (await mockState(page)).updates.at(-1)?.text).toBe('First line');
  await text.press('Enter'); await page.keyboard.type('Second');
  await text.press('Shift+Enter'); await page.keyboard.type('Third');
  await expect.poll(async () => (await mockState(page)).updates.at(-1)?.text).toBe('First line\nSecond\nThird');
  expect(await original!.evaluate(element => element === document.querySelector('[aria-label="Sticky text"]'))).toBe(true);
  await text.press('Control+z');
  await expect(text).not.toContainText('Third');
  await text.press('Control+Shift+z');
  await expect(text).toContainText('Third');
});

async function exposeDisposal(page: Page) {
  // Test-only instrumentation of the real entry; no production debug API.
  await page.route('**/src/main.ts', async route => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace('import { mount }', 'import { mount, unmount }')
      .replace('mount(StickyNote, { target, props: { id } });', 'const instance = mount(StickyNote, { target, props: { id } }); Object.assign(window, { disposeSticky: () => unmount(instance) });');
    await route.fulfill({ response, body });
  });
}

async function disposeSticky(page: Page) {
  await page.evaluate(async () => { await (window as unknown as { disposeSticky: () => Promise<void> }).disposeSticky(); });
}

test('disposal cancels debounce, unregisters close protection, and ignores a late save result', async ({ page }) => {
  await exposeDisposal(page);
  await stickyWindow(page);
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await expect(text).toBeEnabled();
  await text.fill('canceled timer'); await disposeSticky(page);
  // Wait beyond the debounce to check that no pending callback saves.
  await page.waitForTimeout(450);
  expect((await mockState(page)).updates).toHaveLength(0);
  expect((await mockState(page)).calls.filter(call => call.cmd === 'plugin:event|unlisten')).toHaveLength(1);

  await stickyWindow(page); await expect(text).toBeEnabled();
  await configure(page, { delay: 650 });
  await text.fill('in flight');
  await expect.poll(async () => (await mockState(page)).active).toBe(1);
  await text.fill('must not write after disposal'); await disposeSticky(page);
  await expect.poll(async () => (await mockState(page)).active).toBe(0);
  await page.waitForTimeout(450);
  expect((await mockState(page)).updates.map(update => update.text)).toEqual(['in flight']);
  expect((await mockState(page)).destroyed).toBe(false);
});

test('disposal ignores late reads and releases a close listener registered after disposal', async ({ page }) => {
  await exposeDisposal(page);
  for (const options of [{ loadDelay: 650 }, { listenerDelay: 650 }]) {
    await stickyWindow(page, options);
    await expect(page.getByRole('textbox', { name: 'Sticky text' })).toBeDisabled();
    await disposeSticky(page);
    await page.waitForTimeout(800);
    await expect(page.getByRole('textbox', { name: 'Sticky text' })).toHaveCount(0);
    const state = await mockState(page);
    expect(state.updates).toHaveLength(0);
    expect(state.calls.filter(call => call.cmd === 'plugin:event|unlisten')).toHaveLength(1);
    if ('listenerDelay' in options) expect(state.calls.some(call => call.cmd === 'read_sticky_note')).toBe(false);
  }
});

test('drops outside the writing surface cannot navigate the note and the guard is removed on disposal', async ({ page }) => {
  await exposeDisposal(page);
  await stickyWindow(page);
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await expect(text).toBeEnabled();
  const original = await text.textContent();
  const canceled = await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/uri-list', 'https://sticky-attacker.invalid/drop');
    return !document.querySelector('header')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  expect(canceled).toBe(true);
  await expect(text).toHaveText(original!);
  expect((await mockState(page)).updates).toHaveLength(0);
  await disposeSticky(page);
  expect(await page.evaluate(() => window.dispatchEvent(new DragEvent('drop', { cancelable: true })))).toBe(true);
});


test('empty note hint stays out of saved content and save feedback remains visible', async ({ page }) => {
  await page.setViewportSize({ width: 340, height: 380 });
  await stickyWindow(page, { note: { title: '', text: '', html: '', color: 'yellow' } });
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await expect(text).toHaveClass(/empty/);
  await expect(page.getByRole('status')).toHaveText('Saved');
  expect((await mockState(page)).updates).toHaveLength(0);
  await configure(page, { delay: 650 });
  await text.fill('Remember the small things');
  await expect(text).not.toHaveClass(/empty/);
  await expect(page.getByRole('status')).toHaveText('Unsaved');
  await expect(page.getByRole('status')).toHaveText('Saving…');
  await expect(page.getByRole('status')).toHaveText('Saved');
  expect((await mockState(page)).updates.at(-1)?.text).toBe('Remember the small things');
  await text.blur();
  await page.screenshot({ path: 'test-results/sticky-writing-340.png' });
  await text.fill('');
  await expect(text).toHaveClass(/empty/);
  await expect(page.getByRole('status')).toHaveText('Saved');
  // A cleared contenteditable may retain its native trailing line break.
  expect((await mockState(page)).updates.at(-1)?.text.trim()).toBe('');
  await page.screenshot({ path: 'test-results/sticky-empty-340.png' });
});

test('sticky controls and retry remain reachable at native minimum size', async ({ page }) => {
  await page.setViewportSize({ width: 240, height: 200 });
  await stickyWindow(page, { failSave: true });
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await expect(text).toBeEnabled();
  await text.fill('Keep this note');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Not saved');
  for (const label of ['Bold', 'Italic', 'Bullets', 'Close sticky', 'Gray paper', 'Retry']) {
    const button = page.getByRole('button', { name: label, exact: true });
    await expect(button).toBeInViewport();
    const box = await button.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(240);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(240);
  await page.screenshot({ path: 'test-results/sticky-error-240.png' });
  await configure(page, { failSave: false });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
});


test('failed close during initial loading leaves read retry usable', async ({ page }) => {
  await stickyWindow(page, { holdRead: true, holdDestroy: true, failDestroy: true });
  await expect.poll(async () => (await mockState(page)).calls.some(call => call.cmd === 'read_sticky_note')).toBe(true);
  await page.getByRole('button', { name: 'Close sticky', exact: true }).click();
  await expect.poll(async () => (await mockState(page)).calls.some(call => call.cmd === 'close_sticky_note')).toBe(true);
  await page.evaluate(() => (window as unknown as { stickyMock: { releaseRead: () => void } }).stickyMock.releaseRead());
  await expect.poll(() => page.evaluate(() => (window as unknown as { stickyMock: { readFinished: boolean } }).stickyMock.readFinished)).toBe(true);
  await page.evaluate(() => (window as unknown as { stickyMock: { releaseDestroy: () => void } }).stickyMock.releaseDestroy());
  await expect(page.getByRole('alert')).toContainText('destroy unavailable');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  const text = page.getByRole('textbox', { name: 'Sticky text' });
  await expect(text).toBeEnabled();
  await text.fill('Recovered after close failed');
  await expect.poll(async () => (await mockState(page)).updates.at(-1)?.text).toBe('Recovered after close failed');
});
