import { expect, test, type Page } from '@playwright/test';
import { openSettings, setSetting } from './commands';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const selector = (page: Page) => page.getByRole('combobox', { name: 'User theme', exact: true });
const cssInput = (page: Page) => page.getByRole('textbox', { name: 'Theme CSS', exact: true });
const styles = (page: Page) => page.locator('style[data-user-theme]');
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
type ImportWindow = Window & { themeImportPending: boolean; finishThemeImport: () => Promise<void> };
async function create(page: Page, name = 'Ocean', css?: string, base = 'light/paper') {
  await button(page, 'Create theme').click();
  await page.getByRole('textbox', { name: 'Theme name', exact: true }).fill(name);
  await page.getByRole('combobox', { name: 'Built-in base', exact: true }).selectOption(base);
  if (css) await cssInput(page).fill(css);
  await button(page, 'Save and apply theme').click();
  await expect(settings(page).getByRole('status')).toHaveText('Theme saved and applied.');
}
async function stored(page: Page) { return page.evaluate(() => JSON.parse(localStorage.getItem('notation.settings')!)); }
async function upload(page: Page, text: string) {
  await page.getByLabel('Import theme JSON', { exact: true }).setInputFiles({ name: 'theme.json', mimeType: 'application/json', buffer: Buffer.from(text) });
}

test.beforeEach(async ({ page }) => { await page.goto('/'); await openSettings(page); });

test('create save select reload: real token overrides beat presets and inline app variables', async ({ page }) => {
  await setSetting(page, 'Dark preset', 'Forest');
  await create(page);
  const id = await selector(page).inputValue();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-light-preset', 'paper');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(32, 40, 56)');
  await expect(page.locator('.workspace-bar')).toHaveCSS('background-color', 'rgb(40, 52, 72)');
  await expect(page.locator('.app')).toHaveCSS('--accent', '#a6d8ff');
  await expect(styles(page)).toHaveCount(1);
  // Settings controls retain the built-in choice, but icons use the effective mode.
  await expect(settings(page).locator('[data-icon]').first()).toHaveAttribute('data-icon-theme', 'light');
  await expect(settings(page).locator('[data-icon-theme="dark"]')).toHaveCount(0);
  await expect.poll(async () => (await stored(page)).selectedThemeId).toBe(id);
  await button(page, 'Close settings').click(); await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.cm-editor')).toHaveCSS('color', 'rgb(58, 49, 40)');
  // Light-mode icons use their actual light asset variant.
  await expect(page.locator('.commands-trigger [data-icon]')).toHaveAttribute('data-icon-theme', 'light');
  await openSettings(page);
  await expect(selector(page)).toHaveValue(id);
  await selector(page).selectOption('');
  await expect(styles(page)).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(settings(page).locator('[data-icon-theme="light"]')).toHaveCount(0);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(17, 23, 19)');
  await selector(page).selectOption(id);
  await expect(styles(page)).toHaveCount(1);
});

test('startup recovers valid persisted themes beside malformed and duplicate entries', async ({ page }) => {
  const valid = { id: 'theme-valid', name: 'Recovered', base: 'light/paper', css: ':root { --bg: #202838; }' };
  const later = { id: 'theme-later', name: 'Later', base: 'dark/dusk', css: ':root { --accent: #abcdef; }' };
  const seed = {
    userThemes: [valid, { id: 'theme-broken', name: 'Broken', base: 'light/paper', css: '@import "remote";' }, { ...valid, name: 'Duplicate' }, later],
    selectedThemeId: 'theme-valid', tabSize: 3, density: 'comfortable',
  };
  await page.evaluate(value => localStorage.setItem('notation.settings', JSON.stringify(value)), seed);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(32, 40, 56)');
  await openSettings(page);
  await expect(selector(page)).toHaveValue('theme-valid');
  await expect(selector(page).locator('option')).toHaveCount(3);
  await expect.poll(async () => {
    const value = await stored(page);
    return { selectedThemeId: value.selectedThemeId, userThemes: value.userThemes, tabSize: value.tabSize, density: value.density };
  }).toEqual({ selectedThemeId: 'theme-valid', userThemes: [valid, later], tabSize: 3, density: 'comfortable' });
  await page.reload();
  await expect(styles(page)).toHaveCount(1);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(32, 40, 56)');
  await openSettings(page);
  await expect(selector(page)).toHaveValue('theme-valid');
  expect((await stored(page)).userThemes).toEqual([valid, later]);
});

test('case-insensitive standalone :ROOT tokens beat presets and inline app variables', async ({ page }) => {
  await create(page, 'Upper root', ':ROOT { --accent: #abcdef; }\n.workspace-bar { color: var(--accent); }');
  await expect(page.locator('.workspace-bar')).toHaveCSS('color', 'rgb(171, 205, 239)');
  await expect(page.locator('.app')).toHaveCSS('--accent', '#abcdef');
});

test('preview cancel close section unmount and invalid saves preserve working styles', async ({ page }) => {
  await create(page, 'Original', ':root { --bar: #123456; }', 'dark/dusk');
  await button(page, 'Edit theme').click();
  await cssInput(page).fill(':root { --bar: #654321; }');
  await button(page, 'Preview theme').click();
  await expect(page.locator('.workspace-bar')).toHaveCSS('background-color', 'rgb(101, 67, 33)');
  await expect(styles(page)).toHaveCount(1);
  await button(page, 'Cancel theme edit').click();
  await expect(page.locator('.workspace-bar')).toHaveCSS('background-color', 'rgb(18, 52, 86)');
  for (const close of ['Close settings', 'section']) {
    await button(page, 'Edit theme').click();
    await cssInput(page).fill(':root { --bar: #654321; }');
    await button(page, 'Preview theme').click();
    if (close === 'section') await settings(page).getByRole('tab', { name: 'Editor', exact: true }).click();
    else await button(page, close).click();
    await expect(page.locator('.workspace-bar')).toHaveCSS('background-color', 'rgb(18, 52, 86)');
    if (close === 'section') await settings(page).getByRole('tab', { name: 'Appearance', exact: true }).click();
    else await openSettings(page);
  }
  await button(page, 'Edit theme').click();
  const before = (await stored(page)).userThemes;
  for (const invalid of ['body { color: not-a-color; }', 'body[ {color:red}', 'body { color:red; }'.repeat(250)]) {
    await cssInput(page).fill(invalid); await button(page, 'Save and apply theme').click();
    await expect(settings(page).getByRole('alert')).toBeVisible();
    expect((await stored(page)).userThemes).toEqual(before);
    await expect(page.locator('.workspace-bar')).toHaveCSS('background-color', 'rgb(18, 52, 86)');
  }
});

test('edit duplicate delete disable and export/import roundtrip use independent local IDs', async ({ page }) => {
  await create(page);
  const original = await selector(page).inputValue();
  await button(page, 'Edit theme').click();
  await page.getByRole('textbox', { name: 'Theme name', exact: true }).fill('Edited');
  await button(page, 'Save and apply theme').click();
  await expect(selector(page)).toHaveValue(original);
  await button(page, 'Duplicate theme').click();
  await button(page, 'Save and apply theme').click();
  const duplicate = await selector(page).inputValue(); expect(duplicate).not.toBe(original);
  const downloaded = page.waitForEvent('download'); await button(page, 'Export theme').click();
  const stream = await (await downloaded).createReadStream();
  const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString(); expect(JSON.parse(text).version).toBe(1);
  await upload(page, text);
  await expect(selector(page)).not.toHaveValue(duplicate);
  const imported = await selector(page).inputValue(); expect(imported).not.toBe(duplicate);
  await expect.poll(async () => (await stored(page)).userThemes.length).toBe(3);
  const library = (await stored(page)).userThemes;
  expect(library.find((item: { id: string }) => item.id === imported).css).toBe(JSON.parse(text).css);
  await button(page, 'Delete theme').click();
  await expect(selector(page)).toHaveValue(''); await expect(styles(page)).toHaveCount(0);
  await selector(page).selectOption(original); await button(page, 'Disable custom theme').click();
  await expect(styles(page)).toHaveCount(0);
  await expect.poll(async () => (await stored(page)).userThemes.length).toBe(2);
});

test('malformed oversized and malicious CSS imports make no external requests or state changes', async ({ page }) => {
  await create(page);
  const before = await stored(page);
  const external: string[] = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:1420/') && !request.url().startsWith('data:')) external.push(request.url()); });
  const variants = ['@import "https://evil.invalid/theme.css";', 'body { background: URL(https://evil.invalid/x); }', 'body{background:u/**/rl(https://evil.invalid)}', 'body{background:u\\72l(https://evil.invalid)}', 'body{background:image-set("https://evil.invalid" 1x)}', 'body{--x:url(data:image/svg+xml,x);background:var(--x)}', 'body{background:var(--icon-chevron)}', 'body{background:var(--evil,url(https://evil.invalid))}', '@font-face {font-family:evil;src:url(https://evil.invalid)}', 'body{color:invalid-color}'];
  for (const text of ['{', JSON.stringify({ version: 2 }), ' '.repeat(12289), ...variants.map(css => JSON.stringify({ version: 1, id: 'theme-import', name: 'Bad', base: 'dark/midnight', css }))]) {
    await upload(page, text);
    await expect(settings(page).getByRole('alert')).toBeVisible();
    expect((await stored(page)).userThemes).toEqual(before.userThemes);
    await expect(selector(page)).toHaveValue(before.selectedThemeId);
    await expect(styles(page)).toHaveCount(1);
  }
  expect(external).toEqual([]);
});

test('emergency keyboard recovery works before modal shortcuts, after hidden preview and reload', async ({ page }) => {
  await button(page, 'Create theme').click();
  await cssInput(page).fill('body {display:none}');
  await button(page, 'Preview theme').click(); await expect(page.locator('body')).toHaveCSS('display', 'none');
  await page.keyboard.press('Control+Shift+F12');
  await expect(page.locator('body')).not.toHaveCSS('display', 'none'); await expect(styles(page)).toHaveCount(0);
  await button(page, 'Save and apply theme').click();
  await expect(page.locator('body')).toHaveCSS('display', 'none');
  await expect.poll(async () => (await stored(page)).selectedThemeId).not.toBe('');
  await page.reload(); await expect(page.locator('body')).toHaveCSS('display', 'none');
  await page.keyboard.press('Meta+Shift+F12');
  await expect(page.locator('body')).not.toHaveCSS('display', 'none');
  await expect(styles(page)).toHaveCount(0);
  await expect.poll(async () => (await stored(page)).selectedThemeId).toBe('');
  expect((await stored(page)).userThemes).toHaveLength(1);
  await openSettings(page);
  await settings(page).getByRole('tab', { name: 'Shortcuts', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Shortcut for New', exact: true });
  await field.fill('Ctrl+Shift+F12'); await field.press('Enter');
  await expect(settings(page).getByRole('alert')).toContainText('reserved');
});

for (const recovery of ['keyboard recovery', 'Reset appearance']) {
  test(`${recovery} invalidates a pending import without losing the library or draft`, async ({ page }) => {
    await create(page);
    const library = (await stored(page)).userThemes;
    await button(page, 'Edit theme').click();
    const draftCSS = ':root { --bar: #654321; }';
    await cssInput(page).fill(draftCSS);
    await button(page, 'Preview theme').click();
    await page.evaluate(() => {
      const original = File.prototype.text;
      const state = window as ImportWindow;
      state.themeImportPending = false;
      File.prototype.text = function () {
        File.prototype.text = original;
        return new Promise<string>(resolve => {
          state.finishThemeImport = async () => { resolve(await original.call(this)); };
          state.themeImportPending = true;
        });
      };
    });
    await upload(page, JSON.stringify({ version: 1, id: 'theme-late', name: 'Late import', base: 'light/default', css: ':root { --accent: #abcdef; }' }));
    await expect.poll(() => page.evaluate(() => (window as ImportWindow).themeImportPending)).toBe(true);
    if (recovery === 'keyboard recovery') await page.keyboard.press('Control+Shift+F12');
    else await button(page, recovery).click();
    await expect(selector(page)).toHaveValue('');
    await expect(styles(page)).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(settings(page).locator('[data-icon-theme="light"]')).toHaveCount(0);
    await page.evaluate(() => (window as ImportWindow).finishThemeImport());
    await expect(settings(page).getByRole('alert')).toHaveCount(0);
    await expect(selector(page)).toHaveValue('');
    await expect(styles(page)).toHaveCount(0);
    await expect(selector(page).locator('option')).toHaveCount(library.length + 1);
    await expect(cssInput(page)).toHaveValue(draftCSS);
    await expect.poll(async () => {
      const value = await stored(page);
      return { selectedThemeId: value.selectedThemeId, userThemes: value.userThemes };
    }).toEqual({ selectedThemeId: '', userThemes: library });
    await page.reload();
    await expect(styles(page)).toHaveCount(0);
    await openSettings(page);
    await expect(selector(page)).toHaveValue('');
    expect((await stored(page)).userThemes).toEqual(library);
  });
}

test('custom base mode reaches Mermaid and repeated switches leave only one owned stylesheet', async ({ page }) => {
  await button(page, 'Close settings').click();
  await page.getByRole('textbox', { name: 'Document source' }).fill('```mermaid\ngraph TD\n A[Theme check] --> B[Ready]\n```');
  const node = page.locator('.preview-pane .node rect').first();
  await expect(node).toBeVisible();
  const darkFill = await node.evaluate(element => getComputedStyle(element).fill);
  await openSettings(page);
  await create(page, 'Light diagram', ':root { --accent: #abcdef; }');
  await expect.poll(() => node.evaluate(element => getComputedStyle(element).fill)).not.toBe(darkFill);
  const lightFill = await node.evaluate(element => getComputedStyle(element).fill);
  const id = await selector(page).inputValue();
  for (let i = 0; i < 6; i++) {
    await selector(page).selectOption('');
    await expect(styles(page)).toHaveCount(0);
    await expect.poll(() => node.evaluate(element => getComputedStyle(element).fill)).toBe(darkFill);
    await selector(page).selectOption(id);
    await expect(styles(page)).toHaveCount(1);
    await expect.poll(() => node.evaluate(element => getComputedStyle(element).fill)).toBe(lightFill);
  }
});

test('library count bound rejects a ninth import atomically with an actionable message', async ({ page }) => {
  for (let i = 0; i < 8; i++) {
    await upload(page, JSON.stringify({ version: 1, id: 'theme-same-imported-id', name: 'Theme ' + i, base: 'dark/charcoal', css: ':root { --accent: #abcdef; }' }));
    await expect.poll(async () => (await stored(page)).userThemes.length).toBe(i + 1);
  }
  const before = await stored(page);
  await upload(page, JSON.stringify({ version: 1, id: 'theme-ninth', name: 'Ninth', base: 'light/default', css: 'body {color:red}' }));
  await expect(settings(page).getByRole('alert')).toContainText('at most 8');
  expect((await stored(page)).userThemes).toEqual(before.userThemes);
  await expect(selector(page)).toHaveValue(before.selectedThemeId);
  await expect(styles(page)).toHaveCount(1);
});
