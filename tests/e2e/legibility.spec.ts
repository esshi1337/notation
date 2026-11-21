import { expect, test, type Page } from '@playwright/test';
import { openSettings, runCommand, settled } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const sample = ['---', 'title: Legibility', 'tags: [one, two]', '---', '', '# A first-level heading that is long enough to wrap in a narrow pane', '', 'Body with a footnote.[^1]', '', '> [!note] Callout title', '> Callout body', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '', ...Array.from({ length: 40 }, (_, index) => `Paragraph ${index}.\n`), '[^1]: The footnote.'].join('\n');

/** Visible text smaller than the floor: 12px for sans UI copy, 11px for monospace metadata. */
const undersized = (page: Page) => page.evaluate(() => {
  const found: string[] = [];
  for (const element of document.querySelectorAll<HTMLElement>('body *')) {
    if (element.closest('.cm-content, .cm-gutters, svg, .katex, .markdown-body, .settings-specimen-stage')) continue;
    if (![...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim())) continue;
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!box.width || !box.height || style.visibility === 'hidden') continue;
    const size = Number.parseFloat(style.fontSize);
    const mono = /mono/i.test(style.fontFamily);
    // The unsaved dot is a glyph, not copy.
    if (element.classList.contains('tab-dirty')) continue;
    if (size < (mono ? 11 : 12) - 0.01) found.push(`${element.className || element.tagName} ${size}px "${element.textContent!.trim().slice(0, 24)}"`);
  }
  return [...new Set(found)];
});

test('main-window UI copy stays at or above 12px, monospace metadata at 11px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await source(page).fill(sample);
  expect(await undersized(page)).toEqual([]);
  const rail = page.getByRole('navigation', { name: 'App sidebar' });
  for (const panel of ['Explorer panel', 'Workspace panel', 'History panel', 'Properties panel', 'Templates panel', 'Table editor panel', 'Sticky notes panel']) {
    await rail.getByRole('button', { name: panel, exact: true }).click();
    await settled(page.locator('.sidebar-panel'));
    expect(await undersized(page), panel).toEqual([]);
  }
  await expect(page.locator('.panel-note').first()).toHaveCSS('font-size', '13px');
  await runCommand(page, 'Find and replace');
  await expect(page.locator('.cm-panel.cm-search')).toBeVisible();
  expect(await undersized(page), 'search panel').toEqual([]);
  await page.keyboard.press('Escape');
  await openSettings(page);
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  for (const section of ['Appearance', 'Editor', 'Shortcuts', 'Agents']) {
    await settings.getByRole('tab', { name: section, exact: true }).click();
    expect(await undersized(page), 'Settings ' + section).toEqual([]);
    if (section === 'Editor') await expect(settings.locator('.settings-help').first()).toHaveCSS('font-size', '13px');
  }
});

test('small controls have a usable hit target and panel buttons look like buttons', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await source(page).fill(sample);
  const size = async (selector: string) => { const box = (await page.locator(selector).first().boundingBox())!; return { width: Math.round(box.width), height: Math.round(box.height) }; };
  const big = (box: { width: number; height: number }, width = 24, height = 20) => box.width >= width && box.height >= height;

  // The status bar keeps its height while the language button grows inside it.
  expect(big(await size('.document-language'))).toBe(true);
  expect((await size('.statusbar')).height).toBe(27);
  await expect(page.locator('.preview-pane .footnote-reference').first()).toBeVisible();
  expect(big(await size('.preview-pane .footnote-reference'))).toBe(true);
  expect(big(await size('.preview-pane [data-footnote-back]'))).toBe(true);

  await runCommand(page, 'Find and replace');
  expect(await size('.cm-panel.cm-search button[name="close"]')).toEqual({ width: 24, height: 24 });
  // The close button does not sit on top of the search fields.
  const overlap = await page.evaluate(() => {
    const close = document.querySelector('.cm-panel.cm-search button[name="close"]')!.getBoundingClientRect();
    return [...document.querySelectorAll('.cm-panel.cm-search input, .cm-panel.cm-search button:not([name="close"])')].some((element) => {
      const box = element.getBoundingClientRect();
      return box.right > close.left && box.left < close.right && box.bottom > close.top && box.top < close.bottom;
    });
  });
  expect(overlap).toBe(false);
  await page.locator('.cm-panel.cm-search button[name="close"]').click();
  await expect(page.locator('.cm-panel.cm-search')).toHaveCount(0);

  const rail = page.getByRole('navigation', { name: 'App sidebar' });
  await rail.getByRole('button', { name: 'Table editor panel', exact: true }).click();
  const table = page.getByRole('region', { name: 'Table editor', exact: true });
  for (const button of [table.getByRole('button', { name: 'Insert table', exact: true }), table.getByRole('button', { name: 'Edit table 1', exact: true })]) {
    await expect(button).toHaveCSS('border-top-style', 'solid');
    await expect(button).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  }
  await rail.getByRole('button', { name: 'Note graph panel', exact: true }).click();
  expect((await size('button[aria-label="Zoom in graph"]')).width).toBeGreaterThanOrEqual(28);

  await runCommand(page, 'New canvas');
  for (const name of ['Zoom in', 'Zoom out']) {
    const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
    expect(box.width, name).toBeGreaterThanOrEqual(28);
  }
});

test('the first preview heading scales with the pane and content under the status bar cannot be hit', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 480 });
  await page.goto('/');
  await source(page).fill(sample);
  const heading = page.locator('.preview-pane .markdown-body h1').first();
  await expect(heading).toBeVisible();
  const narrow = await heading.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(narrow).toBeGreaterThanOrEqual(24);
  expect(narrow).toBeLessThan(28);
  await page.setViewportSize({ width: 1700, height: 900 });
  await expect(heading).toHaveCSS('font-size', '32px');
  await runCommand(page, 'Preview');
  await expect(heading).toHaveCSS('font-size', '32px');

  // A callout scrolled to the pane's bottom edge is clipped by the pane; the
  // status-bar control at the same position still receives the pointer.
  await page.setViewportSize({ width: 1280, height: 800 });
  await runCommand(page, 'Split');
  const result = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.preview-scroll')!;
    const toggle = document.querySelector<HTMLElement>('.preview-pane .callout-toggle')!;
    const language = document.querySelector<HTMLElement>('.document-language')!;
    scroller.scrollTop += toggle.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + 6;
    const pane = scroller.getBoundingClientRect(), bar = document.querySelector('.statusbar')!.getBoundingClientRect(), box = language.getBoundingClientRect();
    return { paneEndsAtBar: pane.bottom <= bar.top + 0.5, hit: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === language };
  });
  expect(result).toEqual({ paneEndsAtBar: true, hit: true });
});

test('frontmatter lists show as wrapping chips in Preview and Live Preview', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 480 });
  await page.goto('/');
  await source(page).fill(['---', 'title: Chips', 'tags: [audit, ui, very-long-tag-name-that-should-wrap-or-truncate-gracefully-somewhere]', 'status: draft', '---', '', 'Body'].join('\n'));
  for (const [mode, scope] of [['Split', '.preview-pane'], ['Live Preview', '.cm-live-frontmatter']] as const) {
    await runCommand(page, mode);
    const block = page.locator(scope + ' .frontmatter-properties, ' + scope + '.frontmatter-properties').first();
    await expect(block).toBeVisible();
    const chips = block.locator('.frontmatter-chip');
    await expect(chips).toHaveText(['#audit', '#ui', '#very-long-tag-name-that-should-wrap-or-truncate-gracefully-s…']);
    await expect(block).not.toContainText('["');
    await expect(block.locator('dd').last()).toHaveText('draft');
    // Chips are pills that stay inside the block, however long.
    await expect(chips.first()).toHaveCSS('border-top-style', 'solid');
    expect(await block.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return [...element.querySelectorAll('.frontmatter-chip')].every((chip) => { const item = chip.getBoundingClientRect(); return item.left >= box.left && item.right <= box.right + 0.5; }) && element.scrollWidth <= element.clientWidth + 1;
    }), mode).toBe(true);
  }
});

test('the Settings editor specimen is fully visible by default and scrolls only when oversized', async ({ page }) => {
  for (const size of [{ width: 1440, height: 900 }, { width: 720, height: 480 }]) {
    await page.setViewportSize(size);
    await page.goto('/');
    await openSettings(page);
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
    const fits = () => settings.evaluate((dialog) => {
      const stage = dialog.querySelector('.settings-specimen-stage')!, page = dialog.querySelector('.settings-specimen-page')!.getBoundingClientRect();
      const card = dialog.querySelector('.settings-preview-card')!.getBoundingClientRect(), content = dialog.querySelector('.settings-content')!.getBoundingClientRect();
      return { scrolls: stage.scrollHeight > stage.clientHeight + 1, visible: page.bottom <= stage.getBoundingClientRect().bottom + 0.5, inside: card.bottom <= content.bottom + 0.5, share: card.height / content.height };
    });
    const box = await settings.boundingBox();
    if (size.height >= 900) {
      // Every layout's specimen is shown whole at the default font settings.
      for (const layout of ['Source', 'Split', 'Preview', 'Live Preview']) {
        await settings.getByRole('combobox', { name: 'Layout', exact: true }).click();
        await settings.getByRole('option', { name: new RegExp('^' + layout + '$') }).click();
        const state = await fits();
        expect({ layout, scrolls: state.scrolls, visible: state.visible, inside: state.inside }).toEqual({ layout, scrolls: false, visible: true, inside: true });
      }
    }
    // An oversized specimen scrolls inside its card; the dialog does not grow.
    const font = settings.getByRole('spinbutton', { name: 'Font size', exact: true });
    await font.fill('24'); await font.press('Enter');
    const lineHeight = settings.getByRole('spinbutton', { name: 'Line height', exact: true });
    await lineHeight.fill('2.2'); await lineHeight.press('Enter');
    const large = await fits();
    expect(large.inside).toBe(true);
    expect(large.share).toBeLessThanOrEqual(0.61);
    expect(await settings.boundingBox()).toEqual(box);
    // The scrollable controls above the specimen keep a usable height.
    expect(await settings.locator('.settings-editor-controls').evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(110);
  }
});

test('file navigator dialogs share the Settings surface and the frontmatter button reads as a button', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await source(page).fill(sample);
  const surface = (name: string) => page.getByRole('dialog', { name, exact: true }).evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, radius: style.borderTopLeftRadius, shadow: style.boxShadow !== 'none', backdrop: getComputedStyle(element, '::backdrop').backgroundColor };
  });
  await openSettings(page);
  const reference = await surface('Settings');
  await page.keyboard.press('Escape');
  for (const [command, name, field] of [['Go to file', 'Go to file', 'File name'], ['Search workspace files', 'Search workspace files', 'Search text']] as const) {
    await runCommand(page, command);
    const dialog = page.getByRole('dialog', { name, exact: true });
    await settled(dialog);
    expect(await surface(name), name).toEqual(reference);
    const input = dialog.getByRole('textbox', { name: field, exact: true });
    await expect(input).toBeFocused();
    expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(32);
    const close = (await dialog.getByRole('button', { name: 'Close file navigator', exact: true }).boundingBox())!;
    expect([Math.round(close.width), Math.round(close.height)]).toEqual([28, 28]);
    await expect(dialog.getByRole('button', { name: 'Close file navigator', exact: true })).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
  for (const [mode, locator] of [['Split', '.preview-pane .frontmatter-properties [data-edit-properties]'], ['Live Preview', '.cm-live-frontmatter [data-edit-properties]']] as const) {
    await runCommand(page, mode);
    const button = page.locator(locator).first();
    await expect(button).toBeVisible();
    expect((await button.boundingBox())!.height, mode).toBeGreaterThanOrEqual(24);
    await expect(button).toHaveCSS('border-top-style', 'solid');
    await expect(button).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  }
});
