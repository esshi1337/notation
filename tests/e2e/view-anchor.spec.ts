import { expect, test, type Page } from '@playwright/test';
import { commandPalette, commandResults, runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });

// 14 sections of 12 one-line paragraphs: paragraph N lives on a known line.
const SECTIONS = 14, PER_SECTION = 12;
function longDocument() {
  const lines: string[] = ['# Anchor document', ''];
  let paragraph = 0;
  for (let section = 1; section <= SECTIONS; section++) {
    lines.push(`## Section ${section}`, '');
    for (let item = 0; item < PER_SECTION; item++) lines.push(`Paragraph ${++paragraph} of the anchor document, with **bold** text and \`code\` so every mode has something to render.`, '');
  }
  return lines.join('\n');
}

/** Number of the first paragraph whose top edge is inside the visible pane. */
async function topParagraph(page: Page, pane: 'source' | 'preview') {
  return page.evaluate((which) => {
    const scroller = document.querySelector<HTMLElement>(which === 'source' ? '.editor-tab-host:not([hidden]) .cm-scroller' : '.preview-scroll');
    if (!scroller || !scroller.clientHeight) return null;
    const bounds = scroller.getBoundingClientRect();
    const blocks = [...scroller.querySelectorAll<HTMLElement>(which === 'source' ? '.cm-line' : '.markdown-body > p')];
    for (const block of blocks) {
      const match = /^Paragraph (\d+) /u.exec(block.textContent ?? '');
      const rect = block.getBoundingClientRect();
      if (match && rect.top >= bounds.top - 2 && rect.top < bounds.bottom) return Number(match[1]);
    }
    return null;
  }, pane);
}

async function expectTop(page: Page, pane: 'source' | 'preview', expected: number, tolerance: number) {
  await expect.poll(async () => {
    const top = await topParagraph(page, pane);
    return top === null ? 'hidden' : Math.abs(top - expected) <= tolerance ? 'near' : 'paragraph ' + top;
  }, { message: `${pane} pane should show paragraph ${expected} ± ${tolerance} at the top` }).toBe('near');
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('switching view modes keeps the top visible source line', async ({ page }) => {
  await runCommand(page, 'Source');
  await source(page).fill(longDocument());
  // Put paragraph 90 (section 8) at the top of the source pane.
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.editor-tab-host:not([hidden]) .cm-scroller')!;
    scroller.scrollTop = scroller.scrollHeight * 0.52;
  });
  await expect.poll(() => topParagraph(page, 'source')).not.toBeNull();
  const start = (await topParagraph(page, 'source'))!;
  expect(start).toBeGreaterThan(60);
  expect(start).toBeLessThan(130);

  await runCommand(page, 'Preview');
  await expectTop(page, 'preview', start, 3);
  await runCommand(page, 'Live Preview');
  await expectTop(page, 'source', start, 3);
  await runCommand(page, 'Split');
  await expectTop(page, 'source', start, 3);
  await expectTop(page, 'preview', start, 3);
  await runCommand(page, 'Source');
  await expectTop(page, 'source', start, 3);
  // A full round trip does not accumulate drift either.
  await runCommand(page, 'Preview');
  await runCommand(page, 'Source');
  await expectTop(page, 'source', start, 4);
});

test('a document at the top stays at the top in every mode', async ({ page }) => {
  await runCommand(page, 'Source');
  await source(page).fill(longDocument());
  await page.evaluate(() => { document.querySelector<HTMLElement>('.editor-tab-host:not([hidden]) .cm-scroller')!.scrollTop = 0; });
  for (const mode of ['Preview', 'Split', 'Live Preview', 'Source']) {
    await runCommand(page, mode);
    const pane = mode === 'Preview' ? '.preview-scroll' : '.editor-tab-host:not([hidden]) .cm-scroller';
    await expect.poll(() => page.evaluate((selector) => document.querySelector<HTMLElement>(selector)?.scrollTop ?? -1, pane), { message: mode }).toBeLessThan(4);
  }
});

test('the palette selects the first runnable command, not a disabled one', async ({ page }) => {
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  const palette = commandPalette(page);
  const search = palette.getByRole('textbox', { name: 'Search commands', exact: true });
  await search.fill('settings');
  // "Scripts (enable in Settings → Editor)" matches first but cannot run.
  const options = commandResults(page).getByRole('option');
  await expect(options.first()).toBeDisabled();
  await expect(options.first()).toHaveAttribute('aria-selected', 'false');
  await expect(commandResults(page).getByRole('option', { name: 'Settings', exact: true })).toHaveAttribute('aria-selected', 'true');
  await search.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // Arrow keys skip disabled entries and wrap among the runnable ones.
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  await search.fill('s');
  const selected = () => commandResults(page).locator('[role="option"][aria-selected="true"]');
  for (let step = 0; step < 12; step++) {
    await search.press('ArrowDown');
    await expect(selected()).toHaveCount(1);
    await expect(selected()).toBeEnabled();
  }
  await search.press('ArrowUp');
  await expect(selected()).toBeEnabled();

  // Only disabled matches: nothing is selected and Enter does nothing.
  await search.fill('Git');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toBeDisabled();
  await expect(selected()).toHaveCount(0);
  await search.press('ArrowDown');
  await expect(selected()).toHaveCount(0);
  await search.press('Enter');
  await expect(palette).toBeVisible();
});

test('editor callbacks do not trigger stale-assignment warnings', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (message) => { if (/assignment_value_stale/u.test(message.text())) warnings.push(message.text()); });
  await page.reload();
  await expect(source(page)).toBeVisible();
  for (let index = 0; index < 3; index++) {
    await runCommand(page, 'New');
    await source(page).fill('# Tab ' + index + '\n\nSome text.');
    await source(page).press('ArrowUp');
  }
  await runCommand(page, 'Live Preview');
  await runCommand(page, 'Source');
  expect(warnings).toEqual([]);
});
