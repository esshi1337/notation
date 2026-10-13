import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { blurEditor, runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const reading = (page: Page) => page.getByRole('region', { name: 'Document preview' });
const task = (page: Page, label: string) => page.getByRole('checkbox', { name: `Task: ${label}`, exact: true });

async function savedText(page: Page) {
  const pending = page.waitForEvent('download');
  await runCommand(page, 'Save');
  return readFile((await (await pending).path())!, 'utf8');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('renders standard, nested, uppercase, and bare task checkboxes', async ({ page }) => {
  const text = '# Tasks\n\n- [ ] Pending\n  - [x] Nested done\n- [X] Complete\n\n[] Bare task\n[ ] Spaced task\n[x] Bare done\n';
  await source(page).fill(text);
  await runCommand(page, 'Live Preview');
  await expect(task(page, 'Pending')).not.toBeChecked();
  await expect(task(page, 'Nested done')).toBeChecked();
  await expect(task(page, 'Complete')).toBeChecked();
  await expect(task(page, 'Bare task')).not.toBeChecked();
  await expect(task(page, 'Spaced task')).not.toBeChecked();
  await expect(task(page, 'Bare done')).toBeChecked();
  expect(await savedText(page)).toBe(text);
});

test('toggles a Live task in the source and supports single-step undo', async ({ page }) => {
  const text = '# Tasks\n\n- [ ] Finish notes\n- [x] Keep completed\n';
  await source(page).fill(text);
  await runCommand(page, 'Live Preview');
  await task(page, 'Finish notes').check();
  await expect(task(page, 'Finish notes')).toBeChecked();
  expect(await savedText(page)).toBe(text.replace('[ ] Finish', '[x] Finish'));
  await runCommand(page, 'Source');
  await source(page).press('ControlOrMeta+z');
  expect(await savedText(page)).toBe(text);
  await runCommand(page, 'Live Preview');
  await expect(task(page, 'Finish notes')).not.toBeChecked();
});

test('toggles bare brackets with keyboard and keeps neighboring source intact', async ({ page }) => {
  await source(page).fill('[] First\n[ ] Second\n\nEnd.');
  await runCommand(page, 'Live Preview');
  await task(page, 'First').focus();
  await task(page, 'First').press('Space');
  await expect(task(page, 'First')).toBeChecked();
  await task(page, 'Second').check();
  expect(await savedText(page)).toBe('[x] First\n[x] Second\n\nEnd.');
  await task(page, 'First').uncheck();
  expect(await savedText(page)).toBe('[ ] First\n[x] Second\n\nEnd.');
});

test('makes a checkbox while typing a bare task label in Live Preview', async ({ page }) => {
  await source(page).fill('');
  await runCommand(page, 'Live Preview');
  await source(page).focus();
  await page.keyboard.insertText('[] Plan the day');
  await expect(source(page)).toBeFocused();
  await expect(task(page, 'Plan the day')).toBeVisible();
  expect(await savedText(page)).toBe('[] Plan the day');
});

test('aligns task checkboxes with their labels across editor font sizes', async ({ page }) => {
  for (const fontSize of [10, 14, 24]) {
    await page.evaluate((size) => {
      localStorage.setItem('notation.settings', JSON.stringify({ fontSize: size, layout: 'live' }));
    }, fontSize);
    await page.reload();
    await runCommand(page, 'Source');
    await source(page).fill('[] ds\n[x] Checked task\n\nEnd.');
    await runCommand(page, 'Live Preview');
    await expect(task(page, 'ds')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const geometry = await task(page, 'ds').evaluate((input) => {
      const line = input.closest('.cm-line')!;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let label: Node | null = null;
      while (walker.nextNode()) if (walker.currentNode.textContent?.includes('ds')) { label = walker.currentNode; break; }
      if (!label) throw new Error('Task label is missing');
      const range = document.createRange(); range.selectNodeContents(label);
      const text = range.getBoundingClientRect(), box = input.getBoundingClientRect();
      return { delta: Math.abs(box.y + box.height / 2 - text.y - text.height / 2), gap: text.x - box.right, size: box.width };
    });
    expect(geometry.delta).toBeLessThan(2);
    expect(geometry.gap).toBeGreaterThan(0);
    expect(geometry.size).toBeGreaterThanOrEqual(12);
    expect(geometry.size).toBeLessThanOrEqual(20);
  }
});

test('clicking a reading-preview checkbox updates source and remains undoable', async ({ page }) => {
  const text = '# Preview tasks\n\n- [ ] First\n  - [ ] Nested\n\n[] Bare\n';
  await source(page).fill(text);
  await reading(page).getByRole('checkbox', { name: 'Task: Nested' }).check();
  const changed = text.replace('[ ] Nested', '[x] Nested');
  await expect(source(page)).toContainText('- [x] Nested');
  expect(await savedText(page)).toBe(changed);
  await source(page).press('ControlOrMeta+z');
  expect(await savedText(page)).toBe(text);
  await runCommand(page, 'Preview');
  await task(page, 'Bare').check();
  expect(await savedText(page)).toBe(text.replace('[] Bare', '[x] Bare'));
});

test('does not turn code, links, or escaped brackets into tasks', async ({ page }) => {
  const text = '# Literal syntax\n\n`[] inline`\n\n```text\n- [ ] Fenced task\n[] Bare code\n```\n\n    [] Indented code\n\n\\[] Escaped\n\n[Link](https://example.test)\n';
  await source(page).fill(text);
  await expect(reading(page).locator('.task-checkbox')).toHaveCount(0);
  await runCommand(page, 'Live Preview');
  await expect(page.locator('.task-checkbox')).toHaveCount(0);
  expect(await savedText(page)).toBe(text);
});

test('renders inline and block LaTeX in reading preview and Live Preview', async ({ page }) => {
  const text = '# Equations\n\nInline $x^2 + \\alpha$ here.\n\n$$\n\\frac{1}{2} + \\sum_{i=1}^{n} i\n$$\n\nEnd.';
  await source(page).fill(text);
  await expect(reading(page).locator('.katex')).toHaveCount(2);
  await expect(reading(page).locator('.katex-display')).toHaveCount(1);
  await runCommand(page, 'Live Preview');
  await expect(page.locator('.cm-live-math .katex')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Edit inline equation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit block equation' })).toBeVisible();
  expect(await savedText(page)).toBe(text);
});

test('reveals inline math for editing then renders the changed expression', async ({ page }) => {
  await source(page).fill('# Math\n\nValue $x^2$.\n\nEnd.');
  await runCommand(page, 'Live Preview');
  await page.getByRole('button', { name: 'Edit inline equation' }).click();
  await expect(source(page)).toContainText('$x^2$');
  await source(page).locator('.cm-line').filter({ hasText: 'Value $x^2$.' }).click();
  await source(page).press('Home');
  await source(page).press('Shift+End');
  await page.keyboard.insertText('Value $y^3$.');
  await blurEditor(page);
  await expect(page.locator('.cm-live-math .katex')).toHaveCount(1);
  expect(await savedText(page)).toBe('# Math\n\nValue $y^3$.\n\nEnd.');
});

test('supports keyboard editing and blur restoration of a display equation', async ({ page }) => {
  await source(page).fill('# Display\n\n$$\\frac{a}{b}$$\n\nEnd.');
  await runCommand(page, 'Live Preview');
  const equation = page.getByRole('button', { name: 'Edit block equation' });
  await expect(equation.locator('.katex-display')).toBeVisible();
  await equation.focus();
  await equation.press('Enter');
  await expect(source(page)).toBeFocused();
  await expect(source(page)).toContainText('$$\\frac{a}{b}$$');
  await blurEditor(page);
  await expect(equation.locator('.katex-display')).toBeVisible();
});

test('keeps dollars in code, escaped expressions, and currency literal', async ({ page }) => {
  const text = '# Literals\n\nPrices are $5 and $10.\n\nEscaped \\$x\\$.\n\n`$x^2$`\n\n```tex\n$$\na^2 + b^2\n$$\n```\n\n    $indented$\n\nEnd.';
  await source(page).fill(text);
  await expect(reading(page).getByRole('heading', { name: 'Literals' })).toBeVisible();
  await expect(reading(page).locator('.katex')).toHaveCount(0);
  await runCommand(page, 'Live Preview');
  await expect(page.locator('.cm-live-math')).toHaveCount(0);
  expect(await savedText(page)).toBe(text);
});

test('shows localized math errors and allows correction', async ({ page }) => {
  await source(page).fill('# Still readable\n\n$\\notARealMathCommand{x}$\n\nEnd.');
  await expect(reading(page).getByRole('alert')).toContainText('Math error');
  await expect(reading(page).getByRole('heading', { name: 'Still readable' })).toBeVisible();
  await runCommand(page, 'Live Preview');
  await expect(page.locator('.cm-live-math').getByRole('alert')).toContainText('Math error');
  await page.getByRole('button', { name: 'Edit inline equation' }).click();
  await expect(source(page)).toContainText('\\notARealMathCommand');
  await runCommand(page, 'Source');
  await source(page).fill('# Corrected\n\n$\\sqrt{2}$\n\nEnd.');
  await runCommand(page, 'Live Preview');
  await expect(page.locator('.cm-live-math .katex')).toHaveCount(1);
  await expect(page.locator('.cm-live-math .katex svg path')).not.toHaveCount(0);
  await expect(page.locator('.cm-live-math').getByRole('alert')).toHaveCount(0);
});

test('does not allow trusted HTML or script links from math commands', async ({ page }) => {
  await source(page).fill('# Safe math\n\n$\\href{javascript:alert(1)}{bad}$\n\nEnd.');
  await expect(reading(page).getByRole('heading', { name: 'Safe math' })).toBeVisible();
  await expect(reading(page).locator('a[href^="javascript:"], script, [onerror]')).toHaveCount(0);
  await runCommand(page, 'Live Preview');
  await expect(page.locator('.cm-live-math')).toHaveCount(1);
  await expect(page.locator('.cm-live-math').locator('a[href^="javascript:"], script, [onerror]')).toHaveCount(0);
});

test('keeps math, Mermaid and tasks together across mode changes and reload', async ({ page }) => {
  const text = '# Mixed note\n\n- [ ] Check result\n\n$E=mc^2$\n\n$$a^2+b^2=c^2$$\n\n```mermaid\nflowchart LR\n A --> B\n```\n\nEnd.';
  await source(page).fill(text);
  await runCommand(page, 'Live Preview');
  await expect(page.locator('.cm-live-math .katex')).toHaveCount(2);
  await expect(page.locator('.cm-live-mermaid svg')).toHaveCount(1);
  await task(page, 'Check result').check();
  await runCommand(page, 'Preview');
  await expect(reading(page).locator('.katex')).toHaveCount(2);
  await expect(task(page, 'Check result')).toBeChecked();
  await runCommand(page, 'Live Preview');
  await page.reload();
  await expect(task(page, 'Check result')).toBeChecked();
  await expect(page.locator('.cm-live-math .katex')).toHaveCount(2);
  expect(await savedText(page)).toBe(text.replace('[ ] Check', '[x] Check'));
});

test('loads local math fonts and renders with external requests blocked', async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:1420)/, route => route.abort());
  await source(page).fill('# Offline math\n\n$$\\frac{1}{2}$$\n\nEnd.');
  await runCommand(page, 'Live Preview');
  await expect(page.locator('.cm-live-math .katex')).toHaveCount(1);
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('16px KaTeX_Main');
  });
  expect(loaded).toBe(true);
});
