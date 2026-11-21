import { expect, test, type Page } from '@playwright/test';

type FixtureTarget = 'scroller' | 'sidebar' | 'nested' | 'graph' | 'input';

declare global {
  interface Window {
    __smooth?: {
      root: HTMLElement;
      scroller: HTMLElement;
      sidebarScroller: HTMLElement;
      nested: HTMLElement;
      graph: SVGSVGElement;
      input: HTMLInputElement;
      handle: { update: (enabled: boolean) => void; destroy: () => void };
      rafFrames: number;
      samples: Array<{ top: number; at: number }>;
      sampleStart: number;
    };
  }
}

/** Build a DOM fixture and attach the action directly, independent of App.svelte. */
async function setup(page: Page, enabled = true) {
  // Keep Vite as the module server while serving a blank same-origin document.
  await page.route('**/smooth-scroll-fixture.html', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><head><meta charset="utf-8"><title>Smooth scroll fixture</title></head><body></body></html>',
  }));
  // The animator is for notched mice on Linux and Windows; on macOS it never
  // listens. Pin a non-Mac platform so these tests also run on a Mac host.
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' }));
  await page.goto('/smooth-scroll-fixture.html');
  await page.evaluate(async ({ enabled }) => {
    document.body.innerHTML = '';

    const root = document.createElement('main');
    root.id = 'smooth-fixture';
    root.style.cssText = 'position:fixed;inset:0;overflow:hidden;background:#fff;font:14px sans-serif';

    const scroller = document.createElement('div');
    scroller.className = 'preview-scroll';
    scroller.style.cssText = 'position:absolute;left:0;top:0;width:480px;height:360px;overflow-y:auto;overflow-x:hidden;background:#fff;';

    const spacer = document.createElement('div');
    spacer.style.height = '4000px';
    scroller.append(spacer);

    const input = document.createElement('input');
    input.type = 'range';
    input.setAttribute('aria-label', 'Fixture range');
    input.style.cssText = 'position:absolute;left:20px;top:20px;width:120px;';
    scroller.append(input);

    const nested = document.createElement('pre');
    nested.className = 'fixture-native';
    nested.style.cssText = 'position:absolute;left:520px;top:250px;width:180px;height:90px;margin:0;overflow:auto;background:#eee;';
    const nestedContent = document.createElement('div');
    nestedContent.style.height = '500px';
    nested.append(nestedContent);

    const graph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    graph.setAttribute('class', 'graph-canvas');
    graph.setAttribute('width', '180');
    graph.setAttribute('height', '120');
    graph.style.cssText = 'position:absolute;left:520px;top:100px;background:#f4f4f4;';
    graph.addEventListener('wheel', (event) => event.preventDefault());

    const sidebar = document.createElement('div');
    sidebar.className = 'sidebar-panel';
    sidebar.style.cssText = 'position:absolute;right:0;top:0;width:200px;height:360px;overflow:hidden;';
    const sidebarScroller = document.createElement('div');
    sidebarScroller.className = 'utility-panel';
    sidebarScroller.style.cssText = 'width:100%;height:100%;overflow-y:auto;background:#f8f8f8;';
    const sidebarContent = document.createElement('div');
    sidebarContent.style.height = '3000px';
    sidebarScroller.append(sidebarContent);
    sidebar.append(sidebarScroller);

    root.append(scroller, nested, graph, sidebar);
    document.body.append(root);

    // @ts-expect-error Browser-only Vite module path.
    const { smoothScrolling } = await import('/src/smooth-scroll.ts');
    const handle = smoothScrolling(root, enabled);

    const fixture = {
      root,
      scroller,
      sidebarScroller,
      nested,
      graph,
      input,
      handle,
      rafFrames: 0,
      samples: [] as Array<{ top: number; at: number }>,
      sampleStart: 0,
    };
    window.__smooth = fixture;
    scroller.addEventListener('scroll', () => {
      const current = window.__smooth;
      if (current) current.samples.push({ top: scroller.scrollTop, at: performance.now() - current.sampleStart });
    }, { passive: true });

    const nativeRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback: FrameRequestCallback) => nativeRaf((time) => {
      if (window.__smooth) window.__smooth.rafFrames += 1;
      callback(time);
    });
  }, { enabled });
}

async function resetSamples(page: Page) {
  await page.evaluate(() => {
    const fixture = window.__smooth!;
    fixture.samples = [];
    fixture.sampleStart = performance.now();
    fixture.rafFrames = 0;
  });
}

type WheelInput = {
  deltaY?: number;
  deltaX?: number;
  deltaMode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

async function dispatchWheel(page: Page, init: WheelInput, target: FixtureTarget = 'scroller'): Promise<boolean> {
  return page.evaluate(({ init, target }) => {
    const fixture = window.__smooth!;
    const element = target === 'sidebar' ? fixture.sidebarScroller
      : target === 'nested' ? fixture.nested
      : target === 'graph' ? fixture.graph
      : target === 'input' ? fixture.input
      : fixture.scroller;
    return element.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: init.deltaY ?? 0,
      deltaX: init.deltaX ?? 0,
      deltaMode: init.deltaMode ?? 0,
      ctrlKey: init.ctrlKey ?? false,
      metaKey: init.metaKey ?? false,
      shiftKey: init.shiftKey ?? false,
    }));
  }, { init, target });
}

async function scrollTop(page: Page, target: FixtureTarget = 'scroller') {
  return page.evaluate((target) => {
    const fixture = window.__smooth!;
    const element = target === 'sidebar' ? fixture.sidebarScroller
      : target === 'nested' ? fixture.nested
      : fixture.scroller;
    return element.scrollTop;
  }, target);
}

test('coarse wheel input animates, progresses, settles, and leaves no idle animation loop', async ({ page }) => {
  await setup(page);
  await resetSamples(page);
  await page.mouse.move(140, 160);
  await page.mouse.wheel(0, 400);

  await expect.poll(() => scrollTop(page)).toBe(400);
  await expect.poll(async () => (await page.evaluate(() => window.__smooth!.samples.slice())).at(-1)?.top).toBe(400);

  const timeline = await page.evaluate(() => window.__smooth!.samples.slice());
  expect(timeline.some(({ top }) => top > 0 && top < 400)).toBe(true);
  expect(timeline.at(-1)!.at).toBeLessThan(250);

  const frames = await page.evaluate(() => window.__smooth!.rafFrames);
  await page.waitForTimeout(180);
  expect(await page.evaluate(() => window.__smooth!.rafFrames)).toBe(frames);
  expect(await scrollTop(page)).toBe(400);
});

test('rapid coarse wheel input coalesces into one bounded target and chains at the end', async ({ page }) => {
  await setup(page);
  await resetSamples(page);

  const first = await page.evaluate(() => {
    const fixture = window.__smooth!;
    return Array.from({ length: 4 }, () => fixture.scroller.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }),
    ));
  });
  expect(first).toEqual([false, false, false, false]);
  await expect.poll(() => scrollTop(page)).toBe(400);

  const max = await page.evaluate(() => {
    const scroller = window.__smooth!.scroller;
    return scroller.scrollHeight - scroller.clientHeight;
  });
  const burst = await page.evaluate(() => {
    const fixture = window.__smooth!;
    return Array.from({ length: 60 }, () => fixture.scroller.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }),
    ));
  });
  expect(burst.every((prevented) => prevented === false)).toBe(true);
  await expect.poll(() => scrollTop(page)).toBe(max);

  const samples = await page.evaluate(() => window.__smooth!.samples.slice());
  expect(Math.max(...samples.map(({ top }) => top))).toBe(max);
  await page.waitForTimeout(60);

  const chained = await dispatchWheel(page, { deltaY: 100 });
  expect(chained).toBe(true);
  expect(await scrollTop(page)).toBe(max);
});

test('fractional wheel input joins pending smoothing instead of bypassing it', async ({ page }) => {
  await setup(page);

  const state = await page.evaluate(() => new Promise<{ mid: number; prevented: boolean; canceled: boolean }>((resolve) => {
    const fixture = window.__smooth!;
    const coarse = new WheelEvent('wheel', { deltaY: 600, bubbles: true, cancelable: true });
    const prevented = !fixture.scroller.dispatchEvent(coarse);
    window.setTimeout(() => {
      const mid = fixture.scroller.scrollTop;
      const precision = new WheelEvent('wheel', { deltaY: 3.5, bubbles: true, cancelable: true });
      const canceled = fixture.scroller.dispatchEvent(precision);
      resolve({ mid, prevented, canceled });
    }, 30);
  }));

  expect(state.prevented).toBe(true);
  expect(state.mid).toBeGreaterThan(0);
  expect(state.mid).toBeLessThan(600);
  expect(state.canceled).toBe(false);

  await expect.poll(async () => Math.abs((await scrollTop(page)) - 603.5)).toBeLessThanOrEqual(1);
});

test('keyboard, pointer, and destroy stop pending animation and release the wheel handler', async ({ page }) => {
  await setup(page);

  const keyboard = await page.evaluate(() => new Promise<number>((resolve) => {
    const fixture = window.__smooth!;
    fixture.scroller.scrollTop = 0;
    fixture.scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 600, bubbles: true, cancelable: true }));
    window.setTimeout(() => {
      const frozen = fixture.scroller.scrollTop;
      fixture.scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'F24', bubbles: true, cancelable: true }));
      resolve(frozen);
    }, 30);
  }));
  await page.waitForTimeout(200);
  expect(Math.abs((await scrollTop(page)) - keyboard)).toBeLessThanOrEqual(1);

  const pointer = await page.evaluate(() => new Promise<number>((resolve) => {
    const fixture = window.__smooth!;
    fixture.scroller.scrollTop = 0;
    fixture.scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 600, bubbles: true, cancelable: true }));
    window.setTimeout(() => {
      const frozen = fixture.scroller.scrollTop;
      fixture.scroller.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true, cancelable: true }));
      resolve(frozen);
    }, 30);
  }));
  await page.waitForTimeout(200);
  expect(Math.abs((await scrollTop(page)) - pointer)).toBeLessThanOrEqual(1);

  const destroyed = await page.evaluate(() => new Promise<number>((resolve) => {
    const fixture = window.__smooth!;
    fixture.scroller.scrollTop = 0;
    fixture.scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 600, bubbles: true, cancelable: true }));
    window.setTimeout(() => {
      const frozen = fixture.scroller.scrollTop;
      fixture.handle.destroy();
      resolve(frozen);
    }, 30);
  }));
  await page.waitForTimeout(200);
  expect(Math.abs((await scrollTop(page)) - destroyed)).toBeLessThanOrEqual(1);

  expect(await dispatchWheel(page, { deltaY: 300 })).toBe(true);
  await page.waitForTimeout(120);
  expect(Math.abs((await scrollTop(page)) - destroyed)).toBeLessThanOrEqual(1);
});

test('disabled, reduced motion, native owners, and sidebar panels follow their own wheel behavior', async ({ page }) => {
  await setup(page);

  await page.evaluate(() => window.__smooth!.handle.update(false));
  expect(await dispatchWheel(page, { deltaY: 300 })).toBe(true);
  await page.waitForTimeout(120);
  expect(await scrollTop(page)).toBe(0);

  await page.evaluate(() => window.__smooth!.handle.update(true));
  expect(await dispatchWheel(page, { deltaY: 300, ctrlKey: true })).toBe(true);
  expect(await dispatchWheel(page, { deltaY: 10, deltaX: 300 })).toBe(true);
  expect(await dispatchWheel(page, { deltaY: 300 }, 'input')).toBe(true);
  expect(await dispatchWheel(page, { deltaY: 300 }, 'nested')).toBe(true);
  expect(await scrollTop(page)).toBe(0);
  expect(await scrollTop(page, 'nested')).toBe(0);

  const graph = await page.evaluate(() => {
    const event = new WheelEvent('wheel', { deltaY: 300, bubbles: true, cancelable: true });
    const dispatched = window.__smooth!.graph.dispatchEvent(event);
    return { dispatched, prevented: event.defaultPrevented };
  });
  expect(graph.dispatched).toBe(false);
  expect(graph.prevented).toBe(true);
  await page.waitForTimeout(120);
  expect(await scrollTop(page)).toBe(0);

  expect(await dispatchWheel(page, { deltaY: 300 }, 'sidebar')).toBe(false);
  await expect.poll(() => scrollTop(page, 'sidebar')).toBe(300);
  expect(await scrollTop(page)).toBe(0);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(30);
  expect(await dispatchWheel(page, { deltaY: 300 })).toBe(true);
  await page.waitForTimeout(120);
  expect(await scrollTop(page)).toBe(0);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForTimeout(30);
  expect(await dispatchWheel(page, { deltaY: 200 })).toBe(false);
  await expect.poll(() => scrollTop(page)).toBe(200);
});

test('reversing the wheel immediately drops pending movement in the old direction', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const scroller = window.__smooth!.scroller;
    scroller.scrollTop = 1000;
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 600, bubbles: true, cancelable: true }));
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => scrollTop(page)).toBe(880);
});

test('a missed frame switches the rest of a wheel gesture to immediate scrolling', async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const scroller = window.__smooth!.scroller;
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }));
    // Simulate a busy main thread before the next animation frame.
    const until = performance.now() + 70;
    while (performance.now() < until) { /* bounded test workload */ }
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  await expect.poll(() => scrollTop(page)).toBe(240);
  const immediate = await page.evaluate(() => {
    const scroller = window.__smooth!.scroller;
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    return scroller.scrollTop;
  });
  expect(immediate).toBe(360);
});


test('small high-resolution wheel steps animate even over shortcut-style text inputs', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { window.__smooth!.input.type = 'text'; });
  for (const delta of [15, 15.8, 3.5]) {
    await page.evaluate(() => { window.__smooth!.scroller.scrollTop = 0; });
    expect(await dispatchWheel(page, { deltaY: delta }, 'input')).toBe(false);
    expect(await scrollTop(page)).toBeLessThan(delta - 1);
    await expect.poll(async () => Math.abs((await scrollTop(page)) - delta)).toBeLessThanOrEqual(1);
    await page.waitForTimeout(200);
  }
});
