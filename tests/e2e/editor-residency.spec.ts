import { test, expect } from '@playwright/test';
import { runCommand } from './commands';

test('inactive unvisited editors support guarded edits and raw CRLF selections without DOM', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Document source', exact: true })).toBeVisible();
  const result = await page.evaluate(async () => {
    const sveltePath = '/node_modules/svelte/src/index-client.js';
    const editorPath = '/src/Editor.svelte';
    const { mount, unmount, tick } = await import(/* @vite-ignore */ sveltePath);
    const { default: Editor } = await import(/* @vite-ignore */ editorPath);
    const target = document.createElement('div'); document.body.append(target);
    const changes: string[] = [];
    const editor = mount(Editor, { target, props: { active: false, value: 'first\r\nsecond\r\n', wrap: true,
      live: false, standalone: false, theme: 'dark', folds: new Map(), codeLanguage: 'plaintext',
      initialSelection: { anchor: 7, head: 13 }, onChange: (text: string) => changes.push(text) } });
    await tick();
    const initial = editor.snapshot();
    const stale = editor.apply('incorrect', 'stale');
    const accepted = editor.apply('changed\r\nsecond\r\n', initial.text);
    editor.restoreSelection({ anchor: 9, head: 15 });
    const updated = editor.snapshot(), selection = editor.selected();
    const mounted = target.querySelectorAll('.cm-editor').length;
    await unmount(editor); target.remove();
    return { initial, stale, accepted, updated, selection, mounted, changes };
  });
  expect(result.initial).toEqual({ text: 'first\r\nsecond\r\n', selection: 'second', from: 7, to: 13 });
  expect(result.stale).toBe(false);
  expect(result.accepted).toBe(true);
  expect(result.updated).toEqual({ text: 'changed\r\nsecond\r\n', selection: 'second', from: 9, to: 15 });
  expect(result.selection).toEqual({ anchor: 9, head: 15 });
  expect(result.mounted).toBe(0);
  expect(result.changes).toEqual(['changed\r\nsecond\r\n']);
});

test('tab changes release inactive DOM and preserve scroll, selection and undo', async ({ page }) => {
  await page.goto('/');
  await runCommand(page, 'Source');
  await page.locator('input[type=file]').setInputFiles({ name: 'scroll.txt', mimeType: 'text/plain',
    buffer: Buffer.from(Array.from({ length: 1500 }, (_, i) => `Line ${i}: scroll retention`).join('\n')) });
  const source = page.getByRole('textbox', { name: 'Document source', exact: true });
  await source.press('ControlOrMeta+End');
  await source.pressSequentially(' EDIT');
  await expect.poll(() => page.locator('.cm-scroller').evaluate(el => el.scrollTop)).toBeGreaterThan(500);
  const scroll = await page.locator('.cm-scroller').evaluate(el => el.scrollTop);
  const selection = await page.evaluate(() => JSON.parse(localStorage.getItem('notation.session')!).tabs.find((tab: { name: string }) => tab.name === 'scroll.txt').selection);
  await page.getByRole('tab', { name: 'welcome.md', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(1);
  await page.getByRole('tab', { name: 'scroll.txt', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(1);
  await expect.poll(() => page.locator('.cm-scroller').evaluate(el => el.scrollTop)).toBeGreaterThan(scroll - 100);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('notation.session')!).tabs.find((tab: { name: string }) => tab.name === 'scroll.txt').selection)).toEqual(selection);
  await source.press('ControlOrMeta+z');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('notation.session')!).tabs.find((tab: { name: string }) => tab.name === 'scroll.txt').content.endsWith(' EDIT'))).toBe(false);
});
