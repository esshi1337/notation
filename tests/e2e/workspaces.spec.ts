import { expect, test, type Page } from '@playwright/test';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const panel = (page: Page) => page.getByRole('region', { name: 'Workspace', exact: true });
async function create(page: Page, name: string) {
  if (!await panel(page).isVisible()) await runCommand(page, 'Workspace');
  await panel(page).getByRole('textbox', { name: 'Workspace name', exact: true }).fill(name);
  await panel(page).getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Active workspace' })).toHaveText(name);
}
/** Pick a workspace in the header dropdown (an in-app listbox, not a native select). */
async function chooseWorkspace(page: Page, name: string) {
  await page.getByRole('combobox', { name: 'Active workspace' }).click();
  await page.getByRole('listbox', { name: 'Workspaces' }).getByRole('option', { name, exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Active workspace' })).toHaveText(name);
}
async function importShared(page: Page) {
  await page.locator('input[type=file]').setInputFiles({ name: 'shared.md', mimeType: 'text/markdown', buffer: Buffer.from('First line\nSecond line\nThird line') });
  await expect(source(page)).toContainText('First line');
}

test('workspaces share file edits while retaining separate tabs, cursors and layouts across restart', async ({ page }) => {
  await page.goto('/');
  await create(page, 'Research');
  await importShared(page);
  await runCommand(page, 'Source');
  await source(page).focus();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowRight');
  await create(page, 'Writing');
  await expect(source(page)).toHaveText('');
  await importShared(page);
  await source(page).focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' shared edit');
  await runCommand(page, 'Live Preview');
  const switcher = page.getByRole('combobox', { name: 'Active workspace' });
  await chooseWorkspace(page, 'Research');
  await expect(source(page)).toContainText('shared edit');
  await expect(page.getByRole('button', { name: 'Layout', exact: true })).toContainText('Source');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('notation.session')!).tabs.find((t: {name:string}) => t.name === 'shared.md').selection.head)).toBe(1);
  await chooseWorkspace(page, 'Writing');
  await expect(page.getByRole('button', { name: 'Layout', exact: true })).toContainText('Live');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('notation.session')!).tabs.find((t: {name:string}) => t.name === 'shared.md').selection.head)).toBe('First line\nSecond line\nThird line shared edit'.length);
  await page.reload();
  await expect(switcher).toHaveText('Writing');
  await expect(source(page)).toContainText('shared edit');
  await chooseWorkspace(page, 'Research');
  await expect(source(page)).toContainText('shared edit');
  await expect(page.getByRole('button', { name: 'Layout', exact: true })).toContainText('Source');
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem('notation.session')!));
  expect(session.tabs.filter((tab: { name: string }) => tab.name === 'shared.md')).toHaveLength(1);
  await page.screenshot({ path: 'test-results/workspaces-shared-file.png' });
});

test('closing a shared dirty tab only closes that view and deleting a workspace retains its drafts', async ({ page }) => {
  await page.goto('/');
  await create(page, 'First');
  await importShared(page);
  await create(page, 'Second');
  await importShared(page);
  await source(page).focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type(' unsaved');
  let dialogs = 0;
  page.on('dialog', async dialog => { dialogs++; await dialog.accept(); });
  await runCommand(page, 'Close tab');
  expect(dialogs).toBe(0);
  await chooseWorkspace(page, 'First');
  await expect(source(page)).toContainText('unsaved');
  // The Workspace command toggles; the header button always opens the panel,
  // whether or not it is already showing.
  await page.getByRole('button', { name: 'Open workspace panel', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('button', { name: 'Delete workspace', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Active workspace' })).toHaveText('Second');
  await page.getByRole('tab', { name: /shared.md/ }).click();
  await expect(source(page)).toContainText('unsaved');
  expect(dialogs).toBe(1);
});

test('first workspace keeps existing drafts and rename/delete change metadata only', async ({ page }) => {
  await page.goto('/');
  await source(page).fill('An existing unsaved draft');
  await create(page, 'Initial workspace');
  await expect(source(page)).toHaveText('An existing unsaved draft');
  await panel(page).getByRole('textbox', { name: 'Workspace name', exact: true }).fill('Renamed workspace');
  await panel(page).getByRole('button', { name: 'Rename workspace', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Active workspace' })).toHaveText('Renamed workspace');
  page.on('dialog', dialog => dialog.accept());
  await panel(page).getByRole('button', { name: 'Delete workspace', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Active workspace' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'welcome.md', exact: true }).click();
  await expect(source(page)).toHaveText('An existing unsaved draft');
  await page.reload();
  await expect(source(page)).toHaveText('An existing unsaved draft');
});

test('a shared tab that returns while it is still animating out is a normal tab again', async ({ page }) => {
  await page.goto('/');
  await create(page, 'First');
  await importShared(page);
  await create(page, 'Second');
  await importShared(page);
  // Stretch tab exits so switching workspaces always catches the tab mid-exit.
  await page.evaluate(() => {
    const original = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      const animation = original.call(this, keyframes, options);
      if (this instanceof HTMLElement && this.classList.contains('document-tab') && Number((keyframes as Keyframe[])[0].opacity) === 1) animation.playbackRate = 0.02;
      return animation;
    };
  });
  const switcher = page.getByRole('combobox', { name: 'Active workspace' });
  const shared = page.getByRole('tab', { name: /shared.md/ });
  for (const label of ['First', 'Second', 'First']) {
    await chooseWorkspace(page, label);
    await expect(switcher).toHaveText(label);
    await expect(shared).toHaveCount(1);
    await expect(shared).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.document-tab.active')).toHaveCount(1);
    await expect(page.locator('.document-tab.active [role="tab"]')).toHaveAttribute('aria-label', 'shared.md');
    expect(await page.locator('.document-tab.active').evaluate((element) => ({ hidden: element.getAttribute('aria-hidden'), inert: (element as HTMLElement).inert }))).toEqual({ hidden: null, inert: false });
  }
  await shared.click();
  await expect(source(page)).toContainText('First line');
});

test('the workspace dropdown is a themed listbox with keyboard, typeahead and focus return', async ({ page }) => {
  await page.goto('/');
  for (const name of ['Alpha', 'Beta', 'Bravo', 'Gamma']) await create(page, name);
  const switcher = page.getByRole('combobox', { name: 'Active workspace' });
  const list = page.getByRole('listbox', { name: 'Workspaces' });
  const active = () => list.locator('.workspace-option.active');
  await expect(switcher).toHaveText('Gamma');
  expect(await switcher.evaluate((element) => element.tagName)).toBe('BUTTON');

  // Keyboard: open, move, Home/End, typeahead, choose, focus back on the button.
  await switcher.focus();
  await page.keyboard.press('ArrowDown');
  await expect(list).toBeVisible();
  await expect(switcher).toHaveAttribute('aria-expanded', 'true');
  await expect(list.getByRole('option')).toHaveText(['Alpha', 'Beta', 'Bravo', 'Gamma']);
  await expect(list.getByRole('option', { name: 'Gamma', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(active()).toHaveText('Gamma');
  await page.keyboard.press('ArrowDown');
  await expect(active()).toHaveText('Alpha');
  await page.keyboard.press('End');
  await expect(active()).toHaveText('Gamma');
  await page.keyboard.press('Home');
  await expect(active()).toHaveText('Alpha');
  await page.keyboard.type('br');
  await expect(active()).toHaveText('Bravo');
  await expect(switcher).toHaveAttribute('aria-activedescendant', await active().getAttribute('id') as string);
  await expect(switcher).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(list).toHaveCount(0);
  await expect(switcher).toHaveText('Bravo');
  await expect(switcher).toBeFocused();

  // Escape closes only the list and returns focus; the selection is unchanged.
  await page.keyboard.press('Enter');
  await expect(list).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(switcher).toBeFocused();
  await expect(switcher).toHaveText('Bravo');

  // Typing on the closed button opens at the match; a repeated letter cycles.
  await page.keyboard.type('b');
  await expect(active()).toHaveText('Beta');
  await page.keyboard.type('b');
  await expect(active()).toHaveText('Bravo');
  await page.keyboard.press('Tab');
  await expect(list).toHaveCount(0);

  // Pointer: themed surface like the header menus, outside click dismisses.
  await switcher.click();
  await expect(list).toBeVisible();
  const menuSurface = await list.evaluate((element) => { const style = getComputedStyle(element); return [style.backgroundColor, style.borderTopLeftRadius, style.boxShadow !== 'none']; });
  await page.locator('.cm-content').first().click({ force: true });
  await expect(list).toHaveCount(0);
  await page.getByRole('button', { name: 'App menu', exact: true }).click();
  const appSurface = await page.locator('.compact-menu').evaluate((element) => { const style = getComputedStyle(element); return [style.backgroundColor, style.borderTopLeftRadius, style.boxShadow !== 'none']; });
  expect(menuSurface).toEqual(appSurface);
  await page.keyboard.press('Escape');
  await switcher.click();
  await list.getByRole('option', { name: 'Alpha', exact: true }).click();
  await expect(switcher).toHaveText('Alpha');
  await expect(switcher).toBeFocused();
});
