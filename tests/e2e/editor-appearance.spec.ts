import { expect, test, type Page } from '@playwright/test';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const settingsDialog = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });

async function openEditorSettings(page: Page) {
  await runCommand(page, 'Settings');
  const settings = settingsDialog(page);
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  return settings;
}

async function closeSettings(page: Page) {
  await settingsDialog(page).getByRole('button', { name: 'Close settings' }).click();
  await expect(settingsDialog(page)).not.toBeVisible();
}

async function seedSettings(page: Page, settings: Record<string, unknown>) {
  await page.addInitScript((value) => {
    localStorage.removeItem('notation.session');
    localStorage.setItem('notation.settings', JSON.stringify(value));
  }, settings);
  await page.reload();
  await expect(source(page)).toBeVisible();
}

const editorFontSize = async (page: Page) => {
  const style = await page.locator('main.app').getAttribute('style');
  return /--editor-font-size:\s*(\d+)px/.exec(style ?? '')?.[1] ?? null;
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('zoom shortcuts adjust the editor font size', async ({ page }) => {
  await expect.poll(() => editorFontSize(page)).toBe('14');
  await source(page).click();
  await page.keyboard.press('ControlOrMeta+=');
  await expect.poll(() => editorFontSize(page)).toBe('15');
  await page.keyboard.press('ControlOrMeta+Shift+=');
  await expect.poll(() => editorFontSize(page)).toBe('16');
  await page.keyboard.press('ControlOrMeta+-');
  await expect.poll(() => editorFontSize(page)).toBe('15');
  await page.keyboard.press('ControlOrMeta+0');
  await expect.poll(() => editorFontSize(page)).toBe('14');
});

test('gutter font size tracks the editor font size and stays aligned', async ({ page }) => {
  const settings = await openEditorSettings(page);
  const size = settings.getByRole('spinbutton', { name: 'Font size', exact: true });
  await size.fill('24');
  await size.press('Tab');
  await closeSettings(page);

  const gutters = page.locator('.editor-host .cm-gutters').first();
  await expect(gutters).toHaveCSS('font-size', '19.2px');

  const gutterBox = (await page.locator('.editor-host .cm-lineNumbers .cm-gutterElement:visible').first().boundingBox())!;
  const lineBox = (await page.locator('.editor-host .cm-line').first().boundingBox())!;
  const gutterCenter = gutterBox.y + gutterBox.height / 2;
  const lineCenter = lineBox.y + lineBox.height / 2;
  expect(Math.abs(gutterCenter - lineCenter)).toBeLessThanOrEqual(3);

  const settingsAgain = await openEditorSettings(page);
  const sizeAgain = settingsAgain.getByRole('spinbutton', { name: 'Font size', exact: true });
  await sizeAgain.fill('10');
  await sizeAgain.press('Tab');
  await closeSettings(page);
  await expect(page.locator('.editor-host .cm-gutters').first()).toHaveCSS('font-size', '10px');
});

test('source view honors the reading width preference', async ({ page }) => {
  const settings = await openEditorSettings(page);
  const width = settings.getByRole('spinbutton', { name: 'Reading width', exact: true });
  await width.fill('600');
  await width.press('Tab');
  await closeSettings(page);
  await runCommand(page, 'Source');
  const content = page.locator('.editor-host .cm-editor:not(.cm-live-preview) .cm-content').first();
  await expect(content).toHaveCSS('max-width', '630px');
});

test('the gutter hugs the centered source column in a wide pane', async ({ page }) => {
  await seedSettings(page, { theme: 'dark', fontSize: 14, layout: 'source', readingWidth: 600 });
  const scroller = page.locator('.editor-host .cm-scroller').first();
  const gutters = page.locator('.editor-host .cm-gutters').first();
  const content = page.locator('.editor-host .cm-editor:not(.cm-live-preview) .cm-content').first();
  await expect(gutters).toBeVisible();

  const scrollerBox = (await scroller.boundingBox())!;
  const gutterBox = (await gutters.boundingBox())!;
  const contentBox = (await content.boundingBox())!;

  expect(gutterBox.x - scrollerBox.x).toBeGreaterThan(120);
  expect(contentBox.x - (gutterBox.x + gutterBox.width)).toBeLessThanOrEqual(2);
  const leftGap = gutterBox.x - scrollerBox.x;
  const rightGap = scrollerBox.x + scrollerBox.width - (contentBox.x + contentBox.width);
  expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(gutterBox.width + 2);

  const settings = await openEditorSettings(page);
  const size = settings.getByRole('spinbutton', { name: 'Font size', exact: true });
  await size.fill('24');
  await size.press('Tab');
  await closeSettings(page);
  await expect(gutters).toHaveCSS('font-size', '19.2px');

  const grownGutterBox = (await gutters.boundingBox())!;
  const grownContentBox = (await content.boundingBox())!;
  expect(grownContentBox.x - (grownGutterBox.x + grownGutterBox.width)).toBeLessThanOrEqual(2);
});

test('the gutter stays flush in a narrow source pane', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 720 });
  await runCommand(page, 'Source');
  const scroller = page.locator('.editor-host .cm-scroller').first();
  const gutters = page.locator('.editor-host .cm-gutters').first();
  const content = page.locator('.editor-host .cm-editor:not(.cm-live-preview) .cm-content').first();
  await expect(gutters).toBeVisible();

  const scrollerBox = (await scroller.boundingBox())!;
  const gutterBox = (await gutters.boundingBox())!;
  const contentBox = (await content.boundingBox())!;

  expect(gutterBox.x - scrollerBox.x).toBeLessThanOrEqual(2);
  expect(contentBox.x + contentBox.width - (scrollerBox.x + scrollerBox.width)).toBeLessThanOrEqual(2);
});

test('a wide wrap-off source pane keeps the gutter hugged without horizontal overflow', async ({ page }) => {
  await seedSettings(page, { theme: 'dark', fontSize: 14, layout: 'source', readingWidth: 600, wrap: false });
  const gutters = page.locator('.editor-host .cm-gutters').first();
  const content = page.locator('.editor-host .cm-editor:not(.cm-live-preview) .cm-content').first();
  const gutterBox = (await gutters.boundingBox())!;
  const contentBox = (await content.boundingBox())!;
  expect(gutterBox.x).toBeGreaterThan(120);
  expect(contentBox.x - (gutterBox.x + gutterBox.width)).toBeLessThanOrEqual(2);
  const overflow = await page.evaluate(() => {
    const scroller = document.querySelector('.editor-host .cm-scroller');
    return scroller ? scroller.scrollWidth - scroller.clientWidth : Number.POSITIVE_INFINITY;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});

test('the default indent is four spaces', async ({ page }) => {
  const settings = await openEditorSettings(page);
  await expect(settings.getByRole('spinbutton', { name: 'Indent size', exact: true })).toHaveValue('4');
});

test('stored two-space indents migrate once to four spaces', async ({ page }) => {
  await seedSettings(page, { theme: 'dark', fontSize: 17, layout: 'source', tabSize: 2 });
  let settings = await openEditorSettings(page);
  await expect(settings.getByRole('spinbutton', { name: 'Indent size', exact: true })).toHaveValue('4');
  await expect(settings.getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue('17');
  await closeSettings(page);

  await seedSettings(page, { tabSize: 3 });
  settings = await openEditorSettings(page);
  await expect(settings.getByRole('spinbutton', { name: 'Indent size', exact: true })).toHaveValue('3');
  await closeSettings(page);

  await seedSettings(page, { tabSize: 2, uiSettingsVersion: 2 });
  settings = await openEditorSettings(page);
  await expect(settings.getByRole('spinbutton', { name: 'Indent size', exact: true })).toHaveValue('2');
});
