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
  // The note card was added to the right, so the connection leaves right and enters left.
  expect(serialized.edges[0]).toMatchObject({ label: 'supports', fromSide: 'right', toSide: 'left' });

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
  after = (await card(view, 'b').boundingBox())!;
  expect(after.x).toBeCloseTo(before.x - 30, 0);
  expect(after.y).toBeCloseTo(before.y - 50, 0);

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

test('marquee and modifier selection move several cards as one undo step', async ({ page }) => {
  await openCanvas(page, { nodes: [text('a', 0, 0), text('b', 260, 0), text('c', 0, 250)], edges: [] });
  const view = canvas(page);
  await snapOff(view);
  const a = (await card(view, 'a').boundingBox())!, b = (await card(view, 'b').boundingBox())!;
  // Shift+drag on empty space draws a selection box around a and b.
  await page.keyboard.down('Shift');
  await page.mouse.move(a.x - 20, a.y - 20);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 20, b.y + b.height + 20, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(view.locator('.svelte-flow__node.selected')).toHaveCount(2);

  await expect(view.locator('.svelte-flow__selection-wrapper')).toBeVisible();
  await drag(page, card(view, 'b'), 50, 70);
  let data = await canvasData(page);
  expect(data.nodes.map((node) => [node.x, node.y])).toEqual([[50, 70], [310, 70], [0, 250]]);
  await undo(page, view);
  data = await canvasData(page);
  expect(data.nodes.map((node) => [node.x, node.y])).toEqual([[0, 0], [260, 0], [0, 250]]);

  // Shift+click adds a card to the selection; dragging one selected card moves them all.
  await page.mouse.click((await boardOf(view).boundingBox())!.x + 8, (await boardOf(view).boundingBox())!.y + 8);
  await expect(view.locator('.svelte-flow__node.selected')).toHaveCount(0);
  await card(view, 'a').click();
  await card(view, 'c').click({ modifiers: ['Shift'] });
  await expect(view.locator('.svelte-flow__node.selected')).toHaveCount(2);
  await drag(page, card(view, 'c'), 30, -40);
  data = await canvasData(page);
  expect(data.nodes.map((node) => [node.x, node.y])).toEqual([[30, -40], [260, 0], [30, 210]]);
  await undo(page, view);
  expect((await canvasData(page)).nodes.map((node) => [node.x, node.y])).toEqual([[0, 0], [260, 0], [0, 250]]);

  // The Select tool makes a plain drag on empty space a marquee.
  await view.getByRole('button', { name: 'Select', exact: true }).click();
  const c = (await card(view, 'c').boundingBox())!;
  await page.mouse.move(c.x - 20, c.y - 20);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width + 20, c.y + c.height + 20, { steps: 6 });
  await page.mouse.up();
  await expect(view.locator('.svelte-flow__node.selected')).toHaveCount(1);
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

test('dragging between side handles connects cards; dropping on a card or on empty space also works', async ({ page }) => {
  await openCanvas(page, { nodes: [text('a', 0, 0), text('b', 400, 0), text('c', 0, 300)], edges: [] });
  const view = canvas(page);
  await snapOff(view);
  const handle = (name: string, side: string) => card(view, name).locator('.svelte-flow__handle-' + side);
  // Handle to handle: the sides are the ones the user picked.
  let from = await center(handle('a', 'right')), to = await center(handle('b', 'left'));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, from.y + 10, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await expect(view.locator('.svelte-flow__edge')).toHaveCount(1);
  let data = await canvasData(page);
  expect(data.edges).toHaveLength(1);
  expect(data.edges[0]).toMatchObject({ fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left' });

  // Dropped on a card body: it enters through the side that faces the source card.
  from = await center(handle('a', 'bottom'));
  const body = (await card(view, 'c').boundingBox())!;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 5, from.y + 60, { steps: 4 });
  await page.mouse.move(body.x + body.width / 2, body.y + 50, { steps: 4 });
  await page.mouse.up();
  await expect(view.locator('.svelte-flow__edge')).toHaveCount(2);
  data = await canvasData(page);
  expect(data.edges[1]).toMatchObject({ fromNode: 'a', fromSide: 'bottom', toNode: 'c', toSide: 'top' });

  // Dropped on empty space: a new card appears there, connected and ready to type into.
  from = await center(handle('b', 'bottom'));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 80, { steps: 4 });
  await page.mouse.move(from.x + 20, from.y + 160, { steps: 4 });
  await page.mouse.up();
  const editor = view.getByRole('textbox', { name: 'Card text: Empty card', exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.type('Follow-up');
  await page.keyboard.press('Escape');
  data = await canvasData(page);
  expect(data.nodes).toHaveLength(4);
  const added = data.nodes[3];
  expect(added).toMatchObject({ type: 'text', text: 'Follow-up' });
  expect(data.edges[2]).toMatchObject({ fromNode: 'b', fromSide: 'bottom', toNode: added.id, toSide: 'top' });
  // The new card hangs from the drop point by the middle of its top edge.
  expect(added.x + added.width / 2).toBeCloseTo(400 + 100 + 20, -1);
  expect(added.y).toBeCloseTo(120 + 160, -1);

  // Card and connection were one change.
  await undo(page, view);
  await undo(page, view);
  data = await canvasData(page);
  expect(data.nodes).toHaveLength(3);
  expect(data.edges).toHaveLength(2);

  // A connection to the same card is refused.
  from = await center(handle('c', 'right'));
  to = await center(handle('c', 'bottom'));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x + 30, to.y - 30, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  expect((await canvasData(page)).edges).toHaveLength(2);
});

test('connections without pinned sides follow the geometry and the file keeps them unpinned', async ({ page }) => {
  const doc = { nodes: [text('a', 0, 0), text('b', -400, 0), text('c', 0, 300)], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }, { id: 'ac', fromNode: 'a', toNode: 'c', label: 'down' }, { id: 'pinned', fromNode: 'c', toNode: 'a', fromSide: 'right', toSide: 'right' }] };
  await openCanvas(page, doc);
  const view = canvas(page);
  await snapOff(view);
  const start = (id: string) => view.locator('.svelte-flow__edge[data-id="' + id + '"] .svelte-flow__edge-path').evaluate((path) => { const [x, y] = path.getAttribute('d')!.slice(1).split(/[ C]/u)[0].split(',').map(Number); return { x, y }; });
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

test('Escape, a tab switch and an outside change during a drag discard the preview without committing', async ({ page }) => {
  await openCanvas(page, { nodes: [text('a', 0, 0), text('b', 300, 0)], edges: [] });
  const view = canvas(page), original = await exportCanvas(page);
  const home = (await card(view, 'a').boundingBox())!;
  const atHome = async () => { const box = (await card(view, 'a').boundingBox())!; return Math.abs(box.x - home.x) < 1 && Math.abs(box.y - home.y) < 1; };

  await startDrag(page, card(view, 'a'), 80, 60);
  expect(await atHome()).toBe(false);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(atHome).toBe(true);
  expect(await exportCanvas(page)).toBe(original);

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
