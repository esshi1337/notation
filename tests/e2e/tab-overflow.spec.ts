import { expect, test, type Page } from '@playwright/test';
import { settled } from './commands';

async function openManyTabs(page: Page) {
  await page.addInitScript(() => {
    const tabs = Array.from({ length: 18 }, (_, index) => ({
      id: `tab-${index}`, name: `${String(index).padStart(2, '0')} A longer document name.md`,
      path: null, content: `# Document ${index}`, savedContent: `# Document ${index}`,
    }));
    localStorage.setItem('notation.workspaces', JSON.stringify({ activeId: 'demo', workspaces: [
      { id: 'demo', name: 'Demo · Explore', files: [], legacyRoot: null },
    ] }));
    localStorage.setItem('notation.session', JSON.stringify({ tabs, activeTabId: tabs[0].id, updatedAt: Date.now() }));
  });
  await page.goto('/');
  await expect(page.getByRole('tablist', { name: 'Documents' }).getByRole('tab')).toHaveCount(18);
}

async function expectContainedHeader(page: Page) {
  for (const label of ['App menu', 'New document', 'Commands', 'Layout']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeInViewport({ ratio: 1 });
  }
  expect(await page.locator('.workspace-bar').evaluate(element => ({
    scroll: element.scrollLeft, height: element.clientHeight,
    contained: element.scrollWidth <= element.clientWidth,
  }))).toEqual({ scroll: 0, height: 43, contained: true });
}

test('new document stays next to a short row of tabs', async ({ page }) => {
  await page.goto('/');
  for (let count = 1; count <= 3; count++) {
    // A new tab grows in; measure once it has its full width.
    await settled(page.locator('.document-tab').last());
    const tab = await page.locator('.document-tab').last().boundingBox();
    const button = await page.getByRole('button', { name: 'New document', exact: true }).boundingBox();
    expect(button!.x - (tab!.x + tab!.width)).toBeCloseTo(4, 0);
    if (count < 3) await page.getByRole('button', { name: 'New document', exact: true }).click();
  }
});

test('many tabs keep a full-height row without a scrollbar across their labels', async ({ page }) => {
  await openManyTabs(page);
  const tabs = page.getByRole('tablist', { name: 'Documents' });
  for (const width of [1266, 1060, 720, 480, 360]) {
    await page.setViewportSize({ width, height: 650 });
    await expectContainedHeader(page);
    expect(await tabs.evaluate(element => ({
      overflowing: element.scrollWidth > element.clientWidth,
      height: element.clientHeight,
      scrollbar: getComputedStyle(element).scrollbarWidth,
    }))).toEqual({ overflowing: true, height: 32, scrollbar: 'none' });
  }
});

test('wheel and keyboard reach overflowed tabs without shifting the header', async ({ page }) => {
  await page.setViewportSize({ width: 1060, height: 650 });
  await openManyTabs(page);
  const tabs = page.getByRole('tablist', { name: 'Documents' });
  await tabs.hover();
  await page.mouse.wheel(0, 350);
  await expect.poll(() => tabs.evaluate(element => element.scrollLeft)).toBeGreaterThan(200);
  await page.mouse.wheel(0, -10000);
  await expect.poll(() => tabs.evaluate(element => element.scrollLeft)).toBe(0);
  await page.mouse.wheel(180, 0);
  await expect.poll(() => tabs.evaluate(element => element.scrollLeft)).toBeGreaterThan(100);
  await page.mouse.wheel(-10000, 0);
  await expect.poll(() => tabs.evaluate(element => element.scrollLeft)).toBe(0);
  const untouched = await tabs.evaluate(element => {
    const zoom = new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true });
    element.dispatchEvent(zoom);
    const boundary = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    element.dispatchEvent(boundary);
    return { zoomConsumed: zoom.defaultPrevented, boundaryConsumed: boundary.defaultPrevented, scroll: element.scrollLeft };
  });
  expect(untouched).toEqual({ zoomConsumed: false, boundaryConsumed: false, scroll: 0 });
  await tabs.getByRole('tab').first().focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.getByRole('tab').last()).toBeFocused();
  await expect.poll(() => tabs.evaluate(element => {
    const host = element.getBoundingClientRect();
    const tab = element.querySelector('.document-tab.active')!.getBoundingClientRect();
    return tab.left >= host.left - 1 && tab.right <= host.right + 1;
  })).toBe(true);
  await expectContainedHeader(page);
  await page.setViewportSize({ width: 720, height: 650 });
  await expect.poll(() => tabs.evaluate(element => {
    const host = element.getBoundingClientRect();
    const tab = element.querySelector('.document-tab.active')!.getBoundingClientRect();
    return tab.left >= host.left - 1 && tab.right <= host.right + 1;
  })).toBe(true);
  await expectContainedHeader(page);
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => tabs.evaluate(element => element.scrollLeft)).toBe(0);
  await expectContainedHeader(page);
});

test('closing tabs reveals the full active tab and its close button', async ({ page }) => {
  await page.setViewportSize({ width: 1060, height: 650 });
  await openManyTabs(page);
  const tabs = page.getByRole('tablist', { name: 'Documents' });
  await tabs.getByRole('tab').first().focus();
  await page.keyboard.press('ArrowLeft');
  for (const selector of ['.document-tab:first-child .tab-close', '.document-tab.active .tab-close']) {
    const count = await tabs.getByRole('tab').count();
    await tabs.locator(selector).click();
    await expect(tabs.getByRole('tab')).toHaveCount(count - 1);
    await expect.poll(() => tabs.evaluate(element => {
      const host = element.getBoundingClientRect();
      const active = element.querySelector('.document-tab.active')!.getBoundingClientRect();
      return active.left >= host.left - 1 && active.right <= host.right + 1;
    })).toBe(true);
    await expectContainedHeader(page);
  }
});

test('menus remain fully visible beside an overflowing tab strip', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 650 });
  await openManyTabs(page);
  for (const name of ['App menu', 'Layout']) {
    await page.getByRole('button', { name, exact: true }).click();
    const menu = page.getByRole('menu', { name, exact: true });
    await expect(menu).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  }
  await expectContainedHeader(page);
  await page.screenshot({ path: 'test-results/tab-strip-compact.png' });
});

test('overflowing tabs fade at the side that continues and the active indicator follows the selection', async ({ page }) => {
  await page.setViewportSize({ width: 1060, height: 650 });
  await openManyTabs(page);
  const tabs = page.getByRole('tablist', { name: 'Documents' });
  await expect(tabs).toHaveAttribute('data-fade', 'end');
  expect(await tabs.evaluate(element => getComputedStyle(element).maskImage)).toContain('linear-gradient');
  await tabs.hover();
  await page.mouse.wheel(0, 300);
  await expect(tabs).toHaveAttribute('data-fade', 'both');
  await page.mouse.wheel(0, 10000);
  await expect(tabs).toHaveAttribute('data-fade', 'start');
  await page.mouse.wheel(0, -10000);
  await expect(tabs).toHaveAttribute('data-fade', 'end');

  // One sliding background replaces the per-tab active background.
  const matches = () => tabs.evaluate(element => {
    const active = element.querySelector('.document-tab.active')!.getBoundingClientRect();
    const indicator = element.querySelector('.tab-indicator')!.getBoundingClientRect();
    return Math.abs(active.left - indicator.left) < 1 && Math.abs(active.width - indicator.width) < 1;
  });
  await expect.poll(matches).toBe(true);
  await expect(tabs.locator('.document-tab.active')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(tabs.locator('.tab-indicator')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  // The sliding state lasts about 220 ms, so record it instead of sampling it.
  await tabs.locator('.tab-indicator').evaluate((element) => {
    const state = window as unknown as { slid: boolean };
    state.slid = false;
    new MutationObserver(() => { if (element.classList.contains('sliding')) state.slid = true; }).observe(element, { attributes: true, attributeFilter: ['class'] });
  });
  await tabs.getByRole('tab').nth(3).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { slid: boolean }).slid)).toBe(true);
  await expect.poll(matches).toBe(true);
  await expect(tabs.locator('.tab-indicator')).not.toHaveClass(/sliding/);

  // A short row has nothing to fade.
  await page.setViewportSize({ width: 1266, height: 650 });
  for (let count = await tabs.getByRole('tab').count(); count > 3; count--) {
    await tabs.locator('.document-tab.active .tab-close').click();
    await expect(tabs.getByRole('tab')).toHaveCount(count - 1);
  }
  await expect(tabs).toHaveAttribute('data-fade', 'none');
  expect(await tabs.evaluate(element => getComputedStyle(element).maskImage)).toBe('none');
  await expect.poll(matches).toBe(true);
});

test('tabs with the same name show what tells them apart without changing their accessible names', async ({ page }) => {
  await page.addInitScript(() => {
    const tab = (id: string, name: string, path: string | null) => ({ id, name, path, content: '# ' + id, savedContent: '# ' + id });
    localStorage.setItem('notation.session', JSON.stringify({ tabs: [
      tab('a', 'untitled.md', null), tab('b', 'untitled.md', null), tab('c', 'untitled.md', null),
      tab('d', 'notes.md', '/home/demo/work/alpha/notes.md'), tab('e', 'notes.md', '/home/demo/work/beta/notes.md'),
      tab('f', 'readme.md', '/srv/x/docs/readme.md'), tab('g', 'readme.md', '/srv/y/docs/readme.md'), tab('h', 'readme.md', null),
      tab('i', 'unique.md', null),
    ], activeTabId: 'a', updatedAt: Date.now() }));
  });
  await page.setViewportSize({ width: 1900, height: 650 });
  await page.goto('/');
  const tabs = page.getByRole('tablist', { name: 'Documents' });
  await expect(tabs.getByRole('tab')).toHaveCount(9);
  const labels = await tabs.locator('.document-tab').evaluateAll(elements => elements.map(element => [element.querySelector('.tab-label')!.textContent, element.querySelector('.tab-context')?.textContent ?? '']));
  expect(labels).toEqual([
    ['untitled.md', ''], ['untitled.md', '2'], ['untitled.md', '3'],
    ['notes.md', 'alpha'], ['notes.md', 'beta'],
    ['readme.md', 'x/docs'], ['readme.md', 'y/docs'], ['readme.md', 'unsaved'],
    ['unique.md', ''],
  ]);
  await expect(tabs.getByRole('tab', { name: 'untitled.md', exact: true })).toHaveCount(3);
  await expect(tabs.getByRole('tab', { name: 'notes.md', exact: true })).toHaveCount(2);
});

test('hidden tabs are counted on an overflow button whose menu reaches them', async ({ page }) => {
  await page.setViewportSize({ width: 1060, height: 650 });
  await openManyTabs(page);
  const tabs = page.getByRole('tablist', { name: 'Documents' });
  const overflow = page.locator('.tab-overflow-button');
  const menu = page.getByRole('menu', { name: 'Hidden tabs', exact: true });
  const hiddenCount = () => tabs.evaluate((element) => {
    const host = element.getBoundingClientRect();
    return [...element.querySelectorAll('.document-tab')].filter((tab) => { const box = tab.getBoundingClientRect(); return box.left < host.left - 1 || box.right > host.right + 1; }).length;
  });
  await expect(overflow).toBeVisible();
  const initial = await hiddenCount();
  expect(initial).toBeGreaterThan(8);
  await expect(overflow).toHaveText('+' + initial);
  await expect(overflow).toHaveAttribute('aria-label', `Show ${initial} hidden tabs`);
  await expectContainedHeader(page);

  // The count follows scrolling.
  await tabs.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(async () => (await overflow.textContent())?.trim()).toBe('+' + await hiddenCount());

  // Pointer: the menu lists exactly the hidden tabs; choosing one reveals it.
  await page.mouse.wheel(0, -10000);
  await expect(overflow).toHaveText('+' + initial);
  await overflow.click();
  await expect(menu).toBeVisible();
  await expect(menu).toBeFocused();
  await expect(menu.getByRole('menuitem')).toHaveCount(initial);
  const last = '17 A longer document name.md';
  await menu.getByRole('menuitem', { name: last, exact: true }).click();
  await expect(menu).toHaveCount(0);
  const chosen = tabs.getByRole('tab', { name: last, exact: true });
  await expect(chosen).toHaveAttribute('aria-selected', 'true');
  await expect(chosen).toBeFocused();
  await expect.poll(() => tabs.evaluate((element) => {
    const host = element.getBoundingClientRect(), active = element.querySelector('.document-tab.active')!.getBoundingClientRect();
    return active.left >= host.left - 1 && active.right <= host.right + 1;
  })).toBe(true);
  await expect(menu.getByRole('menuitem', { name: last, exact: true })).toHaveCount(0);

  // Keyboard: Enter opens on the first hidden tab, arrows move, Escape returns focus.
  await overflow.focus();
  await page.keyboard.press('Enter');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(overflow).toBeFocused();

  // Narrow windows keep every header control on screen with the button present.
  for (const width of [720, 480, 360]) {
    await page.setViewportSize({ width, height: 650 });
    await expect(overflow).toBeVisible();
    await expectContainedHeader(page);
  }
  // When everything fits the button goes away.
  await page.setViewportSize({ width: 1266, height: 650 });
  for (let count = await tabs.getByRole('tab').count(); count > 3; count--) {
    await tabs.locator('.document-tab.active .tab-close').click();
    await expect(tabs.getByRole('tab')).toHaveCount(count - 1);
  }
  await expect(overflow).toHaveCount(0);
});
