import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source', exact: true });
const documents = (page: Page) => page.getByRole('tablist', { name: 'Documents', exact: true });
const activeEditorView = (page: Page) => page.locator('.editor-tab-host:not([hidden]) .cm-editor');

async function exportedText(page: Page) {
  const pending = page.waitForEvent('download');
  await runCommand(page, 'Save');
  const path = await (await pending).path();
  if (!path) throw new Error('Markdown export did not provide a file.');
  return readFile(path, 'utf8');
}

async function expectLiteralEditor(page: Page, expected: string) {
  await expect(source(page)).toHaveText(expected, { useInnerText: true });
  await expect(activeEditorView(page)).toHaveClass(/cm-hemingway/);
  const visual = await source(page).evaluate(element => ({
    syntax: element.querySelectorAll('.cm-content .cm-line span[class*="ͼ"]').length,
    widgets: element.querySelectorAll('.cm-live-math,.cm-live-wiki,.cm-live-table,.cm-live-callout,.cm-live-mermaid,.cm-live-citation,.document-variable,input.task-checkbox,.cm-widgetBuffer').length,
  }));
  expect(visual.syntax).toBe(0);
  expect(visual.widgets).toBe(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('Hemingway mode shows literal Markdown without syntax spans or Live widgets, then restores editing and rendering', async ({ page }) => {
  const markdown = '# Literal note\n\n**bold** and _italic_\n\n$x^2$\n\n[[Note|alias]]\n\n- [ ] task\n';
  await source(page).fill(markdown);
  await runCommand(page, 'Live Preview');
  await expect(source(page).locator('.cm-live-math .katex')).toHaveCount(1);
  await expect(source(page).locator('.cm-live-wiki')).toHaveCount(1);

  await runCommand(page, 'Hemingway mode');
  await expectLiteralEditor(page, markdown);
  await source(page).focus();
  await source(page).press('ControlOrMeta+End');
  await source(page).pressSequentially('/todo');
  await expect(page.getByRole('listbox', { name: 'Slash commands' })).not.toBeVisible();
  expect(await exportedText(page)).toBe(markdown + '/todo');

  await runCommand(page, 'Hemingway mode');
  await runCommand(page, 'Live Preview');
  await expect(source(page).locator('.cm-live-math .katex')).toHaveCount(1);
  await expect(source(page).locator('.cm-live-wiki')).toHaveCount(1);
  await expect(source(page).locator('.task-checkbox')).toHaveCount(1);
});

test('Hemingway mode permits typing, newlines, and paste at an empty caret', async ({ page }) => {
  await runCommand(page, 'New');
  await runCommand(page, 'Hemingway mode');
  const editor = source(page);
  await editor.pressSequentially('First line');
  await editor.press('Enter');
  await editor.pressSequentially('Second line');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText(' and pasted'));
  await editor.press('ControlOrMeta+v');
  const expected = 'First line\nSecond line and pasted';
  await expectLiteralEditor(page, expected);
  expect(await exportedText(page)).toBe(expected);
});

test('Hemingway mode blocks destructive keyboard edits and keeps existing source through undo/redo', async ({ page }) => {
  const original = '# Keep this\n\nA **bold** line with $x^2$.\n\n[[Note]]\n';
  await source(page).fill(original);
  await runCommand(page, 'Hemingway mode');
  const editor = source(page);

  await editor.press('ControlOrMeta+a');
  await editor.press('Backspace');
  await expectLiteralEditor(page, original);

  await editor.press('ControlOrMeta+a');
  await editor.press('ControlOrMeta+x');
  await expectLiteralEditor(page, original);

  await editor.press('ControlOrMeta+a');
  await editor.pressSequentially('replacement');
  await expectLiteralEditor(page, original);

  await editor.press('ControlOrMeta+Home');
  await editor.press('Delete');
  await expectLiteralEditor(page, original);

  await editor.press('ControlOrMeta+End');
  await editor.press('ControlOrMeta+Backspace');
  await editor.press('ControlOrMeta+Delete');
  await editor.press('ControlOrMeta+z');
  await editor.press('ControlOrMeta+y');
  await expectLiteralEditor(page, original);
  expect(await exportedText(page)).toBe(original);

  await runCommand(page, 'Hemingway mode');
  await editor.press('ControlOrMeta+End');
  await editor.pressSequentially(' editable');
  expect(await exportedText(page)).toBe(original + ' editable');
});

test('Hemingway state is independent per tab and restored with the session', async ({ page }) => {
  const first = '# First tab\n\n**literal** $A$\n';
  await source(page).fill(first);
  await runCommand(page, 'Hemingway mode');
  await runCommand(page, 'New');
  const second = '# Second tab\n\n**formatted** $B$\n';
  await source(page).fill(second);
  await expect(activeEditorView(page)).not.toHaveClass(/cm-hemingway/);
  await expect(source(page).locator('.cm-line span[class*="ͼ"]')).not.toHaveCount(0);

  await runCommand(page, 'Hemingway mode');
  await expectLiteralEditor(page, second);
  await documents(page).getByRole('tab', { name: 'welcome.md', exact: true }).click();
  await expectLiteralEditor(page, first);
  await page.reload();
  await expect(source(page)).toBeVisible();
  await expectLiteralEditor(page, first);
  await documents(page).getByRole('tab', { name: 'untitled.md', exact: true }).click();
  await expectLiteralEditor(page, second);
});

test('script output cannot replace a Hemingway document and shows feedback', async ({ page }) => {
  const original = '# Protected source\n\nKeep this paragraph.\n';
  await source(page).fill(original);
  await runCommand(page, 'Hemingway mode');
  await runCommand(page, 'Scripts');
  const scripts = page.getByRole('dialog', { name: 'Scripts', exact: true });
  await scripts.getByRole('textbox', { name: 'Script code', exact: true }).fill("return '# attempted replacement';");
  await scripts.getByRole('button', { name: 'Run script', exact: true }).click();
  await expect(scripts.getByLabel('Script output')).toContainText('attempted replacement');
  await expect(scripts.getByRole('button', { name: 'Apply to document', exact: true })).toBeDisabled();
  await expect(scripts.getByText(/Hemingway mode blocks document replacements/)).toBeVisible();
  expect(await exportedText(page)).toBe(original);
});
