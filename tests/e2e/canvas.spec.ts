import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { nextTabKey, previousTabKey, runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const canvas = (page: Page) => page.getByRole('region', { name: 'Canvas', exact: true });
const boardOf = (view: Locator) => view.getByRole('application', { name: 'Canvas board', exact: true });
const inspectorOf = (view: Locator) => view.getByRole('complementary', { name: 'Canvas inspector', exact: true });

async function addCanvasCard(view: ReturnType<typeof canvas>, action: string) {
  await view.getByRole('button', { name: 'Add card', exact: true }).click();
  await view.getByRole('menu', { name: 'Add card', exact: true }).getByRole('menuitem', { name: action, exact: true }).click();
}

async function exportCanvas(page: Page) {
  const pending = page.waitForEvent('download');
  await runCommand(page, 'Save');
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error('Canvas export did not provide a file.');
  return readFile(path, 'utf8');
}

type CanvasJSON = {
  nodes: { id: string; type: string; x: number; y: number; width: number; height: number; text?: string; file?: string; label?: string; color?: string; extension?: unknown }[];
  edges: { id: string; fromNode: string; toNode: string; fromSide?: string; toSide?: string; label?: string; future?: unknown }[];
  [key: string]: unknown;
};

async function canvasData(page: Page) {
  return JSON.parse(await exportCanvas(page)) as CanvasJSON;
}

function card(view: ReturnType<typeof canvas>, name: string) {
  return view.getByRole('article', { name: 'Canvas card: ' + name, exact: true });
}

/** Open a canvas file. Test boards are small enough to open at 100%, so screen pixels are document units. */
async function openCanvas(page: Page, value: unknown, name = 'board.canvas', fits = true) {
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(boardOf(canvas(page))).toBeVisible();
  if (fits) await expect(canvas(page).locator('.canvas-zoom')).toHaveText('100%');
}

const text = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({ id, type: 'text', x, y, width: 200, height: 120, text: id, ...extra });

async function center(target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error('Target has no box.');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function startDrag(page: Page, target: Locator, x: number, y: number) {
  const from = await center(target);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + x, from.y + y, { steps: 8 });
}

async function drag(page: Page, target: Locator, x: number, y: number) {
  await startDrag(page, target, x, y);
  await page.mouse.up();
}

async function undo(page: Page, view: Locator, redo = false) {
  await boardOf(view).focus();
  await page.keyboard.press(redo ? 'ControlOrMeta+Shift+z' : 'ControlOrMeta+z');
}

const selectedIds = (view: Locator) => view.locator('.svelte-flow__node.selected').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-id')).sort());

/** Draw a selection box from just outside one corner of `from` to just outside the far corner of `to`. */
async function boxAround(page: Page, from: Locator, to: Locator = from) {
  const first = (await from.boundingBox())!, last = (await to.boundingBox())!;
  await page.mouse.move(first.x - 18, first.y - 18);
  await page.mouse.down();
  await page.mouse.move(first.x + 30, first.y + 30, { steps: 3 });
  await page.mouse.move(last.x + last.width + 18, last.y + last.height + 18, { steps: 5 });
}

/** Count changes to the document from now on: every write the canvas makes is a transaction on the source editor. */
async function trackWrites(page: Page) {
  await page.locator('.editor-tab-host:not([hidden]) .cm-content').evaluate((element) => {
    type View = { state: { doc: { toString(): string } }; dispatch: (...specs: unknown[]) => void };
    const editor = (element as unknown as { cmTile: { root: { view: View } } }).cmTile.root.view, dispatch = editor.dispatch.bind(editor);
    const counter = window as unknown as { canvasWrites: number };
    counter.canvasWrites = 0;
    editor.dispatch = (...specs) => { const before = editor.state.doc.toString(); dispatch(...specs); if (editor.state.doc.toString() !== before) counter.canvasWrites++; };
  });
  return () => page.evaluate(() => (window as unknown as { canvasWrites: number }).canvasWrites);
}

const edgeStart = (view: Locator, id: string) => view.locator('.svelte-flow__edge[data-id="' + id + '"] .svelte-flow__edge-path').evaluate((path) => { const [x, y] = path.getAttribute('d')!.slice(1).split(/[ C]/u)[0].split(',').map(Number); return { x, y }; });

/** Snap is on by default; exact pixel assertions turn it off. */
async function snapOff(view: Locator) {
  const toggle = view.getByRole('button', { name: 'Snap', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('canvas cards and labeled connections serialize and undo independently', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  await expect(boardOf(view)).toBeVisible();
  await addCanvasCard(view, 'Add text card');
  const research = card(view, 'New card');
  await expect(research).toBeVisible();
  // Text is edited in place; the details panel keeps the label.
  await research.dblclick();
  const editor = view.getByRole('textbox', { name: 'Card text: New card', exact: true });
  await expect(editor).toBeFocused();
  await editor.fill('# Research notes\n\nKeep the source editable.');
  await page.keyboard.press('Escape');
  await expect(card(view, 'Research notes')).toBeVisible();
  await card(view, 'Research notes').getByRole('button', { name: 'Edit card: Research notes', exact: true }).click();
  const inspector = inspectorOf(view);
  await inspector.getByRole('textbox', { name: 'Card label', exact: true }).fill('Research');
  await inspector.getByRole('button', { name: 'Apply card', exact: true }).click();
  await expect(card(view, 'Research')).toBeVisible();

  await addCanvasCard(view, 'Add note card');
  await expect(card(view, 'Note')).toBeVisible();
  await view.getByRole('button', { name: 'Connect cards', exact: true }).click();
  await inspector.getByRole('combobox', { name: 'From card', exact: true }).selectOption({ label: 'Research' });
  await inspector.getByRole('combobox', { name: 'To card', exact: true }).selectOption({ label: 'Note' });
  await inspector.getByRole('textbox', { name: 'Connection label', exact: true }).fill('supports');
  await inspector.getByRole('button', { name: 'Add connection', exact: true }).click();
  await expect(view.getByRole('status')).toContainText('Canvas updated');

  const serialized = await canvasData(page);
  expect(serialized.nodes).toHaveLength(2);
  expect(serialized.nodes.find(node => node.label === 'Research')?.text).toBe('# Research notes\n\nKeep the source editable.');
  expect(serialized.edges).toHaveLength(1);
  // No side is recorded: the connection follows the cards wherever they go.
  expect(serialized.edges[0]).toMatchObject({ label: 'supports' });
  expect(serialized.edges[0].fromSide).toBeUndefined();
  expect(serialized.edges[0].toSide).toBeUndefined();

  await undo(page, view);
  const afterUndo = await canvasData(page);
  expect(afterUndo.nodes).toHaveLength(2);
  expect(afterUndo.edges).toHaveLength(0);
});

test('invalid canvas JSON is preserved and offers Source repair', async ({ page }) => {
  const invalid = '{"nodes":[{"id":"duplicate","type":"text","x":0,"y":0,"width":200,"height":100,"text":"one"},{"id":"duplicate","type":"text","x":0,"y":0,"width":200,"height":100,"text":"two"}],"edges":[]}';
  await page.locator('input[type=file]').setInputFiles({ name: 'invalid.canvas', mimeType: 'application/json', buffer: Buffer.from(invalid) });
  await expect(page.getByRole('tab', { name: 'invalid.canvas', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(canvas(page).getByRole('alert')).toContainText(/unique/i);
  await expect(canvas(page).getByRole('button', { name: 'Add card', exact: true })).toBeDisabled();
  expect(await exportCanvas(page)).toBe(invalid);
});

test('a card drags from its body at 100% and 120% with one-step undo and redo', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  await snapOff(view);
  await addCanvasCard(view, 'Add text card');
  await expect(card(view, 'New card')).toBeVisible();
  const start = (await canvasData(page)).nodes[0];

  await drag(page, card(view, 'New card'), 64, 48);
  await expect(view.getByRole('status')).toContainText('Canvas updated');
  let data = await canvasData(page);
  expect(data.nodes[0]).toMatchObject({ x: start.x + 64, y: start.y + 48 });
  const moved = data.nodes[0];

  await undo(page, view);
  expect((await canvasData(page)).nodes[0]).toMatchObject({ x: start.x, y: start.y });
  await undo(page, view, true);
  expect((await canvasData(page)).nodes[0]).toMatchObject({ x: moved.x, y: moved.y });

  await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(view.locator('.canvas-zoom')).toHaveText('120%');
  await drag(page, card(view, 'New card'), 60, 36);
  data = await canvasData(page);
  expect(data.nodes[0]).toMatchObject({ x: moved.x + 50, y: moved.y + 30 });
});

test('snap keeps dragged cards on the grid and shows alignment guides', async ({ page }) => {
  await openCanvas(page, { nodes: [text('a', 0, 0), text('b', 300, 207)], edges: [] });
  const view = canvas(page);
  await drag(page, card(view, 'b'), 33, 51);
  let data = await canvasData(page);
  expect(data.nodes[1].x % 20).toBe(0);
  expect(data.nodes[1].y % 20).toBe(0);

  // Without the grid, a card released within a few pixels of another card's edge lines up with it.
  await view.getByRole('button', { name: 'Snap', exact: true }).click();
  const before = (await canvasData(page)).nodes[1];
  await startDrag(page, card(view, 'b'), 0, -before.y + 3);
  await expect(view.locator('.canvas-guide.horizontal')).toHaveCount(1);
  await page.mouse.up();
  await expect(view.locator('.canvas-guide')).toHaveCount(0);
  data = await canvasData(page);
  expect(data.nodes[1].y).toBe(0);
});

test('Ctrl+wheel zooms around the cursor and the buttons zoom around the board centre', async ({ page }) => {
  await openCanvas(page, { nodes: [text('a', 0, 0), text('b', 400, 260)], edges: [] });
  const view = canvas(page), board = boardOf(view), zoom = view.locator('.canvas-zoom');
  await expect(zoom).toHaveText('100%');
  const before = (await card(view, 'b').boundingBox())!;
  // Park the cursor on card b's corner: that corner must not move while zooming.
  await page.mouse.move(before.x, before.y);
  await page.keyboard.down('Control');
  for (let step = 0; step < 4; step++) await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await expect(zoom).toHaveText('146%');
  let after = (await card(view, 'b').boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  expect(after.width).toBeCloseTo(before.width * 1.1 ** 4, 0);

  // A plain wheel pans and leaves the zoom alone.
  await page.mouse.wheel(30, 50);
  await expect(zoom).toHaveText('146%');
  // Holding Ctrl without the wheel event carrying it (some drivers and remote desktops do this) still only pans.
  await page.keyboard.down('Control');
  await board.evaluate((element) => element.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, deltaX: -30, bubbles: true, cancelable: true })));
  await page.keyboard.up('Control');
  await expect(zoom).toHaveText('146%');
  await page.mouse.wheel(30, 50);
  after = (await card(view, 'b').boundingBox())!;
  expect(after.x).toBeCloseTo(before.x - 30, 0);
  expect(after.y).toBeCloseTo(before.y - 50, 0);

  // Devices that report lines instead of pixels pan by whole lines, and Shift turns a one-axis wheel sideways.
  const wheelOn = (init: WheelEventInit) => board.evaluate((element, options) => { element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...options })); }, init);
  let here = (await card(view, 'b').boundingBox())!;
  await wheelOn({ deltaY: 3, deltaMode: 1 });
  expect((await card(view, 'b').boundingBox())!.y).toBeCloseTo(here.y - 48, 0);
  await wheelOn({ deltaY: -3, deltaMode: 1 });
  await wheelOn({ deltaY: 100, shiftKey: true });
  here = (await card(view, 'b').boundingBox())!;
  expect(here.x).toBeCloseTo(before.x - 30 - 100, 0);
  expect(here.y).toBeCloseTo(before.y - 50, 0);
  await wheelOn({ deltaY: -100, shiftKey: true });
  await expect(zoom).toHaveText('146%');

  // Buttons keep the document point at the board centre fixed.
  const frame = (await board.boundingBox())!, middle = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  const offset = (box: { x: number; y: number }, scale: number) => ({ x: (box.x - middle.x) / scale, y: (box.y - middle.y) / scale });
  const scale = async () => (await card(view, 'b').boundingBox())!.width / 200;
  const from = offset((await card(view, 'b').boundingBox())!, await scale());
  await view.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect(zoom).toHaveText('122%');
  await expect.poll(scale).toBeCloseTo(1.1 ** 4 / 1.2, 3);
  const to = offset((await card(view, 'b').boundingBox())!, await scale());
  expect(to.x).toBeCloseTo(from.x, 0);
  expect(to.y).toBeCloseTo(from.y, 0);

  await view.getByRole('button', { name: 'Fit canvas', exact: true }).click();
  await expect(zoom).toHaveText('100%');
});

test('resize handles preview, clamp to the minimum size and commit once', async ({ page }) => {
  await openCanvas(page, { nodes: [text('a', 0, 0, { width: 280, height: 180 })], edges: [] });
  const view = canvas(page);
  await snapOff(view);
  await card(view, 'a').click();
  const corner = card(view, 'a').locator('.svelte-flow__resize-control.handle.bottom.right');
  await expect(corner).toBeVisible();
  await drag(page, corner, 40, 30);
  let data = await canvasData(page);
  expect(data.nodes[0]).toMatchObject({ x: 0, y: 0, width: 320, height: 210 });

  await drag(page, card(view, 'a').locator('.svelte-flow__resize-control.handle.bottom.right'), -600, -600);
  data = await canvasData(page);
  expect(data.nodes[0]).toMatchObject({ x: 0, y: 0, width: 120, height: 80 });

  // Each resize is one undo step.
  await undo(page, view);
  expect((await canvasData(page)).nodes[0]).toMatchObject({ width: 320, height: 210 });
  await undo(page, view);
  expect((await canvasData(page)).nodes[0]).toMatchObject({ width: 280, height: 180 });
});

test('double-click edits a card in place; Escape and clicking away both commit as one undo step', async ({ page }) => {
  await openCanvas(page, { nodes: [text('a', 0, 0, { text: '# Alpha' }), text('b', 300, 0)], edges: [] });
  const view = canvas(page);
  await expect(card(view, 'Alpha').locator('h1')).toHaveText('Alpha');
  await card(view, 'Alpha').dblclick();
  let editor = view.getByRole('textbox', { name: 'Card text: Alpha', exact: true });
  await expect(editor).toBeFocused();
  // The editor shows the Markdown source, not the rendered card.
  await expect(editor).toHaveValue('# Alpha');
  await expect(card(view, 'Alpha').locator('h1')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('# Beta\n\nbody');
  // Arrow keys and Delete belong to the editor while it is open.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(card(view, 'Beta').locator('h1')).toHaveText('Beta');
  let data = await canvasData(page);
  expect(data.nodes[0]).toMatchObject({ text: '# Beta\n\nbod', x: 0, y: 0 });

  await card(view, 'b').dblclick();
  editor = view.getByRole('textbox', { name: 'Card text: b', exact: true });
  await editor.fill('sec');
  // A shortcut (Save, close tab) starts with Ctrl/Cmd going down: the draft is written then, and editing continues.
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.up('ControlOrMeta');
  // The card's name follows its text, so find the open editor by its role in the card.
  editor = view.locator('.canvas-inline-editor');
  await expect(editor).toBeFocused();
  expect(await page.locator('.editor-tab-host:not([hidden]) .cm-content').evaluate((element) => JSON.parse((element as unknown as { cmTile: { root: { view: { state: { doc: { toString(): string } } } } } }).cmTile.root.view.state.doc.toString()).nodes[1].text)).toBe('sec');
  await page.keyboard.type('ond');
  const frame = (await boardOf(view).boundingBox())!;
  await page.mouse.click(frame.x + 12, frame.y + frame.height - 12);
  await expect(editor).toHaveCount(0);
  data = await canvasData(page);
  expect(data.nodes[1].text).toBe('second');

  await undo(page, view);
  expect((await canvasData(page)).nodes[1].text).toBe('sec');
  await undo(page, view);
  data = await canvasData(page);
  expect(data.nodes.map((node) => node.text)).toEqual(['# Beta\n\nbod', 'b']);
  await undo(page, view);
  expect((await canvasData(page)).nodes[0].text).toBe('# Alpha');

  // An edit that changes nothing writes nothing.
  await card(view, 'Alpha').dblclick();
  await page.keyboard.press('Escape');
  await undo(page, view, true);
  expect((await canvasData(page)).nodes[0].text).toBe('# Beta\n\nbod');
});

test('double-clicking empty space creates a text card there and starts editing it', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page), frame = (await boardOf(view).boundingBox())!;
  await snapOff(view);
  await page.mouse.dblclick(frame.x + 300, frame.y + 200);
  const editor = view.getByRole('textbox', { name: 'Card text: Empty card', exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.type('Idea');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(card(view, 'Idea')).toBeVisible();
  const data = await canvasData(page);
  expect(data.nodes).toHaveLength(1);
  // The card is centred on the click (new canvases start at 100% with no pan).
  expect(data.nodes[0]).toMatchObject({ type: 'text', text: 'Idea', x: 300 - 140, y: 200 - 90, width: 280, height: 180 });
});

test('Shift and Ctrl clicks and the selection box select exactly what they touch, every time', async ({ page }) => {
  await openCanvas(page, { nodes: [text('a', 0, 0), text('b', 260, 0), text('c', 0, 250)], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }] });
  const view = canvas(page), frame = (await boardOf(view).boundingBox())!, original = await exportCanvas(page);
  const empty = () => page.mouse.click(frame.x + frame.width - 30, frame.y + frame.height - 30);
  await snapOff(view);

  // A click selects one card; Shift or Ctrl/Cmd adds one, and takes it away again.
  await card(view, 'a').click();
  expect(await selectedIds(view)).toEqual(['a']);
  await card(view, 'b').click({ modifiers: ['Shift'] });
  expect(await selectedIds(view)).toEqual(['a', 'b']);
  await card(view, 'b').click({ modifiers: ['Shift'] });
  expect(await selectedIds(view)).toEqual(['a']);
  await card(view, 'c').click({ modifiers: ['ControlOrMeta'] });
  expect(await selectedIds(view)).toEqual(['a', 'c']);
  await card(view, 'b').click();
  expect(await selectedIds(view)).toEqual(['b']);

  // Shift+drag on empty space draws a box and adds what it touches; cards already selected stay selected.
  await page.keyboard.down('Shift');
  await boxAround(page, card(view, 'c'));
  await expect(view.locator('.canvas-marquee')).toBeVisible();
  expect(await selectedIds(view)).toEqual(['b', 'c']);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(view.locator('.canvas-marquee')).toHaveCount(0);
  expect(await selectedIds(view)).toEqual(['b', 'c']);
  // A Shift+click on empty space is not a box and clears nothing; a plain click on empty space clears.
  await page.keyboard.down('Shift');
  await empty();
  await page.keyboard.up('Shift');
  expect(await selectedIds(view)).toEqual(['b', 'c']);
  await empty();
  expect(await selectedIds(view)).toEqual([]);

  // The Select tool makes a plain drag a box. The same box drawn again selects the same cards again,
  // and a box over cards that are already selected keeps them.
  await view.getByRole('button', { name: 'Select', exact: true }).click();
  for (let round = 0; round < 3; round++) {
    await boxAround(page, card(view, 'a'));
    await page.mouse.up();
    expect(await selectedIds(view)).toEqual(['a']);
    if (round === 0) await empty();
  }
  expect(await selectedIds(view)).toEqual(['a']);
  await boxAround(page, card(view, 'a'), card(view, 'b'));
  await page.mouse.up();
  expect(await selectedIds(view)).toEqual(['a', 'b']);
  // A new plain box replaces the selection; with the Select tool a click on empty space clears it.
  await boxAround(page, card(view, 'c'));
  await page.mouse.up();
  expect(await selectedIds(view)).toEqual(['c']);
  await empty();
  expect(await selectedIds(view)).toEqual([]);
  await view.getByRole('button', { name: 'Select', exact: true }).click();
  // Selecting never writes to the document.
  expect(await exportCanvas(page)).toBe(original);

  // Any selected card drags the whole selection: one change, one undo step.
  await card(view, 'a').click();
  await card(view, 'b').click({ modifiers: ['Shift'] });
  await drag(page, card(view, 'b'), 50, 70);
  let data = await canvasData(page);
  expect(data.nodes.map((node) => [node.x, node.y])).toEqual([[50, 70], [310, 70], [0, 250]]);
  await undo(page, view);
  data = await canvasData(page);
  expect(data.nodes.map((node) => [node.x, node.y])).toEqual([[0, 0], [260, 0], [0, 250]]);
  // Select all takes every card; Delete then removes them with their connections.
  await boardOf(view).focus();
  await page.keyboard.press('ControlOrMeta+a');
  expect(await selectedIds(view)).toEqual(['a', 'b', 'c']);
});

test('Shift+drag inside a group draws a selection box instead of dragging the group', async ({ page }) => {
  await openCanvas(page, { nodes: [{ id: 'g', type: 'group', label: 'Group', x: -40, y: -60, width: 560, height: 240 }, text('a', 0, 0), text('b', 260, 0), text('c', 0, 260)], edges: [] });
  const view = canvas(page), original = await exportCanvas(page), writes = await trackWrites(page);
  await snapOff(view);
  const group = (await card(view, 'Group').boundingBox())!;
  await page.keyboard.down('Shift');
  // The press lands on the group's own surface, between its heading and card a.
  await page.mouse.move(group.x + 12, group.y + 36);
  await page.mouse.down();
  await page.mouse.move(group.x + 180, group.y + 150, { steps: 5 });
  await expect(view.locator('.canvas-marquee')).toBeVisible();
  await page.mouse.up();
  // The box touches the group and card a; nothing moved.
  expect(await selectedIds(view)).toEqual(['a', 'g']);
  expect(await writes()).toBe(0);
  // Shift+click on the group's surface takes just the group out again, and puts it back.
  await page.mouse.click(group.x + 12, group.y + group.height - 12);
  expect(await selectedIds(view)).toEqual(['a']);
  await page.mouse.click(group.x + 12, group.y + group.height - 12);
  expect(await selectedIds(view)).toEqual(['a', 'g']);
  await page.keyboard.up('Shift');
  expect(await exportCanvas(page)).toBe(original);
  // Without Shift the same press drags the group and the cards inside it.
  await page.mouse.move(group.x + 12, group.y + group.height - 12);
  await page.mouse.down();
  await page.mouse.move(group.x + 52, group.y + group.height + 18, { steps: 5 });
  await page.mouse.up();
  const data = await canvasData(page);
  expect(data.nodes.map((node) => [node.id, node.x, node.y])).toEqual([['g', 0, -30], ['a', 40, 30], ['b', 300, 30], ['c', 0, 260]]);
});

test('arrow-key nudges coalesce into one undo step and Alt+arrows resize', async ({ page }) => {
  await openCanvas(page, { nodes: [text('a', 0, 0), text('b', 300, 0)], edges: [] });
  const view = canvas(page);
  await snapOff(view);
  await card(view, 'a').click();
  for (let step = 0; step < 5; step++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  // The flow shows the move at once; the document receives it as a single change.
  await expect(view.getByRole('status')).toContainText('Canvas updated');
  let data = await canvasData(page);
  expect(data.nodes[0]).toMatchObject({ x: 5, y: 10 });
  await undo(page, view);
  data = await canvasData(page);
  expect(data.nodes[0]).toMatchObject({ x: 0, y: 0 });
  await undo(page, view, true);
  expect((await canvasData(page)).nodes[0]).toMatchObject({ x: 5, y: 10 });

  await card(view, 'a').click();
  await page.keyboard.press('Alt+ArrowRight');
  await page.keyboard.press('Alt+ArrowRight');
  await page.keyboard.press('Alt+Shift+ArrowDown');
  // Saving flushes a pending nudge instead of losing it.
  data = await canvasData(page);
  expect(data.nodes[0]).toMatchObject({ x: 5, y: 10, width: 202, height: 130 });
  await undo(page, view);
  expect((await canvasData(page)).nodes[0]).toMatchObject({ width: 200, height: 120 });
});

test('dragging from a side dot connects cards, records only deliberate sides, and can create a card', async ({ page }) => {
  await openCanvas(page, { nodes: [text('a', 0, 0), text('b', 400, 0), text('c', 0, 300)], edges: [] });
  const view = canvas(page);
  await snapOff(view);
  const handle = (name: string, side: string) => card(view, name).locator('.svelte-flow__handle-' + side);
  const pull = async (from: { x: number; y: number }, via: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(via.x, via.y, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
  };
  // Dot to the facing dot: that is what the canvas would pick anyway, so no side is recorded.
  let from = await center(handle('a', 'right')), to = await center(handle('b', 'left'));
  await pull(from, { x: (from.x + to.x) / 2, y: from.y + 10 }, to);
  await expect(view.locator('.svelte-flow__edge')).toHaveCount(1);
  let data = await canvasData(page);
  expect(data.edges).toHaveLength(1);
  expect(data.edges[0]).toEqual({ id: data.edges[0].id, fromNode: 'a', toNode: 'b' });

  // Top dot to top dot is a deliberate choice: both sides are kept.
  from = await center(handle('a', 'top'));
  to = await center(handle('b', 'top'));
  await pull(from, { x: from.x + 40, y: from.y - 40 }, to);
  await expect(view.locator('.svelte-flow__edge')).toHaveCount(2);
  data = await canvasData(page);
  expect(data.edges[1]).toMatchObject({ fromNode: 'a', fromSide: 'top', toNode: 'b', toSide: 'top' });

  // Dropped on a card body: joined, with nothing recorded when the dot used is the facing one.
  from = await center(handle('a', 'bottom'));
  const body = (await card(view, 'c').boundingBox())!;
  await pull(from, { x: from.x + 5, y: from.y + 60 }, { x: body.x + body.width / 2, y: body.y + 60 });
  await expect(view.locator('.svelte-flow__edge')).toHaveCount(3);
  data = await canvasData(page);
  expect(data.edges[2]).toEqual({ id: data.edges[2].id, fromNode: 'a', toNode: 'c' });

  // Dropped on empty space: a new card appears there, connected and ready to type into.
  from = await center(handle('b', 'bottom'));
  await pull(from, { x: from.x + 10, y: from.y + 80 }, { x: from.x + 20, y: from.y + 160 });
  const editor = view.getByRole('textbox', { name: 'Card text: Empty card', exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.type('Follow-up');
  await page.keyboard.press('Escape');
  data = await canvasData(page);
  expect(data.nodes).toHaveLength(4);
  const added = data.nodes[3];
  expect(added).toMatchObject({ type: 'text', text: 'Follow-up' });
  expect(data.edges[3]).toEqual({ id: data.edges[3].id, fromNode: 'b', toNode: added.id });
  // The new card hangs from the drop point by the middle of its top edge.
  expect(added.x + added.width / 2).toBeCloseTo(400 + 100 + 20, -1);
  expect(added.y).toBeCloseTo(120 + 160, -1);

  // Card and connection were one change.
  await undo(page, view);
  await undo(page, view);
  data = await canvasData(page);
  expect(data.nodes).toHaveLength(3);
  expect(data.edges).toHaveLength(3);

  // A connection to the same card is refused.
  from = await center(handle('c', 'right'));
  to = await center(handle('c', 'bottom'));
  await pull(from, { x: to.x + 30, y: to.y - 30 }, to);
  expect((await canvasData(page)).edges).toHaveLength(3);
});

test('either end of a connection can be dragged to another card or side; empty space cancels', async ({ page }) => {
  const edge = { id: 'ab', fromNode: 'a', toNode: 'b', label: 'link', future: 'kept' };
  await openCanvas(page, { nodes: [text('a', 0, 0), text('b', 400, 0), text('c', 400, 260), text('d', 0, 260)], edges: [edge] });
  const view = canvas(page), writes = await trackWrites(page);
  await snapOff(view);
  const end = (which: 'source' | 'target') => view.locator('.canvas-edge-end.svelte-flow__edgeupdater-' + which);
  const moveEnd = async (which: 'source' | 'target', to: { x: number; y: number }) => {
    // A selected connection shows a grip at each end.
    if (!(await end(which).count())) await view.locator('.canvas-edge-label').click();
    await expect(end('source')).toBeVisible();
    await expect(end('target')).toBeVisible();
    const from = await center(end(which));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y + 30, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
  };
  const bodyOf = async (name: string) => center(card(view, name));

  // Target end dropped on another card's body.
  await moveEnd('target', await bodyOf('c'));
  let data = await canvasData(page);
  expect(data.edges).toEqual([{ ...edge, toNode: 'c' }]);
  expect(await writes()).toBe(1);
  await undo(page, view);
  expect((await canvasData(page)).edges).toEqual([edge]);

  // Dropped on a particular dot that the canvas would not have chosen: that side is kept.
  await moveEnd('target', await center(card(view, 'c').locator('.svelte-flow__handle-top')));
  data = await canvasData(page);
  expect(data.edges).toEqual([{ ...edge, toNode: 'c', toSide: 'top' }]);

  // Source end to another card; the target's recorded side is untouched.
  await moveEnd('source', await bodyOf('d'));
  data = await canvasData(page);
  expect(data.edges).toEqual([{ ...edge, fromNode: 'd', toNode: 'c', toSide: 'top' }]);

  // Dropped on empty space, on its own other end, or cancelled with Escape: nothing changes and nothing is written.
  const before = await writes(), frame = (await boardOf(view).boundingBox())!;
  await moveEnd('source', { x: frame.x + frame.width - 40, y: frame.y + 40 });
  await moveEnd('source', await bodyOf('c'));
  await view.locator('.canvas-edge-label').click();
  const grip = await center(end('target')), other = await bodyOf('a');
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(other.x, other.y, { steps: 6 });
  await expect(view.locator('.svelte-flow__connectionline')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(view.locator('.svelte-flow__connectionline')).toHaveCount(0);
  await page.mouse.up();
  expect(await writes()).toBe(before);
  expect((await canvasData(page)).edges).toEqual([{ ...edge, fromNode: 'd', toNode: 'c', toSide: 'top' }]);
  await expect(view.locator('.svelte-flow__edge')).toHaveCount(1);
});

test('a board whose connections were all written right to left offers one click to fix them and never changes on its own', async ({ page }) => {
  const doc = { nodes: [text('a', 0, 0), text('b', -400, 0), text('c', 0, 300)], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left', future: 'kept' }, { id: 'ac', fromNode: 'a', toNode: 'c', fromSide: 'right', toSide: 'left', label: 'down' }] };
  await openCanvas(page, doc);
  const view = canvas(page), hint = view.getByRole('note', { name: 'Connection sides', exact: true }), original = await exportCanvas(page);
  // Opened as written: the arrow to the card on the left still leaves from the right, and the file is untouched.
  await expect(hint).toContainText('earlier versions of Notation');
  expect((await edgeStart(view, 'ab')).x).toBeGreaterThan(190);
  expect(JSON.parse(original)).toEqual(doc);
  // The hint does not block the board.
  await drag(page, card(view, 'c'), 20, 20);
  await undo(page, view);
  expect(await exportCanvas(page)).toBe(original);

  await hint.getByRole('button', { name: 'Choose sides automatically', exact: true }).click();
  await expect(hint).toHaveCount(0);
  await expect(view.getByRole('status')).toContainText('2 connections now choose their sides automatically');
  let data = await canvasData(page);
  expect(data.edges).toEqual([{ id: 'ab', fromNode: 'a', toNode: 'b', future: 'kept' }, { id: 'ac', fromNode: 'a', toNode: 'c', label: 'down' }]);
  expect((await edgeStart(view, 'ab')).x).toBeLessThan(10);
  expect((await edgeStart(view, 'ac')).y).toBeGreaterThan(110);
  // One undo step puts every side back, and the hint with it.
  await undo(page, view);
  expect(await exportCanvas(page)).toBe(original);
  await expect(hint).toBeVisible();

  // Dismissed, it stays away for this document; the command and the board menu still do the job.
  await hint.getByRole('button', { name: 'Dismiss hint', exact: true }).click();
  await expect(hint).toHaveCount(0);
  await runCommand(page, 'Choose connection sides automatically');
  data = await canvasData(page);
  expect(data.edges.some((edge) => edge.fromSide || edge.toSide)).toBe(false);
  await undo(page, view);
  await expect(hint).toHaveCount(0);
  const frame = (await boardOf(view).boundingBox())!;
  await page.mouse.click(frame.x + frame.width - 60, frame.y + 60, { button: 'right' });
  const item = view.getByRole('menuitem', { name: 'Choose sides automatically for all connections', exact: true });
  await item.click();
  expect((await canvasData(page)).edges.some((edge) => edge.fromSide || edge.toSide)).toBe(false);
  // With nothing recorded there is nothing to do: the menu item is disabled and the command writes nothing.
  const writes = await trackWrites(page);
  await page.mouse.click(frame.x + frame.width - 60, frame.y + 60, { button: 'right' });
  await expect(item).toBeDisabled();
  await page.keyboard.press('Escape');
  await runCommand(page, 'Choose connection sides automatically');
  await expect(view.getByRole('status')).toContainText('already chooses its sides automatically');
  expect(await writes()).toBe(0);

  // A connection's own menu keeps the sides it is drawn with, or frees them again.
  await view.locator('.canvas-edge-label').click({ button: 'right' });
  await view.getByRole('menuitem', { name: 'Keep these sides', exact: true }).click();
  expect((await canvasData(page)).edges[1]).toEqual({ id: 'ac', fromNode: 'a', toNode: 'c', label: 'down', fromSide: 'bottom', toSide: 'top' });
  await view.locator('.canvas-edge-label').click({ button: 'right' });
  await view.getByRole('menuitem', { name: 'Choose sides automatically', exact: true }).click();
  expect((await canvasData(page)).edges[1]).toEqual({ id: 'ac', fromNode: 'a', toNode: 'c', label: 'down' });
});

test('connections without pinned sides follow the geometry and the file keeps them unpinned', async ({ page }) => {
  const doc = { nodes: [text('a', 0, 0), text('b', -400, 0), text('c', 0, 300)], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }, { id: 'ac', fromNode: 'a', toNode: 'c', label: 'down' }, { id: 'pinned', fromNode: 'c', toNode: 'a', fromSide: 'right', toSide: 'right' }] };
  await openCanvas(page, doc);
  const view = canvas(page);
  await snapOff(view);
  const start = (id: string) => edgeStart(view, id);
  // a → b lies to the left, so the arrow leaves a's left side instead of looping from the right.
  expect((await start('ab')).x).toBeLessThan(10);
  expect((await start('ab')).y).toBeCloseTo(60, -1);
  // a → c lies below: it leaves from the bottom.
  expect((await start('ac')).y).toBeGreaterThan(110);
  // A pinned connection stays where the file put it.
  expect((await start('pinned')).x).toBeGreaterThan(190);
  await expect(view.locator('.canvas-edge-label')).toHaveText('down');

  // Moving b to the right flips the unpinned connection while dragging, and saving does not pin it.
  await drag(page, card(view, 'b'), 700, 0);
  expect((await start('ab')).x).toBeGreaterThan(190);
  const data = await canvasData(page);
  expect(data.nodes[1]).toMatchObject({ x: 300, y: 0 });
  expect(data.edges).toEqual(doc.edges);
});

test('connection labels are edited in place and connections can be selected and deleted', async ({ page }) => {
  await openCanvas(page, { nodes: [text('a', 0, 0), text('b', 400, 0)], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b', label: 'old', future: 'kept' }] });
  const view = canvas(page);
  await view.locator('.canvas-edge-label').dblclick();
  const input = view.getByRole('textbox', { name: 'Edit connection label', exact: true });
  await expect(input).toBeFocused();
  await input.fill('renamed');
  await page.keyboard.press('Enter');
  await expect(view.locator('.canvas-edge-label')).toHaveText('renamed');
  let data = await canvasData(page);
  expect(data.edges[0]).toEqual({ id: 'ab', fromNode: 'a', toNode: 'b', label: 'renamed', future: 'kept' });

  await view.locator('.canvas-edge-label').click();
  await expect(view.locator('.svelte-flow__edge.selected')).toHaveCount(1);
  await page.keyboard.press('Delete');
  data = await canvasData(page);
  expect(data.edges).toHaveLength(0);
  expect(data.nodes).toHaveLength(2);
});

test('copy, paste, duplicate and delete work from the keyboard and keep unknown fields', async ({ page }) => {
  await openCanvas(page, { nodes: [text('a', 0, 0, { extension: { future: true }, color: '3' }), text('b', 300, 0)], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b', label: 'link', future: 'kept' }] });
  const view = canvas(page);
  await card(view, 'a').click();
  await card(view, 'b').click({ modifiers: ['Shift'] });
  await page.keyboard.press('ControlOrMeta+d');
  await expect(view.locator('.svelte-flow__node')).toHaveCount(4);
  let data = await canvasData(page);
  expect(data.nodes).toHaveLength(4);
  const [copyA, copyB] = data.nodes.slice(2);
  expect(copyA).toMatchObject({ text: 'a', x: 40, y: 40, extension: { future: true }, color: '3' });
  expect(new Set(data.nodes.map((node) => node.id)).size).toBe(4);
  // The connection between the copied cards came along, with its unknown field.
  expect(data.edges).toHaveLength(2);
  expect(data.edges[1]).toMatchObject({ fromNode: copyA.id, toNode: copyB.id, label: 'link', future: 'kept' });
  // The copies are selected, so Delete removes exactly them.
  await expect(view.locator('.svelte-flow__node.selected')).toHaveCount(2);
  await boardOf(view).focus();
  await page.keyboard.press('Delete');
  data = await canvasData(page);
  expect(data.nodes.map((node) => node.id)).toEqual(['a', 'b']);
  expect(data.edges).toHaveLength(1);

  await card(view, 'a').click();
  await page.keyboard.press('ControlOrMeta+c');
  await expect(view.getByRole('status')).toContainText('Copied 1 card');
  const frame = (await boardOf(view).boundingBox())!;
  await page.mouse.move(frame.x + frame.width - 150, frame.y + frame.height - 100);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(view.locator('.svelte-flow__node')).toHaveCount(3);
  data = await canvasData(page);
  expect(data.nodes[2]).toMatchObject({ text: 'a', extension: { future: true } });
  // Pasted under the cursor.
  const pasted = (await view.locator('.svelte-flow__node.selected').boundingBox())!;
  expect(pasted.x + pasted.width / 2).toBeCloseTo(frame.x + frame.width - 150, -1);
  // One undo removes the paste; select-all then Delete clears the board.
  await undo(page, view);
  expect((await canvasData(page)).nodes).toHaveLength(2);
  await boardOf(view).focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  data = await canvasData(page);
  expect(data).toMatchObject({ nodes: [], edges: [] });
});

test('the context menu adds, recolours, duplicates and deletes', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page), frame = (await boardOf(view).boundingBox())!;
  await snapOff(view);
  await page.mouse.click(frame.x + 400, frame.y + 300, { button: 'right' });
  const menu = view.getByRole('menu', { name: 'Canvas actions', exact: true });
  await expect(menu.getByRole('menuitem', { name: 'Add text card here', exact: true })).toBeFocused();
  await expect(menu.getByRole('menuitem', { name: 'Paste', exact: true })).toBeDisabled();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Add group here', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  await page.mouse.click(frame.x + 400, frame.y + 300, { button: 'right' });
  await menu.getByRole('menuitem', { name: 'Add note card here', exact: true }).click();
  await expect(card(view, 'Note')).toBeVisible();
  let data = await canvasData(page);
  expect(data.nodes[0]).toMatchObject({ type: 'file', x: 400 - 140, y: 300 - 90 });

  await card(view, 'Note').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Colour 4', exact: true }).click();
  await card(view, 'Note').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
  await expect(view.locator('.svelte-flow__node')).toHaveCount(2);
  data = await canvasData(page);
  expect(data.nodes.map((node) => node.color)).toEqual(['4', '4']);
  await view.locator('.svelte-flow__node.selected').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await expect(view.locator('.svelte-flow__node')).toHaveCount(1);
  // Clicking elsewhere closes the menu without acting.
  await card(view, 'Note').click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.mouse.click(frame.x + 20, frame.y + 20);
  await expect(menu).toHaveCount(0);
  expect((await canvasData(page)).nodes).toHaveLength(1);
});

test('moving a group moves the cards inside it as one undo step', async ({ page }) => {
  const doc = { nodes: [{ id: 'g', type: 'group', label: 'Phase', x: 0, y: 0, width: 400, height: 300 }, text('in', 40, 60), text('out', 500, 60), text('half', 300, 250)], edges: [] };
  await openCanvas(page, doc);
  const view = canvas(page);
  await snapOff(view);
  const group = (await card(view, 'Phase').boundingBox())!;
  // Drag the group by an empty corner of its body.
  await page.mouse.move(group.x + 20, group.y + group.height - 12);
  await page.mouse.down();
  await page.mouse.move(group.x + 80, group.y + group.height + 28, { steps: 6 });
  await page.mouse.up();
  let data = await canvasData(page);
  // Only the card fully inside the group travels with it.
  expect(data.nodes.map((node) => [node.id, node.x, node.y])).toEqual([['g', 60, 40], ['in', 100, 100], ['out', 500, 60], ['half', 300, 250]]);
  await undo(page, view);
  data = await canvasData(page);
  expect(data.nodes.map((node) => [node.x, node.y])).toEqual([[0, 0], [40, 60], [500, 60], [300, 250]]);

  // A card inside a group still drags on its own, and the group renames in place.
  await drag(page, card(view, 'in'), 10, 10);
  expect((await canvasData(page)).nodes.slice(0, 2).map((node) => [node.x, node.y])).toEqual([[0, 0], [50, 70]]);
  await page.mouse.dblclick(group.x + 20, group.y + group.height - 12);
  const label = view.getByRole('textbox', { name: 'Group label', exact: true });
  await label.fill('Phase two');
  await page.keyboard.press('Enter');
  await expect(card(view, 'Phase two')).toBeVisible();
  expect((await canvasData(page)).nodes[0].label).toBe('Phase two');
});

test('interactions round-trip unknown fields, CRLF and key order losslessly', async ({ page }) => {
  const original = JSON.stringify({ metadata: { app: 'other', unknown: [1, 2] }, nodes: [{ id: 'a', type: 'text', x: 10, y: 20, width: 240, height: 160, text: '# Text', extension: { future: true } }, { id: 'b', type: 'file', x: 400, y: 20, width: 200, height: 100, file: 'notes/example.md', subpath: '#Heading', styleAttributes: { shape: 'pill' } }, { id: 'l', type: 'link', x: 400, y: 200, width: 200, height: 100, url: 'https://example.com', color: '#aabbcc' }], edges: [{ id: 'edge', fromNode: 'a', toNode: 'b', label: 'related', future: 'retained', toEnd: 'none', fromEnd: 'arrow', color: '2' }], trailing: null }, null, 2).replaceAll('\n', '\r\n') + '\r\n';
  await openCanvas(page, original);
  const view = canvas(page);
  await snapOff(view);
  // Opening, selecting, panning and zooming change nothing.
  await card(view, 'Text').click();
  await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
  expect(await exportCanvas(page)).toBe(original);

  await view.getByRole('button', { name: 'Fit canvas', exact: true }).click();
  await expect(view.locator('.canvas-zoom')).toHaveText('100%');
  await drag(page, card(view, 'Text'), 30, 40);
  const moved = await exportCanvas(page);
  // Only the two coordinates changed: same bytes otherwise, CRLF included.
  expect(moved).toBe(original.replace('"x": 10', '"x": 40').replace('"y": 20', '"y": 60'));
  await undo(page, view);
  expect(await exportCanvas(page)).toBe(original);
});

test('Space-drag and middle-drag pan from over a card without moving it or pressing its buttons', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles({ name: 'Target.md', mimeType: 'text/markdown', buffer: Buffer.from('# Target') });
  await openCanvas(page, { nodes: [{ id: 'f', type: 'file', file: 'Target.md', label: 'Linked', x: 0, y: 0, width: 280, height: 180 }, text('t', 0, 260)], edges: [] });
  const view = canvas(page), original = await exportCanvas(page);
  const open = view.getByRole('button', { name: 'Open card file: Target.md', exact: true });
  const before = (await card(view, 't').boundingBox())!;
  await boardOf(view).focus();
  await page.keyboard.down('Space');
  await drag(page, open, 60, 40);
  await page.keyboard.up('Space');
  await expect(page.getByRole('tab', { name: 'board.canvas', exact: true })).toHaveAttribute('aria-selected', 'true');
  let after = (await card(view, 't').boundingBox())!;
  expect(after.x).toBeCloseTo(before.x + 60, 0);
  expect(after.y).toBeCloseTo(before.y + 40, 0);

  const middle = await center(card(view, 't'));
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(middle.x - 30, middle.y - 20, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  after = (await card(view, 't').boundingBox())!;
  expect(after.x).toBeCloseTo(before.x + 30, 0);
  expect(after.y).toBeCloseTo(before.y + 20, 0);

  // Dragging empty space pans too.
  const frame = (await boardOf(view).boundingBox())!;
  await page.mouse.move(frame.x + frame.width - 40, frame.y + frame.height - 40);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width - 90, frame.y + frame.height - 60, { steps: 5 });
  await page.mouse.up();
  after = (await card(view, 't').boundingBox())!;
  expect(after.x).toBeCloseTo(before.x - 20, 0);
  expect(await exportCanvas(page)).toBe(original);
});

test('Escape cancels a drag, a resize, a selection box and a connection at once, with nothing written', async ({ page }) => {
  await openCanvas(page, { nodes: [{ id: 'g', type: 'group', label: 'Group', x: -20, y: -40, width: 260, height: 200 }, text('a', 0, 0), text('b', 300, 0)], edges: [] });
  const view = canvas(page), original = await exportCanvas(page), writes = await trackWrites(page);
  await snapOff(view);
  const boxOf = async (name: string) => (await card(view, name).boundingBox())!;
  const home = { a: await boxOf('a'), b: await boxOf('b'), g: await boxOf('Group') };
  const same = (one: { x: number; y: number; width: number; height: number }, two: typeof one) => Math.abs(one.x - two.x) < 1 && Math.abs(one.y - two.y) < 1 && Math.abs(one.width - two.width) < 1 && Math.abs(one.height - two.height) < 1;

  // Drag: the card returns while the button is still down, and further movement does nothing.
  await startDrag(page, card(view, 'b'), 80, 60);
  expect(same(await boxOf('b'), home.b)).toBe(false);
  await page.keyboard.press('Escape');
  await expect.poll(async () => same(await boxOf('b'), home.b)).toBe(true);
  await page.mouse.move(home.b.x + 300, home.b.y + 200, { steps: 4 });
  expect(same(await boxOf('b'), home.b)).toBe(true);
  await page.mouse.up();
  expect(same(await boxOf('b'), home.b)).toBe(true);

  // A group drag takes its cards along, and Escape brings all of them back.
  await page.mouse.move(home.g.x + 12, home.g.y + home.g.height - 10);
  await page.mouse.down();
  await page.mouse.move(home.g.x + 90, home.g.y + home.g.height + 60, { steps: 6 });
  expect(same(await boxOf('a'), home.a)).toBe(false);
  await page.keyboard.press('Escape');
  await expect.poll(async () => same(await boxOf('a'), home.a) && same(await boxOf('Group'), home.g)).toBe(true);
  await page.mouse.up();

  // Resize.
  await card(view, 'b').click();
  await startDrag(page, card(view, 'b').locator('.svelte-flow__resize-control.handle.bottom.right'), 60, 40);
  expect(same(await boxOf('b'), home.b)).toBe(false);
  await page.keyboard.press('Escape');
  await expect.poll(async () => same(await boxOf('b'), home.b)).toBe(true);
  await page.mouse.up();
  expect(same(await boxOf('b'), home.b)).toBe(true);

  // Selection box: the selection from before the box comes back.
  expect(await selectedIds(view)).toEqual(['b']);
  await page.keyboard.down('Shift');
  await page.mouse.move(home.g.x - 30, home.g.y - 30);
  await page.mouse.down();
  await page.mouse.move(home.a.x + 60, home.a.y + 60, { steps: 5 });
  await expect(view.locator('.canvas-marquee')).toBeVisible();
  expect(await selectedIds(view)).toEqual(['a', 'b', 'g']);
  await page.keyboard.press('Escape');
  await expect(view.locator('.canvas-marquee')).toHaveCount(0);
  expect(await selectedIds(view)).toEqual(['b']);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  expect(await selectedIds(view)).toEqual(['b']);

  // Connection: Escape drops the line even while it is snapped to another card's dot.
  const from = await center(card(view, 'a').locator('.svelte-flow__handle-right')), to = await center(card(view, 'b').locator('.svelte-flow__handle-left'));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await expect(view.locator('.svelte-flow__connectionline')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(view.locator('.svelte-flow__connectionline')).toHaveCount(0);
  await page.mouse.up();
  await expect(view.locator('.svelte-flow__edge')).toHaveCount(0);

  // None of it reached the document or the undo history.
  expect(await writes()).toBe(0);
  expect(await exportCanvas(page)).toBe(original);
  await undo(page, view);
  expect(await exportCanvas(page)).toBe(original);
});

test('a tab switch or an outside change during a drag discards the preview without committing', async ({ page }) => {
  await openCanvas(page, { nodes: [text('a', 0, 0), text('b', 300, 0)], edges: [] });
  const view = canvas(page), original = await exportCanvas(page);
  const home = (await card(view, 'a').boundingBox())!;
  const atHome = async () => { const box = (await card(view, 'a').boundingBox())!; return Math.abs(box.x - home.x) < 1 && Math.abs(box.y - home.y) < 1; };

  await startDrag(page, card(view, 'a'), 80, 60);
  await page.keyboard.press(previousTabKey);
  await page.mouse.up();
  await page.keyboard.press(nextTabKey);
  await expect(card(view, 'a')).toBeVisible();
  await expect.poll(atHome).toBe(true);
  expect(await exportCanvas(page)).toBe(original);

  // The document changes underneath a drag (another view, a script): the drag is dropped.
  await startDrag(page, card(view, 'b'), 40, 40);
  // Dispatch to the real (hidden) source editor without unmounting Canvas.
  await page.locator('.editor-tab-host:not([hidden]) .cm-content').evaluate((element) => {
    type View = { state: { doc: { length: number; toString(): string } }; dispatch: (transaction: { changes: { from: number; to: number; insert: string } }) => void };
    const editor = (element as unknown as { cmTile: { root: { view: View } } }).cmTile.root.view;
    const data = JSON.parse(editor.state.doc.toString());
    data.nodes[0].text = 'changed';
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: JSON.stringify(data) } });
  });
  await page.mouse.up();
  await expect(card(view, 'changed')).toBeVisible();
  const data = await canvasData(page);
  expect(data.nodes.map((node) => [node.text, node.x, node.y])).toEqual([['changed', 0, 0], ['b', 300, 0]]);

  // An outside change while a card is being edited in place keeps the draft; committing it rewrites only that card.
  await card(view, 'b').dblclick();
  await view.locator('.canvas-inline-editor').fill('typed');
  await page.locator('.editor-tab-host:not([hidden]) .cm-content').evaluate((element) => {
    type View = { state: { doc: { length: number; toString(): string } }; dispatch: (transaction: { changes: { from: number; to: number; insert: string } }) => void };
    const editor = (element as unknown as { cmTile: { root: { view: View } } }).cmTile.root.view;
    const data = JSON.parse(editor.state.doc.toString());
    data.nodes[0].text = 'outside';
    data.custom = { kept: true };
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: JSON.stringify(data) } });
  });
  await expect(view.locator('.canvas-inline-editor')).toHaveValue('typed');
  await page.keyboard.press('Escape');
  const merged = await canvasData(page);
  expect(merged.nodes.map((node) => node.text)).toEqual(['outside', 'typed']);
  expect(merged.custom).toEqual({ kept: true });
});

test('details drafts survive own moves but never apply over an outside change', async ({ page }) => {
  await openCanvas(page, { nodes: [text('a', 0, 0), text('b', 300, 0)], edges: [] });
  const view = canvas(page);
  await snapOff(view);
  await card(view, 'a').getByRole('button', { name: 'Edit card: a', exact: true }).click();
  const inspector = inspectorOf(view), label = inspector.getByRole('textbox', { name: 'Card label', exact: true });
  await label.fill('Draft');
  // Moving cards on the board is this view's own change: the draft still applies afterwards.
  await drag(page, card(view, 'b'), 20, 30);
  await card(view, 'a').click();
  await page.keyboard.press('ArrowDown');
  await expect(label).toHaveValue('Draft');
  await inspector.getByRole('button', { name: 'Apply card', exact: true }).click();
  await expect(card(view, 'Draft')).toBeVisible();
  let data = await canvasData(page);
  expect(data.nodes.map((node) => [node.label ?? '', node.x, node.y])).toEqual([['Draft', 0, 1], ['', 320, 30]]);

  // Undo changes the document behind the draft: applying is refused and nothing is rewritten.
  await card(view, 'Draft').getByRole('button', { name: 'Edit card: Draft', exact: true }).click();
  await label.fill('Stale');
  await undo(page, view);
  await expect(card(view, 'a')).toBeVisible();
  await inspector.getByRole('button', { name: 'Apply card', exact: true }).click();
  await expect(view.locator('.app-error')).toContainText('Canvas changed');
  data = await canvasData(page);
  expect(data.nodes[0].label).toBeUndefined();
});

test('cards are reachable and operable from the keyboard', async ({ page }) => {
  await openCanvas(page, { nodes: [text('a', 0, 0), text('b', 300, 0)], edges: [] });
  const view = canvas(page);
  await snapOff(view);
  await card(view, 'a').focus();
  await expect(card(view, 'a')).toHaveAttribute('aria-describedby', /.+/u);
  await page.keyboard.press('Enter');
  await expect(view.locator('.svelte-flow__node.selected')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  // Enter on the selected card opens the editor; Escape commits and returns focus to the card.
  await page.keyboard.press('Enter');
  const editor = view.getByRole('textbox', { name: 'Card text: a', exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  await expect(card(view, '!')).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(card(view, 'b')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Delete');
  const data = await canvasData(page);
  expect(data.nodes).toHaveLength(1);
  expect(data.nodes[0]).toMatchObject({ text: '!', x: 1, y: 0 });
});

test('arrow keys move focus between cards, Enter selects and edits, and focus is always visible', async ({ page }) => {
  await openCanvas(page, { nodes: [text('a', 0, 0), text('b', 300, 0), text('c', 0, 220), text('d', 300, 220)], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }] });
  const view = canvas(page), writes = await trackWrites(page);
  await snapOff(view);
  // Tab reaches the board, then its cards; every card names itself and explains its keys.
  await boardOf(view).focus();
  await expect(boardOf(view)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(view.locator('.svelte-flow__edge')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(card(view, 'a')).toBeFocused();
  await expect(card(view, 'a')).toHaveAttribute('aria-describedby', /.+/u);
  expect(await card(view, 'a').locator('.canvas-node').evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none');
  // With nothing selected, arrows walk from card to card.
  await page.keyboard.press('ArrowRight');
  await expect(card(view, 'b')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(card(view, 'd')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(card(view, 'c')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(card(view, 'a')).toBeFocused();
  // No card further left: focus stays put.
  await page.keyboard.press('ArrowLeft');
  await expect(card(view, 'a')).toBeFocused();
  expect(await selectedIds(view)).toEqual([]);
  expect(await writes()).toBe(0);

  // Enter selects; arrows then move the card (Shift for a bigger step) as one undo step.
  await page.keyboard.press('Enter');
  expect(await selectedIds(view)).toEqual(['a']);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  let data = await canvasData(page);
  expect(data.nodes[0]).toMatchObject({ x: 2, y: 10 });
  expect(await writes()).toBe(1);
  // Enter on the selected card edits it; Escape commits and hands focus back to the card.
  await card(view, 'a').focus();
  await page.keyboard.press('Enter');
  await expect(view.locator('.canvas-inline-editor')).toBeFocused();
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  await expect(card(view, '!')).toBeFocused();
  // Escape again clears the selection, so arrows walk between cards once more.
  await page.keyboard.press('Escape');
  expect(await selectedIds(view)).toEqual([]);
  await page.keyboard.press('ArrowRight');
  await expect(card(view, 'b')).toBeFocused();
  // Delete removes the selected card and its connection; focus returns to the board.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Delete');
  await expect(boardOf(view)).toBeFocused();
  data = await canvasData(page);
  expect(data.nodes.map((node) => node.id)).toEqual(['a', 'c', 'd']);
  expect(data.edges).toHaveLength(0);
  // On the board itself, with nothing selected, arrows pan.
  const before = (await card(view, 'c').boundingBox())!;
  await boardOf(view).focus();
  await page.keyboard.press('ArrowRight');
  expect((await card(view, 'c').boundingBox())!.x).toBeCloseTo(before.x - 60, 0);
  // Connections are focusable and describe both ends.
  await undo(page, view);
  await expect(view.locator('.svelte-flow__edge')).toHaveAttribute('aria-label', 'Connection: ! to b');
});

test('looking, selecting, panning, zooming and cancelled edits never write to the document', async ({ page }) => {
  const original = JSON.stringify({ nodes: [text('a', 0, 0), text('b', 300, 0), { id: 'f', type: 'file', file: 'x.md', x: 0, y: 200, width: 200, height: 120 }], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b', label: 'link' }] }, null, '\t');
  await openCanvas(page, original);
  const view = canvas(page), frame = (await boardOf(view).boundingBox())!, writes = await trackWrites(page);
  await card(view, 'a').click();
  await card(view, 'b').click({ modifiers: ['Shift'] });
  // Press and release without moving; press, move and come back.
  await drag(page, card(view, 'a'), 0, 0);
  await startDrag(page, card(view, 'a'), 40, 40);
  await page.mouse.move((await center(card(view, 'a'))).x - 40, (await center(card(view, 'a'))).y - 40, { steps: 4 });
  await page.mouse.up();
  // Editors opened and closed unchanged.
  await card(view, 'a').dblclick();
  await page.keyboard.press('Escape');
  await view.locator('.canvas-edge-label').dblclick();
  await page.keyboard.press('Enter');
  await card(view, 'x.md').getByRole('button', { name: 'Edit card: x.md', exact: true }).click();
  await inspectorOf(view).getByRole('button', { name: 'Apply card', exact: true }).click();
  // View changes.
  await page.mouse.move(frame.x + frame.width - 60, frame.y + frame.height - 60);
  await page.mouse.wheel(40, 60);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  for (const name of ['Zoom in', 'Zoom out', 'Fit canvas', 'Select', 'Select', 'Snap', 'Snap', 'Map', 'Map']) await view.getByRole('button', { name, exact: true }).click();
  await page.mouse.click(frame.x + frame.width - 60, frame.y + frame.height - 60, { button: 'right' });
  await page.keyboard.press('Escape');
  await boardOf(view).focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('Escape');
  expect(await writes()).toBe(0);
  await expect(page.getByRole('tab', { name: 'board.canvas', exact: true }).locator('.tab-dirty')).toHaveCount(0);
  // Byte for byte, including the file's own tab indentation.
  expect(await exportCanvas(page)).toBe(original);
});

test('zoomed far out, cards become cheap placeholders and their content comes back unchanged', async ({ page }) => {
  const nodes = Array.from({ length: 120 }, (_, index) => text('n' + index, (index % 12) * 260, Math.floor(index / 12) * 180, { text: '## Card ' + index + '\n\nBody ' + index, ...(index === 5 ? { color: '4' } : {}) }));
  await openCanvas(page, { nodes, edges: [{ id: 'e', fromNode: 'n0', toNode: 'n1' }] }, 'board.canvas', false);
  const view = canvas(page), board = view.locator('.canvas-board');
  // The whole board fits at about 30%: titles on colour blocks, no Markdown rendered at all.
  await expect(board).toHaveClass(/\bfar\b/u);
  await expect(view.locator('.canvas-placeholder')).toHaveCount(120);
  await expect(card(view, 'Card 0').locator('.canvas-placeholder')).toHaveText('Card 0');
  await expect(view.locator('.canvas-card-render h2')).toHaveCount(0);
  await expect(view.locator('.canvas-card-render')).toHaveCount(120);
  expect(await view.locator('.canvas-card-render').evaluateAll((hosts) => hosts.filter((host) => host.childNodes.length).length)).toBe(0);
  // Placeholders still select, move and connect like cards.
  await card(view, 'Card 0').click();
  expect(await selectedIds(view)).toEqual(['n0']);

  // Zooming in swaps the content in for the cards in view.
  await page.mouse.move((await center(card(view, 'Card 0'))).x, (await center(card(view, 'Card 0'))).y);
  await page.keyboard.down('Control');
  for (let step = 0; step < 6; step++) await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await expect(board).not.toHaveClass(/\bfar\b/u);
  await expect(view.locator('.canvas-placeholder')).toHaveCount(0);
  await expect(card(view, 'Card 0').locator('h2')).toHaveText('Card 0');
  // Back out and in again: the rendered content was kept, not rebuilt.
  await card(view, 'Card 0').locator('h2').evaluate((heading) => { (heading as HTMLElement).dataset.kept = 'yes'; });
  await page.keyboard.down('Control');
  for (let step = 0; step < 6; step++) await page.mouse.wheel(0, 120);
  await expect(board).toHaveClass(/\bfar\b/u);
  await expect(card(view, 'Card 0').locator('.canvas-placeholder')).toBeVisible();
  await expect(card(view, 'Card 0').locator('h2')).toBeHidden();
  for (let step = 0; step < 6; step++) await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await expect(card(view, 'Card 0').locator('h2')).toHaveAttribute('data-kept', 'yes');
  // Editing works from far out too: the editor replaces the placeholder.
  await view.getByRole('button', { name: 'Fit canvas', exact: true }).click();
  await expect(board).toHaveClass(/\bfar\b/u);
  await card(view, 'Card 5').dblclick();
  await expect(view.locator('.canvas-inline-editor')).toHaveValue('## Card 5\n\nBody 5');
  await page.keyboard.press('Escape');
});

test('a 1000-card board opens, moves a card and saves every card', async ({ page }) => {
  test.slow();
  const nodes = Array.from({ length: 1000 }, (_, index) => text('n' + index, (index % 40) * 240, Math.floor(index / 40) * 160, { text: '## Card ' + index }));
  const edges = Array.from({ length: 500 }, (_, index) => ({ id: 'e' + index, fromNode: 'n' + index * 2, toNode: 'n' + (index * 2 + 1) }));
  const started = Date.now();
  await openCanvas(page, { nodes, edges }, 'board.canvas', false);
  const view = canvas(page);
  await expect(view.locator('.svelte-flow__node').first()).toBeVisible();
  // Opening stays interactive-quick. The whole board is in view as placeholders; nothing has rendered Markdown.
  expect(Date.now() - started).toBeLessThan(8000);
  await expect(view.locator('.canvas-placeholder')).toHaveCount(1000);
  await expect(view.locator('.canvas-card-render h2')).toHaveCount(0);
  await snapOff(view);
  // Zoomed in, only the cards in view are in the page.
  for (let step = 0; step < 12; step++) await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(() => view.locator('.svelte-flow__node').count()).toBeLessThan(120);
  // Pick a card that lies wholly inside the board.
  const frame = (await boardOf(view).boundingBox())!;
  const id = await view.locator('.svelte-flow__node').evaluateAll((cards, area) => cards.find((item) => { const box = item.getBoundingClientRect(); return box.left > area.x + 20 && box.top > area.y + 20 && box.right < area.x + area.width - 80 && box.bottom < area.y + area.height - 80; })!.getAttribute('data-id')!, frame);
  const target = view.locator('.svelte-flow__node[data-id="' + id + '"]');
  const scale = Number((await view.locator('.canvas-zoom').textContent())!.replace('%', '')) / 100;
  await expect.poll(async () => (await target.boundingBox())!.width / 200).toBeCloseTo(scale, 1);
  const before = nodes.find((node) => node.id === id)!;
  await drag(page, target, 30, 20);
  const data = await canvasData(page);
  expect(data.nodes).toHaveLength(1000);
  expect(data.edges).toHaveLength(500);
  const moved = data.nodes.find((node) => node.id === id)!;
  expect(moved.x).toBeGreaterThan(before.x);
  expect(moved.y).toBeGreaterThan(before.y);
  // Everything else is exactly as it was.
  expect(data.nodes.filter((node) => node.id !== id)).toEqual(nodes.filter((node) => node.id !== id));
});

test('the canvas code loads only when a canvas is first shown', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => { if (/Canvas\.svelte|xyflow/u.test(request.url())) requests.push(request.url()); });
  await page.reload();
  await expect(source(page)).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(requests).toEqual([]);
  await runCommand(page, 'New canvas');
  await expect(boardOf(canvas(page))).toBeVisible();
  expect(requests.some((url) => url.includes('Canvas.svelte'))).toBe(true);
  expect(requests.some((url) => url.includes('xyflow'))).toBe(true);
});

test('the minimap toggles and large boards render only the cards in view', async ({ page }) => {
  const nodes = Array.from({ length: 120 }, (_, index) => text('n' + index, (index % 12) * 260, Math.floor(index / 12) * 180));
  await openCanvas(page, { nodes, edges: [{ id: 'e', fromNode: 'n0', toNode: 'n1' }] }, 'board.canvas', false);
  const view = canvas(page);
  await expect(view.locator('.svelte-flow__minimap')).toHaveCount(0);
  await view.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(view.locator('.svelte-flow__minimap')).toBeVisible();
  await expect(view.locator('.svelte-flow__minimap-node')).toHaveCount(120);
  // Fitted, every card is in view.
  await expect(view.locator('.svelte-flow__node')).toHaveCount(120);
  for (let step = 0; step < 6; step++) await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(() => view.locator('.svelte-flow__node').count()).toBeLessThan(60);
  // Nothing is lost from the document.
  expect((await canvasData(page)).nodes).toHaveLength(120);
});

test('empty note cards link an open note through search, Apply, and Open original', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles({ name: 'Target.md', mimeType: 'text/markdown', buffer: Buffer.from('# Target\n\nSearchable body.') });
  await expect(page.getByRole('tab', { name: 'Target.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  await addCanvasCard(view, 'Add note card');
  let card = view.getByRole('article', { name: 'Canvas card: Note', exact: true });
  await expect(card.getByRole('button', { name: 'Choose note', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: /^Open card file:/u })).toHaveCount(0);

  await card.getByRole('button', { name: 'Choose note', exact: true }).click();
  const inspector = view.getByRole('complementary', { name: 'Canvas inspector', exact: true });
  const file = inspector.getByRole('textbox', { name: 'Card file', exact: true });
  await expect(file).toBeFocused();
  await inspector.getByRole('textbox', { name: 'Card label', exact: true }).fill('Pending note');
  await expect(inspector.getByRole('textbox', { name: 'Card label', exact: true })).toHaveValue('Pending note');
  await expect(inspector.getByText(/then Apply card/)).toBeVisible();
  await expect(inspector.getByText(/Missing notes can be created explicitly/u)).toBeVisible();

  await inspector.getByLabel('Find note', { exact: true }).fill('tar');
  await inspector.getByRole('button', { name: 'Search notes', exact: true }).click();
  const result = inspector.getByRole('button', { name: 'Use note: Target.md', exact: true });
  await expect(result).toContainText('Target');
  await result.click();
  await expect(file).toHaveValue('Target.md');
  await inspector.getByRole('button', { name: 'Apply card', exact: true }).click();
  await expect(view.getByRole('status')).toContainText('Canvas updated');
  card = view.getByRole('article', { name: 'Canvas card: Pending note', exact: true });
  await expect(card.getByRole('button', { name: 'Open card file: Target.md', exact: true })).toBeVisible();

  await card.getByRole('button', { name: 'Open card file: Target.md', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Target.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.app-error')).toHaveCount(0);
});

test('note linking rejects blank paths and reports missing browser targets', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  await addCanvasCard(view, 'Add note card');
  await view.getByRole('button', { name: 'Choose note', exact: true }).click();
  const inspector = view.getByRole('complementary', { name: 'Canvas inspector', exact: true });
  const file = inspector.getByRole('textbox', { name: 'Card file', exact: true });

  await file.fill('   ');
  await inspector.getByRole('button', { name: 'Apply card', exact: true }).click();
  await expect(view.locator('.app-error')).toContainText('Enter a note path or clear Card file');
  expect((await canvasData(page)).nodes[0].file).toBe('');

  await inspector.getByLabel('Find note', { exact: true }).fill('Missing');
  await inspector.getByRole('button', { name: 'Search notes', exact: true }).click();
  await expect(inspector.getByRole('alert')).toContainText('No open or indexed note matches');

  await file.fill('Elsewhere.md');
  await inspector.getByRole('button', { name: 'Apply card', exact: true }).click();
  await expect(card(view, 'Note').getByRole('button', { name: 'Open card file: Elsewhere.md', exact: true })).toBeVisible();
  await card(view, 'Note').getByRole('button', { name: 'Open card file: Elsewhere.md', exact: true }).click();
  await expect(page.locator('.app-error').filter({ hasText: 'No open tab matches [[Elsewhere.md]]' })).toBeVisible();
});

test('duplicate matching browser tabs are offered separately and error explicitly', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles({ name: 'Target.md', mimeType: 'text/markdown', buffer: Buffer.from('# Target') });
  await page.locator('input[type=file]').setInputFiles({ name: 'Target', mimeType: 'text/markdown', buffer: Buffer.from('Target without extension') });
  await expect(page.getByRole('tab', { name: 'Target', exact: true })).toHaveAttribute('aria-selected', 'true');
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  await addCanvasCard(view, 'Add note card');
  await view.getByRole('button', { name: 'Choose note', exact: true }).click();
  const inspector = view.getByRole('complementary', { name: 'Canvas inspector', exact: true });

  await inspector.getByLabel('Find note', { exact: true }).fill('target');
  await inspector.getByRole('button', { name: 'Search notes', exact: true }).click();
  await expect(inspector.getByRole('button', { name: 'Use note: Target', exact: true })).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Use note: Target.md', exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: 'Use note: Target', exact: true }).click();
  await inspector.getByRole('button', { name: 'Apply card', exact: true }).click();
  await card(view, 'Note').getByRole('button', { name: 'Open card file: Target', exact: true }).click();
  await expect(page.locator('.app-error').filter({ hasText: 'Multiple open tabs match [[Target]]' })).toBeVisible();
});

test('manually configured note paths and heading subpaths open without rewriting the canvas', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles({ name: 'Nested.md', mimeType: 'text/markdown', buffer: Buffer.from('# Nested\n\n## Deep heading\n\nBody.') });
  await expect(page.getByRole('tab', { name: 'Nested.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  const linked = { nodes: [{ id: 'linked', type: 'file', file: 'Nested.md', subpath: '#Deep heading', label: 'Linked', x: 0, y: 0, width: 280, height: 180 }], edges: [] };
  await page.locator('input[type=file]').setInputFiles({ name: 'linked.canvas', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(linked)) });
  await expect(page.getByRole('tab', { name: 'linked.canvas', exact: true })).toHaveAttribute('aria-selected', 'true');
  const view = canvas(page);
  expect((await canvasData(page)).nodes[0]).toMatchObject({ file: 'Nested.md', subpath: '#Deep heading' });

  await view.getByRole('button', { name: 'Open card file: Nested.md', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Nested.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.editor-tab-host:not([hidden]) .cm-activeLine').filter({ hasText: 'Deep heading' })).toBeVisible();
});

test('nested workspace paths stay intact and surface the browser limitation', async ({ page }) => {
  const linked = { nodes: [{ id: 'nested', type: 'file', file: 'notes/Nested.md', subpath: '#Deep heading', label: 'Nested note', x: 0, y: 0, width: 280, height: 180 }], edges: [] };
  await page.locator('input[type=file]').setInputFiles({ name: 'nested.canvas', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(linked)) });
  await expect(page.getByRole('tab', { name: 'nested.canvas', exact: true })).toHaveAttribute('aria-selected', 'true');
  const view = canvas(page);
  expect((await canvasData(page)).nodes[0]).toMatchObject({ file: 'notes/Nested.md', subpath: '#Deep heading' });
  await view.getByRole('button', { name: 'Open card file: notes/Nested.md', exact: true }).click();
  await expect(page.locator('.app-error').filter({ hasText: 'No open tab matches [[notes/Nested.md]]' })).toBeVisible();
  expect((await canvasData(page)).nodes[0]).toMatchObject({ file: 'notes/Nested.md', subpath: '#Deep heading' });
});

test('text/plain drops create a bounded text card while file drops cancel browser defaults', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  const board = view.getByRole('application', { name: 'Canvas board', exact: true });
  await expect(board).toBeVisible();
  await board.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'Dropped note');
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: rect.left + 240, clientY: rect.top + 180, dataTransfer: transfer }));
  });
  await expect(view.getByRole('article', { name: 'Canvas card: Dropped note', exact: true })).toBeVisible();
  let data = await canvasData(page);
  expect(data.nodes).toHaveLength(1);
  expect(data.nodes[0]).toMatchObject({ type: 'text', text: 'Dropped note', width: 280, height: 180 });
  expect(Math.abs(data.nodes[0].x)).toBeLessThanOrEqual(1_000_000);
  expect(Math.abs(data.nodes[0].y)).toBeLessThanOrEqual(1_000_000);

  const fileEvents = await board.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['not a text card'], 'ignored.txt', { type: 'text/plain' }));
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
    element.dispatchEvent(drop);
    // OS dragover can advertise Files while its protected file list is empty.
    Object.defineProperty(transfer, 'files', { value: [] });
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer });
    element.dispatchEvent(over);
    return { drop: drop.defaultPrevented, over: over.defaultPrevented, effect: transfer.dropEffect };
  });
  expect(fileEvents).toEqual({ drop: true, over: true, effect: 'none' });
  await expect(view.getByRole('status')).toContainText('Use Add note card or Add media card');
  data = await canvasData(page);
  expect(data.nodes).toHaveLength(1);
});

test('file drops on the toolbar, inspector and app header cancel defaults and explain supported actions', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  await addCanvasCard(view, 'Add text card');
  await card(view, 'New card').getByRole('button', { name: 'Edit card: New card', exact: true }).click();
  for (const target of [
    view.getByRole('button', { name: 'Add card', exact: true }),
    view.getByRole('textbox', { name: 'Card label', exact: true }),
    page.getByRole('button', { name: 'Commands', exact: true }),
  ]) {
    const cancelled = await target.evaluate(element => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['not an import'], 'outside.txt', { type: 'text/plain' }));
      const dispatch = (type: string) => {
        const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const over = dispatch('dragover'), drop = dispatch('drop');
      Object.defineProperty(transfer, 'files', { value: [] });
      return { over, drop, protectedOver: dispatch('dragover'), protectedDrop: dispatch('drop'), effect: transfer.dropEffect };
    });
    expect(cancelled).toEqual({ over: true, drop: true, protectedOver: true, protectedDrop: true, effect: 'none' });
    await expect(page.locator('.app-error')).toContainText('Open files with Open');
  }
  expect((await canvasData(page)).nodes).toHaveLength(1);
});
