import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { blurEditor, runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const preview = (page: Page) => page.getByRole('region', { name: 'Document preview' });

async function saveText(page: Page) {
  const pending = page.waitForEvent('download');
  await runCommand(page, 'Save');
  return readFile((await (await pending).path())!, 'utf8');
}

async function action(page: Page, name: string) {
  await runCommand(page, 'Block actions');
  const palette = page.getByRole('dialog', { name: 'Commands', exact: true });
  await expect(palette).toBeVisible();
  await palette.getByRole('option', { name, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('slash commands insert Markdown and undo as one edit', async ({ page }) => {
  await source(page).fill('');
  await source(page).pressSequentially('/todo');
  await expect(page.getByRole('listbox', { name: 'Slash commands' })).toBeVisible();
  await page.getByRole('option', { name: 'Task list', exact: true }).click();
  await expect(source(page)).toContainText('- [ ]');
  const text = await saveText(page);
  expect(text).toMatch(/^- \[ \]/);
  await source(page).press('ControlOrMeta+z');
  await expect(source(page)).toContainText('/todo');
});

test('slash menu supports keyboard selection and cancellation', async ({ page }) => {
  await source(page).fill('');
  await source(page).pressSequentially('/mermaid');
  await expect(page.getByRole('option', { name: 'Mermaid', exact: true })).toBeVisible();
  await source(page).press('Enter');
  await expect(source(page)).toContainText('```mermaid');
  await source(page).fill('/math');
  await expect(page.getByRole('listbox', { name: 'Slash commands' })).toBeVisible();
  await source(page).press('Escape');
  await expect(page.getByRole('listbox', { name: 'Slash commands' })).not.toBeVisible();
  expect(await saveText(page)).toBe('/math');
});

test('slash menu stays out of code, equations, and existing prose', async ({ page }) => {
  for (const text of ['```js\n/todo\n```', '$$\n/todo\n$$', 'https://example.test/todo', 'A normal /todo']) {
    await source(page).fill(text);
    await source(page).press('ControlOrMeta+End');
    await expect(page.getByRole('listbox', { name: 'Slash commands' })).not.toBeVisible();
  }
});

test('moves and duplicates a paragraph through undoable block actions', async ({ page }) => {
  const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
  await source(page).fill(text);
  await source(page).locator('.cm-line').filter({ hasText: 'Second paragraph.' }).click();
  await action(page, 'Move up');
  expect(await saveText(page)).toBe('Second paragraph.\n\nFirst paragraph.\n\nThird paragraph.');
  await source(page).press('ControlOrMeta+z');
  expect(await saveText(page)).toBe(text);
  await source(page).locator('.cm-line').filter({ hasText: 'Second paragraph.' }).click();
  await action(page, 'Duplicate');
  expect((await saveText(page)).match(/Second paragraph\./g)).toHaveLength(2);
  await source(page).press('ControlOrMeta+z');
  expect(await saveText(page)).toBe(text);
});

test('block actions keep an entire Mermaid fence intact', async ({ page }) => {
  const text = 'Before.\n\n```mermaid\nflowchart LR\n A --> B\n```\n\nAfter.';
  await source(page).fill(text);
  await source(page).locator('.cm-line').filter({ hasText: 'flowchart LR' }).click();
  await action(page, 'Duplicate');
  const duplicated = await saveText(page);
  expect(duplicated.match(/```mermaid\nflowchart LR\n A --> B\n```/g)).toHaveLength(2);
  expect(duplicated).toContain('Before.');
  expect(duplicated).toContain('After.');
  await source(page).press('ControlOrMeta+z');
  expect(await saveText(page)).toBe(text);
});

test('converts paragraphs and deletes blocks without losing undo', async ({ page }) => {
  await source(page).fill('A title\n\nKeep me.');
  await source(page).locator('.cm-line').filter({ hasText: 'A title' }).click();
  await action(page, 'Turn into heading');
  expect(await saveText(page)).toMatch(/^# A title\n/);
  await action(page, 'Turn into paragraph');
  expect(await saveText(page)).toBe('A title\n\nKeep me.');
  await action(page, 'Turn into task');
  expect(await saveText(page)).toMatch(/^- \[ \] A title/);
  await action(page, 'Delete');
  expect(await saveText(page)).not.toContain('A title');
  await source(page).press('ControlOrMeta+z');
  expect(await saveText(page)).toContain('- [ ] A title');
});

test('renders callouts and fold controls without modifying Markdown', async ({ page }) => {
  const text = '# Notes\n\n> [!NOTE]- Details\n> Hidden **content**.\n\n> [!TIP]+ Useful tip\n> Visible content.\n';
  await source(page).fill(text);
  const details = preview(page).getByRole('region', { name: 'Callout: Details' });
  await expect(details).toBeVisible();
  const toggle = details.getByRole('button', { name: 'Toggle callout: Details' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(details.getByText('Hidden content.')).not.toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(details).toContainText('Hidden content.');
  expect(await saveText(page)).toBe(text);
  await runCommand(page, 'Live Preview');
  const inline = page.getByRole('region', { name: 'Callout: Details' });
  await expect(inline).toBeVisible();
  await expect(inline.getByRole('button', { name: 'Toggle callout: Details' })).toHaveAttribute('aria-expanded', 'true');
});

test('edits a Live callout and preserves its complete source', async ({ page }) => {
  const text = '# Callouts\n\n> [!WARNING] Careful\n> Some text.\n\nEnd.';
  await source(page).fill(text);
  await runCommand(page, 'Live Preview');
  await page.locator('.cm-live-callout').getByRole('button', { name: 'Edit callout' }).click();
  await expect(source(page)).toContainText('> [!WARNING] Careful');
  await expect(source(page)).toContainText('> Some text.');
  await blurEditor(page);
  await expect(page.locator('.cm-live-callout')).toBeVisible();
  expect(await saveText(page)).toBe(text);
});

test('callouts render tasks, math, and diagrams with correct source offsets', async ({ page }) => {
  const text = '# Nested content\n\n> [!NOTE] Work\n> - [ ] Verify this\n>\n> $x^2$\n>\n> ```mermaid\n> flowchart LR\n> A --> B\n> ```\n\nEnd.';
  await source(page).fill(text);
  const callout = preview(page).getByRole('region', { name: 'Callout: Work' });
  await expect(callout.locator('.katex')).toHaveCount(1);
  await expect(callout.locator('.diagram svg')).toHaveCount(1);
  await callout.getByRole('checkbox', { name: 'Task: Verify this' }).check();
  expect(await saveText(page)).toBe(text.replace('[ ] Verify', '[x] Verify'));
  await runCommand(page, 'Live Preview');
  await expect(page.locator('.cm-live-callout .katex')).toHaveCount(1);
  await expect(page.locator('.cm-live-callout .diagram svg')).toHaveCount(1);
});

test('nested callouts keep typed monochrome icons and task, math, and Mermaid source offsets', async ({ page }) => {
  const text = [
    '> [!NOTE] Outer',
    '> Outer paragraph.',
    '>',
    '> > [!WARNING] Inner',
    '> > Inner paragraph.',
    '> > - [ ] Nested task',
    '> >',
    '> > $x^2$',
    '> >',
    '> > ```mermaid',
    '> > flowchart LR',
    '> >   A --> B',
    '> > ```',
    '',
    'After the callouts.',
  ].join('\n');
  await source(page).fill(text);
  const outer = preview(page).getByRole('region', { name: 'Callout: Outer', exact: true });
  const inner = preview(page).getByRole('region', { name: 'Callout: Inner', exact: true });
  await expect(outer).toHaveClass(/callout-information/);
  await expect(inner).toHaveClass(/callout-warning/);
  await expect(outer.locator('.callout-icon svg path').first()).not.toHaveAttribute('d', await inner.locator('.callout-icon svg path').first().getAttribute('d'));
  await expect(inner.getByRole('checkbox', { name: 'Task: Nested task' })).toBeVisible();
  await expect(inner.locator('.katex')).toHaveCount(1);
  await expect(inner.locator('.diagram svg')).toHaveCount(1);
  await expect(preview(page)).toContainText('After the callouts.');
  await expect(outer).not.toContainText('After the callouts.');

  await inner.getByRole('checkbox', { name: 'Task: Nested task' }).check();
  expect(await saveText(page)).toBe(text.replace('[ ] Nested task', '[x] Nested task'));
  await runCommand(page, 'Live Preview');
  await expect(page.locator('.cm-live-callout')).toHaveCount(1);
  await expect(page.locator('.cm-live-callout .callout')).toHaveCount(2);
  await expect(page.locator('.cm-live-callout .katex')).toHaveCount(1);
  await expect(page.locator('.cm-live-callout .diagram svg')).toHaveCount(1);
  expect(await saveText(page)).toBe(text.replace('[ ] Nested task', '[x] Nested task'));
});

test('callout syntax inside a code fence stays literal', async ({ page }) => {
  const text = '# Literal\n\n```md\n> [!NOTE]- Not a callout\n> Just code.\n```';
  await source(page).fill(text);
  await expect(preview(page).getByRole('heading', { name: 'Literal' })).toBeVisible();
  await expect(preview(page).locator('.callout')).toHaveCount(0);
  await runCommand(page, 'Live Preview');
  await expect(page.locator('.cm-live-callout')).toHaveCount(0);
  expect(await saveText(page)).toBe(text);
});

test('display math inside a callout does not consume following blocks', async ({ page }) => {
  const text = '> [!NOTE] Math\n> $$\n> x^2\n> $$\n\nOutside paragraph.\n\n```mermaid\nflowchart LR\n A --> B\n```';
  await source(page).fill(text);
  const callout = preview(page).getByRole('region', { name: 'Callout: Math', exact: true });
  await expect(callout.locator('.katex-display')).toHaveCount(1);
  await expect(callout).not.toContainText('Outside paragraph.');
  await expect(callout.locator('.diagram svg')).toHaveCount(0);
  await expect(preview(page).locator('.diagram svg')).toHaveCount(1);
  await runCommand(page, 'Live Preview');
  await expect(page.locator('.cm-live-callout .katex-display')).toHaveCount(1);
  await expect(page.locator('.cm-live-callout')).not.toContainText('Outside paragraph.');
  await expect(page.locator('.cm-live-mermaid svg')).toHaveCount(1);
  expect(await saveText(page)).toBe(text);
});

test('scripts transform document snapshots and apply as an undoable edit', async ({ page }) => {
  await source(page).fill('hello script');
  await runCommand(page, 'Scripts');
  const panel = page.getByRole('dialog', { name: 'Scripts', exact: true });
  await panel.getByRole('textbox', { name: 'Script code' }).fill('console.log("Transforming"); return {text: api.context.document.text.toUpperCase()};');
  await panel.getByRole('button', { name: 'Run script', exact: true }).click();
  await expect(panel).toContainText('Transforming');
  await expect(panel.getByRole('button', { name: 'Apply to document' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Apply to document' }).click();
  await panel.getByRole('button', { name: 'Close scripts' }).click();
  await expect(source(page)).toHaveText('HELLO SCRIPT');
  await source(page).press('ControlOrMeta+z');
  expect(await saveText(page)).toBe('hello script');
});

test('scripts report errors and do not apply failed output', async ({ page }) => {
  await source(page).fill('Keep this document.');
  await runCommand(page, 'Scripts');
  const panel = page.getByRole('dialog', { name: 'Scripts', exact: true });
  await panel.getByRole('textbox', { name: 'Script code' }).fill('throw new Error("Expected test error");');
  await panel.getByRole('button', { name: 'Run script', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Expected test error');
  await expect(panel.getByRole('button', { name: 'Apply to document' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Close scripts' }).click();
  expect(await saveText(page)).toBe('Keep this document.');
});

test('script output cannot overwrite a document edited after the run', async ({ page }) => {
  await source(page).fill('Original draft.');
  await runCommand(page, 'Scripts');
  const panel = page.getByRole('dialog', { name: 'Scripts', exact: true });
  await panel.getByRole('textbox', { name: 'Script code' }).fill('return {text: "Old result"};');
  await panel.getByRole('button', { name: 'Run script', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Apply to document' })).toBeEnabled();
  await source(page).fill('A newer edit.');
  await panel.getByRole('button', { name: 'Apply to document' }).click();
  await expect(panel.getByRole('alert')).toContainText(/changed/i);
  await expect(source(page)).toHaveText('A newer edit.');
});

test('script Stop interrupts a loop without freezing the editor', async ({ page }) => {
  await runCommand(page, 'Scripts');
  const panel = page.getByRole('dialog', { name: 'Scripts', exact: true });
  await panel.getByRole('textbox', { name: 'Script code' }).fill('while (true) {}');
  await panel.getByRole('button', { name: 'Run script', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Stop script', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Stop script', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Run script', exact: true })).toBeEnabled();
  await expect(panel).toContainText(/stopped|cancelled/i);
  await expect(panel.getByRole('button', { name: 'Apply to document' })).toBeDisabled();
});

test('saved script text survives reload and never runs automatically', async ({ page }) => {
  await runCommand(page, 'Scripts');
  let panel = page.getByRole('dialog', { name: 'Scripts', exact: true });
  await panel.getByRole('textbox', { name: 'Script name' }).fill('My transform');
  await panel.getByRole('textbox', { name: 'Script code' }).fill('console.log("RUN ONLY MANUALLY"); return "result";');
  await panel.getByRole('button', { name: 'Close scripts' }).click();
  await page.reload();
  await runCommand(page, 'Scripts');
  panel = page.getByRole('dialog', { name: 'Scripts', exact: true });
  await expect(panel.getByRole('textbox', { name: 'Script name' })).toHaveValue('My transform');
  await expect(panel.getByRole('textbox', { name: 'Script code' })).toHaveValue(/RUN ONLY MANUALLY/);
  await expect(panel.getByRole('button', { name: 'Apply to document' })).toBeDisabled();
});

test('browser scripting explicitly rejects filesystem automation', async ({ page }) => {
  await runCommand(page, 'Scripts');
  const panel = page.getByRole('dialog', { name: 'Scripts', exact: true });
  await panel.getByRole('textbox', { name: 'Script code' }).fill('return api.readText("/tmp/example.md");');
  await panel.getByRole('button', { name: 'Run script', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText(/desktop|unavailable/i);
  await expect(panel.getByRole('button', { name: 'Apply to document' })).toBeDisabled();
});
