import { expect, test, type Page } from '@playwright/test';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const documents = (page: Page) => page.getByRole('tablist', { name: 'Documents', exact: true });

/** Load the app as it sees itself on the given platform. */
async function open(page: Page, platform: 'MacIntel' | 'Linux x86_64') {
  await page.addInitScript((value) => Object.defineProperty(navigator, 'platform', { get: () => value }), platform);
  await page.goto('/');
  await expect(source(page)).toBeVisible();
}

async function wheelAllowed(page: Page, deltaY: number) {
  return page.evaluate((delta) => {
    const scroller = document.querySelector('.cm-scroller')!;
    return scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: delta, bubbles: true, cancelable: true }));
  }, deltaY);
}

test('on macOS Control combinations stay with the text system and Command runs app commands', async ({ page }) => {
  await open(page, 'MacIntel');
  await source(page).focus();
  for (const key of ['n', 'p', 'k', 'f', 'h', 'o']) await page.keyboard.press('Control+' + key);
  await expect(documents(page).getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.cm-search')).toHaveCount(0);

  await source(page).focus();
  await page.keyboard.press('Meta+n');
  await expect(documents(page).getByRole('tab')).toHaveCount(2);
  await page.keyboard.press('Meta+k');
  await expect(page.getByRole('dialog', { name: 'Commands', exact: true })).toBeVisible();
});

test('elsewhere Control still runs app commands', async ({ page }) => {
  await open(page, 'Linux x86_64');
  await source(page).focus();
  await page.keyboard.press('Control+n');
  await expect(documents(page).getByRole('tab')).toHaveCount(2);
});

test('shortcut labels use Apple glyphs on macOS in the menu, palette and Settings', async ({ page }) => {
  await open(page, 'MacIntel');
  await page.getByRole('button', { name: 'App menu', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'App menu', exact: true });
  await expect(menu.getByRole('menuitem', { name: 'Save As', exact: true }).locator('kbd')).toHaveText('⇧⌘S');
  await expect(menu.getByRole('menuitem', { name: 'Settings', exact: true }).locator('kbd')).toHaveText('⌘,');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Commands', exact: true });
  await palette.getByRole('textbox', { name: 'Search commands', exact: true }).fill('Find and replace');
  await expect(palette.getByRole('option', { name: 'Find and replace', exact: true }).locator('kbd')).toHaveText('⌥⌘F');
  await page.keyboard.press('Escape');

  await runCommand(page, 'Settings');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Shortcuts', exact: true }).click();
  await expect(settings.getByRole('textbox', { name: 'Shortcut for New', exact: true })).toHaveValue('⌘N');
  await expect(settings.getByRole('textbox', { name: 'Shortcut for Save As', exact: true })).toHaveValue('⇧⌘S');
  const values = await settings.locator('[data-shortcut-capture]').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  expect(values.length).toBeGreaterThan(40);
  expect(values.filter((value) => /Mod|Ctrl|\+/u.test(value))).toEqual([]);

  // A captured chord is stored as Mod+… and shown in the same glyph form.
  const binding = settings.getByRole('textbox', { name: 'Shortcut for New', exact: true });
  await binding.focus();
  await page.keyboard.press('Meta+Shift+j');
  await expect(binding).toHaveValue('⇧⌘J');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).toContain('Mod+Shift+J');
});

test('Settings never shows the internal Mod token on other platforms', async ({ page }) => {
  await open(page, 'Linux x86_64');
  await runCommand(page, 'Settings');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Shortcuts', exact: true }).click();
  await expect(settings.getByRole('textbox', { name: 'Shortcut for Save As', exact: true })).toHaveValue('Ctrl+Shift+S');
  const values = await settings.locator('[data-shortcut-capture]').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  expect(values.filter((value) => value.includes('Mod'))).toEqual([]);
});

test('macOS leaves wheel scrolling to the system and defaults smooth scrolling off', async ({ page }) => {
  await open(page, 'MacIntel');
  await source(page).fill(Array.from({ length: 400 }, (_, index) => 'Line ' + index).join('\n'));
  // Neither trackpad-sized pixel deltas nor a notched step is cancelled.
  for (const delta of [1.5, 4, 12, 120]) expect(await wheelAllowed(page, delta)).toBe(true);
  await runCommand(page, 'Settings');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  const toggle = settings.getByRole('checkbox', { name: 'Smooth scrolling', exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
});

test('other platforms keep animated wheel scrolling by default', async ({ page }) => {
  await open(page, 'Linux x86_64');
  await source(page).fill(Array.from({ length: 400 }, (_, index) => 'Line ' + index).join('\n'));
  await page.evaluate(() => { document.querySelector('.cm-scroller')!.scrollTop = 0; });
  expect(await wheelAllowed(page, 120)).toBe(false);
});

test('a canvas pinch zooms in proportion to its deltas instead of a full step per event', async ({ page }) => {
  await open(page, 'MacIntel');
  await runCommand(page, 'New canvas');
  const board = page.getByRole('application', { name: 'Canvas board', exact: true });
  const zoom = page.locator('.canvas-zoom');
  await expect(zoom).toHaveText('100%');
  const pinch = (deltaY: number, count: number) => board.evaluate((node, [delta, total]) => {
    for (let index = 0; index < total; index++) node.dispatchEvent(new WheelEvent('wheel', { deltaY: delta, ctrlKey: true, bubbles: true, cancelable: true }));
  }, [deltaY, count]);
  // Twenty 1.5 px events: e^0.3 = 135 %, where a step per event gave 673 %.
  await pinch(-1.5, 20);
  await expect(zoom).toHaveText('135%');
  await pinch(1.5, 20);
  await expect(zoom).toHaveText('100%');
  // A notched wheel still moves one step per notch.
  await pinch(-120, 1);
  await expect(zoom).toHaveText('110%');

  // WebKit reports pinches as gesture events carrying a cumulative scale.
  await board.evaluate((node) => {
    const gesture = (type: string, scale: number) => { const event = new Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { scale, clientX: 100, clientY: 100 }); node.dispatchEvent(event); };
    gesture('gesturestart', 1); gesture('gesturechange', 1.25); gesture('gesturechange', 1.5); gesture('gestureend', 1.5);
  });
  await expect(zoom).toHaveText('165%');
});
