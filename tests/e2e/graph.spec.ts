import { expect, test, type Page } from '@playwright/test';

type FixtureNode = { id: string; path: string; name: string; title: string; tags: string[] };
type FixtureEdge = { source: string; target: string; kind: string };
type Fixture = {
  nodes: FixtureNode[];
  edges: FixtureEdge[];
  unresolved: { source: string; target: string; status: string }[];
  totals: { nodes: number; edges: number; unresolved: number };
  truncated: { nodes: boolean; edges: boolean; unresolved: boolean };
};

const denseNodes: FixtureNode[] = Array.from({ length: 24 }, (_, index) => ({
  id: `note-${String(index).padStart(2, '0')}`,
  path: `/vault/a-rather-long-folder/note-${index}.md`,
  name: `note-${index}.md`,
  title: `A deliberately descriptive note title number ${index}`,
  tags: index % 3 === 0 ? ['daily'] : index % 3 === 1 ? ['research'] : [],
}));
const denseEdges: FixtureEdge[] = denseNodes.slice(1).map((node, index) => ({ source: denseNodes[index].id, target: node.id, kind: 'link' }));
denseEdges.push({ source: 'note-00', target: 'note-11', kind: 'link' }, { source: 'note-04', target: 'note-18', kind: 'link' }, { source: 'note-07', target: 'note-21', kind: 'link' });

const mixedNodes: FixtureNode[] = [
  { id: 'alpha', path: '/vault/alpha.md', name: 'alpha.md', title: 'Alpha planning note', tags: ['daily'] },
  { id: 'beta', path: '/vault/beta.md', name: 'beta.md', title: 'Beta review note', tags: ['daily'] },
  { id: 'gamma', path: '/vault/gamma.md', name: 'gamma.md', title: 'Gamma research note', tags: ['research'] },
  { id: 'delta', path: '/vault/delta.md', name: 'delta.md', title: 'Delta disconnected note', tags: [] },
];

function fixture(nodes: FixtureNode[], edges: FixtureEdge[]): Fixture {
  return {
    nodes, edges, unresolved: [],
    totals: { nodes: nodes.length, edges: edges.length, unresolved: 0 },
    truncated: { nodes: false, edges: false, unresolved: false },
  };
}

async function openGraph(page: Page, payload: Fixture) {
  await page.goto('/');
  await page.evaluate((graph) => {
    const host = window as unknown as { isTauri?: boolean; __TAURI_INTERNALS__?: unknown };
    host.isTauri = true;
    host.__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: { path?: string }) => {
        if (command === 'graph_workspace') return graph;
        if (command === 'read_document') return { path: args?.path ?? '/vault/note.md', content: '# Opened from graph\n', warning: null };
        return null;
      },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      convertFileSrc: (path: string) => path,
    };
  }, payload);
  await page.getByRole('navigation', { name: 'App sidebar' }).getByRole('button', { name: 'Note graph panel', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Note graph', exact: true })).toBeVisible();
  await expect(page.locator('.graph-viewport')).toBeVisible();
  await expect(page.locator('[data-graph-node]')).toHaveCount(payload.nodes.length);
  return page.getByRole('region', { name: 'Note graph', exact: true });
}

test('dense graph defaults to readable labels, then offers a bounded fit and 100% view', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openGraph(page, fixture(denseNodes, denseEdges));
  await expect(page.locator('.graph-panel > .panel-note').first()).toContainText('24 notes');
  const canvas = page.locator('.graph-canvas');

  const readable = await page.evaluate(() => {
    const labels = [...document.querySelectorAll<SVGTextElement>('.note-label')];
    return {
      view: document.querySelector('.graph-canvas')?.getAttribute('data-view'),
      zoom: Number(document.querySelector('.graph-canvas')?.getAttribute('data-zoom')),
      minHeight: Math.min(...labels.map((label) => label.getBoundingClientRect().height)),
    };
  });
  expect(readable.view).toBe('readable');
  expect(readable.zoom).toBeGreaterThanOrEqual(0.85);
  expect(readable.minHeight).toBeGreaterThanOrEqual(9);

  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  const fitted = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.graph-viewport')!.getBoundingClientRect();
    const nodes = [...document.querySelectorAll<SVGGElement>('[data-graph-node]')].map((element) => {
      const card = element.querySelector('.note-card')!.getBoundingClientRect();
      const text = element.querySelector('.note-label')!.getBoundingClientRect();
      return {
        id: element.dataset.graphNode,
        aria: element.getAttribute('aria-label'),
        title: element.querySelector('title')?.textContent ?? '',
        card: { left: card.left, top: card.top, right: card.right, bottom: card.bottom },
        text: { left: text.left, top: text.top, right: text.right, bottom: text.bottom },
        renderedHeight: text.height,
      };
    });
    const outside = nodes.filter((node) => node.card.left < viewport.left - 1 || node.card.top < viewport.top - 1 || node.card.right > viewport.right + 1 || node.card.bottom > viewport.bottom + 1).map((node) => node.id);
    const outsideLabels = nodes.filter((node) => node.text.left < node.card.left - 1 || node.text.top < node.card.top - 1 || node.text.right > node.card.right + 1 || node.text.bottom > node.card.bottom + 1).map((node) => node.id);
    const overlaps: string[] = [];
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        const a = nodes[left].card;
        const b = nodes[right].card;
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) overlaps.push(`${nodes[left].id}/${nodes[right].id}`);
      }
    }
    return { nodes, outside, outsideLabels, overlaps, zoom: Number(document.querySelector('.graph-canvas')?.getAttribute('data-zoom')) };
  });

  expect(fitted.nodes).toHaveLength(24);
  expect(fitted.outside).toEqual([]);
  expect(fitted.outsideLabels).toEqual([]);
  expect(fitted.overlaps).toEqual([]);
  expect(fitted.nodes[0].aria).toContain('/vault/a-rather-long-folder/');
  expect(fitted.nodes[0].title).toContain('/vault/a-rather-long-folder/');
  expect(fitted.zoom).toBeLessThanOrEqual(readable.zoom + 0.001);

  await page.getByRole('button', { name: 'Actual size graph', exact: true }).click();
  expect(Number(await canvas.getAttribute('data-zoom'))).toBe(1);
  await expect(canvas).toHaveAttribute('data-view', 'readable');
  const actualHeight = await page.locator('.note-label').first().evaluate((label) => label.getBoundingClientRect().height);
  expect(actualHeight).toBeGreaterThanOrEqual(9);
  await page.screenshot({ path: 'test-results/graph-desktop.png' });
});


test('narrow sidebar viewport defaults to readable labels, reveals focused notes and preserves view on resize', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 420 });
  await openGraph(page, fixture(denseNodes, denseEdges));
  const viewport = page.locator('.graph-viewport');
  const box = await viewport.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(120);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(480);
  expect(box!.height).toBeGreaterThanOrEqual(180);
  const documentWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
  expect(documentWidth.scroll).toBeLessThanOrEqual(documentWidth.width);

  const canvas = page.locator('.graph-canvas');
  const readableZoom = Number(await canvas.getAttribute('data-zoom'));
  await expect(canvas).toHaveAttribute('data-view', 'readable');
  expect(readableZoom).toBeGreaterThanOrEqual(0.85);
  const readableHeight = await page.evaluate(() => Math.min(...[...document.querySelectorAll<SVGTextElement>('.note-label')].map((label) => label.getBoundingClientRect().height)));
  expect(readableHeight).toBeGreaterThanOrEqual(9);
  await page.screenshot({ path: 'test-results/graph-narrow-readable.png' });

  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  const fitted = Number(await canvas.getAttribute('data-zoom'));
  expect(fitted).toBeLessThan(readableZoom);
  await expect(canvas).toHaveAttribute('data-view', 'fit');
  const outsideFit = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.graph-viewport')!.getBoundingClientRect();
    return [...document.querySelectorAll<SVGGElement>('[data-graph-node]')].filter((element) => {
      const card = element.querySelector('.note-card')!.getBoundingClientRect();
      return card.left < viewport.left - 1 || card.top < viewport.top - 1 || card.right > viewport.right + 1 || card.bottom > viewport.bottom + 1;
    }).map((element) => element.dataset.graphNode);
  });
  expect(outsideFit).toEqual([]);

  await page.getByRole('button', { name: 'Zoom in graph', exact: true }).click();
  const zoomed = Number(await canvas.getAttribute('data-zoom'));
  expect(zoomed).toBeGreaterThan(fitted);
  await expect(canvas).toHaveAttribute('data-view', 'custom');
  await viewport.scrollIntoViewIfNeeded();
  const liveBox = (await viewport.boundingBox())!;
  await page.mouse.move(liveBox.x + liveBox.width / 2, liveBox.y + liveBox.height / 2);
  await page.mouse.wheel(0, 120);
  expect(Number(await canvas.getAttribute('data-zoom'))).toBeLessThan(zoomed);

  await page.getByRole('button', { name: 'Actual size graph', exact: true }).click();
  expect(Number(await canvas.getAttribute('data-zoom'))).toBe(1);
  await expect(canvas).toHaveAttribute('data-view', 'readable');

  await viewport.scrollIntoViewIfNeeded();
  const panBox = (await viewport.boundingBox())!;
  const panBefore = Number(await canvas.getAttribute('data-pan-x'));
  await page.mouse.move(panBox.x + 5, panBox.y + 5);
  await page.mouse.down();
  await page.mouse.move(panBox.x + 45, panBox.y + 35, { steps: 5 });
  await page.mouse.up();
  expect(Number(await canvas.getAttribute('data-pan-x'))).not.toBe(panBefore);
  await expect(canvas).toHaveAttribute('data-view', 'custom');

  const last = page.locator('[data-graph-node]').last();
  const lastId = await last.getAttribute('data-graph-node');
  const inside = () => page.evaluate((id) => {
    const element = document.querySelector<SVGGElement>(`[data-graph-node="${id}"]`)!;
    const viewport = document.querySelector<HTMLElement>('.graph-viewport')!.getBoundingClientRect();
    const card = element.querySelector('.note-card')!.getBoundingClientRect();
    return card.left >= viewport.left - 1 && card.top >= viewport.top - 1 && card.right <= viewport.right + 1 && card.bottom <= viewport.bottom + 1;
  }, lastId);
  expect(await inside()).toBe(false);
  await last.focus();
  await expect(last).toBeFocused();
  expect(await inside()).toBe(true);
  const cameraBeforeOpen = [await canvas.getAttribute('data-pan-x'), await canvas.getAttribute('data-pan-y'), await canvas.getAttribute('data-zoom')];
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'note-23.md', exact: true })).toBeVisible();
  expect([await canvas.getAttribute('data-pan-x'), await canvas.getAttribute('data-pan-y'), await canvas.getAttribute('data-zoom')]).toEqual(cameraBeforeOpen);

  const zoomBeforeResize = await canvas.getAttribute('data-zoom');
  const viewBeforeResize = await canvas.getAttribute('data-view');
  await page.setViewportSize({ width: 640, height: 520 });
  await expect.poll(() => page.evaluate(() => document.querySelector('.graph-viewport')!.clientWidth)).toBeGreaterThan(0);
  expect(await canvas.getAttribute('data-zoom')).toBe(zoomBeforeResize);
  expect(await canvas.getAttribute('data-view')).toBe(viewBeforeResize);
  expect(await inside()).toBe(true);
});


test('filters, full accessible labels and keyboard activation are preserved', async ({ page }) => {
  await openGraph(page, fixture(mixedNodes, [{ source: 'alpha', target: 'beta', kind: 'link' }, { source: 'beta', target: 'gamma', kind: 'link' }]));
  const graphFilter = page.getByRole('textbox', { name: 'Graph filter', exact: true });
  const tagFilter = page.getByRole('textbox', { name: 'Graph tag filter', exact: true });
  const graphNodes = page.locator('[data-graph-node]');

  await graphFilter.fill('alpha');
  await expect(graphNodes).toHaveCount(1);
  await expect(page.locator('.graph-panel > .panel-note').first()).toContainText('1 notes');
  await page.getByRole('button', { name: 'Clear graph filters', exact: true }).click();
  await expect(graphNodes).toHaveCount(4);

  await tagFilter.fill('daily');
  await expect(graphNodes).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear graph filters', exact: true }).click();
  await expect(graphNodes).toHaveCount(4);

  const alpha = page.locator('[data-graph-node][data-node-path="/vault/alpha.md"]');
  await expect(alpha).toHaveAttribute('aria-label', /Alpha planning note.*\/vault\/alpha\.md/u);
  await alpha.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'alpha.md', exact: true })).toBeVisible();
  await expect(alpha).toHaveClass(/current/u);

  const beta = page.locator('[data-graph-node][data-node-path="/vault/beta.md"]');
  await beta.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('tab', { name: 'beta.md', exact: true })).toBeVisible();
});

test('a graph that fits is fully framed even when the current note is at an edge', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openGraph(page, fixture(mixedNodes, [{ source: 'alpha', target: 'beta', kind: 'link' }]));
  await page.locator('[data-graph-node="alpha"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: /alpha.md/ })).toBeVisible();
  await page.getByRole('button', { name: 'Close graph', exact: true }).click();
  await page.getByRole('button', { name: 'Note graph panel', exact: true }).click();
  await expect(page.locator('[data-graph-node]')).toHaveCount(4);
  await expect.poll(() => page.evaluate(() => {
    const viewport = document.querySelector('.graph-viewport')!.getBoundingClientRect();
    return [...document.querySelectorAll('.note-card')].every(element => {
      const r = element.getBoundingClientRect();
      return r.left >= viewport.left && r.right <= viewport.right && r.top >= viewport.top && r.bottom <= viewport.bottom;
    });
  })).toBe(true);
});
