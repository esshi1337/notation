import { test, expect, type Page } from '@playwright/test';
import { runCommand } from './commands';
const source = (page: Page) => page.getByRole('textbox', { name: 'Document source', exact: true });
const notice = (page: Page) => page.locator('.formatting-notice');
async function text(page: Page) {
  return source(page).evaluate(el => {
    let node: any = el;
    while (node) { if (node.cmTile?.root?.view) return node.cmTile.root.view.state.doc.toString() as string; node = node.parentElement; }
    throw Error('No editor view');
  });
}
const large = ('ASCII !@#$%^&*()_+-=[]{};:\\|,.<>/? 😀 🧑🏽‍💻 e\u0301 中文 العربية \u2066RTL\u2069\u0000\n').repeat(6000);

test('large clipboard paste uses reduced source, retains undo and restores the chosen layout', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/'); await runCommand(page, 'Live Preview');
  await source(page).fill('# Small\n\n- [ ] task\n\nEnd');
  const small = await text(page);
  await page.evaluate(value => navigator.clipboard.writeText(value), large);
  await source(page).focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ControlOrMeta+v');
  await expect(notice(page)).toBeVisible(); expect(await text(page)).toBe(large);
  await expect(page.locator('.cm-foldGutter')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.press('x');
  expect(await text(page)).toBe(large + 'x');
  await page.keyboard.press('ControlOrMeta+z'); expect(await text(page)).toBe(large);
  await page.keyboard.press('ControlOrMeta+z'); expect(await text(page)).toBe(small);
  await expect(notice(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Commands', exact: true }).focus();
  await expect(source(page).locator('input.task-checkbox')).toBeVisible();
  await source(page).locator('input.task-checkbox').check();
  expect(await text(page)).toContain('- [x] task');
});

test('large file uses reduced source in Preview; switching to a small file restores Preview', async ({ page }) => {
  await page.goto('/'); await runCommand(page, 'Preview');
  const fileText = large.replaceAll('\u0000', ''); // File import rejects binary NUL; clipboard/API tests retain it.
  await page.locator('input[type=file]').setInputFiles({ name: 'large.md', mimeType: 'text/markdown', buffer: Buffer.from(fileText) });
  await expect(notice(page)).toBeVisible(); expect(await text(page)).toBe(fileText);
  await expect(page.getByRole('region', { name: 'Document preview' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'welcome.md', exact: true }).click();
  await expect(notice(page)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Document preview' })).toBeVisible();
  await page.getByRole('tab', { name: 'large.md', exact: true }).click();
  await expect(notice(page)).toBeVisible(); expect(await text(page)).toBe(fileText);
  await page.reload();
  await expect(notice(page)).toBeVisible(); expect(await text(page)).toBe(fileText);
});

test('inactive external replacement retains CRLF, Unicode and selection across formatting transitions', async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
  const result = await page.evaluate(async () => {
    const sp = '/node_modules/svelte/src/index-client.js', ep = '/src/Editor.svelte';
    const { mount, unmount, tick } = await import(/* @vite-ignore */ sp);
    const { default: Editor } = await import(/* @vite-ignore */ ep);
    const host = document.createElement('div'); document.body.append(host);
    const statuses: boolean[] = [];
    const small = '# Small\r\n😀 e\u0301\r\n';
    const large = '中文 🧑🏽‍💻 \u2066RTL\u2069\u0000\r\n'.repeat(20000);
    const editor = mount(Editor, { target: host, props: { active: false, value: small, wrap: true, live: true,
      standalone: false, theme: 'dark', folds: new Map(), onChange() {}, onFormatting(s: { reduced: boolean }) { statuses.push(s.reduced); } } });
    await tick(); editor.apply(large, small); await tick();
    editor.restoreSelection({ anchor: 2, head: 5 });
    const big = editor.snapshot(), selected = editor.selected();
    editor.apply(small, large); await tick(); const restored = editor.snapshot();
    const rejected = editor.apply('x'.repeat(4 * 1024 * 1024 + 1), small);
    const final = editor.snapshot();
    await unmount(editor); host.remove();
    return { exact: big.text === large, selected, restored: restored.text, rejected, final: final.text, statuses };
  });
  expect(result.exact).toBe(true); expect(result.selected).toEqual({ anchor: 2, head: 5 });
  expect(result.restored).toBe('# Small\r\n😀 e\u0301\r\n');
  expect(result.rejected).toBe(false); expect(result.final).toBe(result.restored);
  expect(result.statuses).toContain(true); expect(result.statuses.at(-1)).toBe(false);
});
