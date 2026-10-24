import { expect, test, type Page } from '@playwright/test';

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
