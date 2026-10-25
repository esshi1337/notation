import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const canvas = (page: Page) => page.getByRole('region', { name: 'Canvas', exact: true });

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
  nodes: { id: string; type: string; x: number; y: number; width: number; height: number; text?: string; file?: string; label?: string; extension?: unknown }[];
  edges: { id: string; fromNode: string; toNode: string; label?: string }[];
  [key: string]: unknown;
};

async function canvasData(page: Page) {
  return JSON.parse(await exportCanvas(page)) as CanvasJSON;
}

async function addLabeledCard(view: ReturnType<typeof canvas>, label: string, text = 'New card') {
  await addCanvasCard(view, 'Add text card');
  const card = view.getByRole('article', { name: 'Canvas card: New card', exact: true });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Edit card: New card', exact: true }).click();
  const inspector = view.getByRole('complementary', { name: 'Canvas inspector', exact: true });
  await inspector.getByRole('textbox', { name: 'Card label', exact: true }).fill(label);
  await inspector.getByRole('textbox', { name: 'Card text', exact: true }).fill(text);
  await inspector.getByRole('button', { name: 'Apply card', exact: true }).click();
  await expect(view.getByRole('article', { name: 'Canvas card: ' + label, exact: true })).toBeVisible();
}

async function drag(page: Page, target: Locator, x: number, y: number) {
  const box = await target.boundingBox();
  if (!box) throw new Error('Drag target has no box.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + x, box.y + box.height / 2 + y, { steps: 8 });
  await page.mouse.up();
}

async function startDrag(page: Page, target: Locator, x: number, y: number) {
  const box = await target.boundingBox();
  if (!box) throw new Error('Drag target has no box.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + x, box.y + box.height / 2 + y, { steps: 8 });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('canvas cards and labeled connections serialize and undo independently', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  const board = view.getByRole('application', { name: 'Canvas board', exact: true });
  await expect(board).toBeVisible();
  await addCanvasCard(view, 'Add text card');
  const research = view.getByRole('article', { name: 'Canvas card: New card', exact: true });
  await expect(research).toBeVisible();
  await research.getByRole('button', { name: 'Edit card: New card', exact: true }).click();
  const inspector = view.getByRole('complementary', { name: 'Canvas inspector', exact: true });
  await inspector.getByRole('textbox', { name: 'Card label', exact: true }).fill('Research');
  await inspector.getByRole('textbox', { name: 'Card text', exact: true }).fill('# Research notes\n\nKeep the source editable.');
  await inspector.getByRole('button', { name: 'Apply card', exact: true }).click();
  await expect(view.getByRole('article', { name: 'Canvas card: Research', exact: true })).toBeVisible();

  await addCanvasCard(view, 'Add note card');
  await expect(view.getByRole('article', { name: 'Canvas card: Note', exact: true })).toBeVisible();
  await view.getByRole('button', { name: 'Connect cards', exact: true }).click();
  await inspector.getByRole('combobox', { name: 'From card', exact: true }).selectOption({ label: 'Research' });
  await inspector.getByRole('combobox', { name: 'To card', exact: true }).selectOption({ label: 'Note' });
  await inspector.getByRole('textbox', { name: 'Connection label', exact: true }).fill('supports');
  await inspector.getByRole('button', { name: 'Add connection', exact: true }).click();
  await expect(view.getByRole('status')).toContainText('Canvas updated');

  const serialized = JSON.parse(await exportCanvas(page)) as { nodes: { label?: string; text?: string }[]; edges: { label?: string }[] };
  expect(serialized.nodes).toHaveLength(2);
  expect(serialized.nodes.find(node => node.label === 'Research')?.text).toBe('# Research notes\n\nKeep the source editable.');
  expect(serialized.edges).toHaveLength(1);
  expect(serialized.edges[0].label).toBe('supports');

  await board.focus();
  await page.keyboard.press('ControlOrMeta+z');
  const afterUndo = JSON.parse(await exportCanvas(page)) as { nodes: unknown[]; edges: unknown[] };
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

test('pointer drag moves cards at 100% and 120% with one-step undo and redo', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  const board = view.getByRole('application', { name: 'Canvas board', exact: true });
  await addCanvasCard(view, 'Add text card');
  await expect(view.getByRole('article', { name: 'Canvas card: New card', exact: true })).toBeVisible();
  const start = (await canvasData(page)).nodes[0];
  if (!start) throw new Error('Missing card.');

  await drag(page, view.getByRole('button', { name: 'Move card: New card', exact: true }), 64, 48);
  await expect(view.getByRole('status')).toContainText('Canvas updated');
  let data = await canvasData(page);
  expect(data.nodes[0].x).toBe(start.x + 64);
  expect(data.nodes[0].y).toBe(start.y + 48);
  const moved = data.nodes[0];

  await board.focus();
  await page.keyboard.press('ControlOrMeta+z');
  data = await canvasData(page);
  expect(data.nodes[0].x).toBe(start.x);
  expect(data.nodes[0].y).toBe(start.y);

  await board.focus();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  data = await canvasData(page);
  expect(data.nodes[0].x).toBe(moved.x);
  expect(data.nodes[0].y).toBe(moved.y);

  await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(view.locator('.canvas-zoom')).toHaveText('120%');
  await drag(page, view.getByRole('button', { name: 'Move card: New card', exact: true }), 60, 36);
  data = await canvasData(page);
  expect(data.nodes[0].x).toBe(moved.x + 50);
  expect(data.nodes[0].y).toBe(moved.y + 30);
});

test('corner resize previews at 100% and 120%, clamps minimum sizes, and commits once', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  const board = view.getByRole('application', { name: 'Canvas board', exact: true });
  await addCanvasCard(view, 'Add text card');
  await expect(view.getByRole('article', { name: 'Canvas card: New card', exact: true })).toBeVisible();
  const handle = view.getByRole('button', { name: 'Resize card: New card', exact: true });
  const start = (await canvasData(page)).nodes[0];
  expect(start.width).toBe(280);
  expect(start.height).toBe(180);

  await drag(page, handle, 40, 30);
  await expect(view.getByRole('status')).toContainText('Canvas updated');
  let data = await canvasData(page);
  expect(data.nodes[0].width).toBe(320);
  expect(data.nodes[0].height).toBe(210);

  await board.focus();
  await page.keyboard.press('ControlOrMeta+z');
  data = await canvasData(page);
  expect(data.nodes[0].width).toBe(280);
  expect(data.nodes[0].height).toBe(180);

  await board.focus();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  data = await canvasData(page);
  expect(data.nodes[0].width).toBe(320);
  expect(data.nodes[0].height).toBe(210);

  await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(view.locator('.canvas-zoom')).toHaveText('120%');
  await drag(page, handle, 60, 36);
  data = await canvasData(page);
  expect(data.nodes[0].width).toBe(370);
  expect(data.nodes[0].height).toBe(240);

  const box = await handle.boundingBox();
  if (!box) throw new Error('Resize handle has no box.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(5, 5, { steps: 8 });
  await page.mouse.up();
  data = await canvasData(page);
  expect(data.nodes[0].width).toBe(120);
  expect(data.nodes[0].height).toBe(80);

  await board.focus();
  await page.keyboard.press('ControlOrMeta+z');
  data = await canvasData(page);
  expect(data.nodes[0].width).toBe(370);
  expect(data.nodes[0].height).toBe(240);
});

for (const gesture of ['move', 'resize', 'ArrowRight', 'Alt+ArrowDown']) {
  test(`${gesture} preserves inspector drafts, applies new geometry, and keeps edit undo separate`, async ({ page }) => {
    await runCommand(page, 'New canvas');
    const view = canvas(page);
    const board = view.getByRole('application', { name: 'Canvas board', exact: true });
    await addCanvasCard(view, 'Add text card');
    const start = (await canvasData(page)).nodes[0];
    const inspector = view.getByRole('complementary', { name: 'Canvas inspector', exact: true });
    const text = inspector.getByRole('textbox', { name: 'Card text', exact: true });
    const label = inspector.getByRole('textbox', { name: 'Card label', exact: true });
    await text.fill('Unapplied body');
    await label.fill('Unapplied name');
    await inspector.getByRole('spinbutton', { name: 'Card width', exact: true }).fill('410');
    await inspector.getByRole('spinbutton', { name: 'Card height', exact: true }).fill('270');
    const resizing = gesture === 'resize' || gesture.startsWith('Alt');
    if (gesture === 'move' || gesture === 'resize') {
      await drag(page, view.getByRole('button', { name: `${resizing ? 'Resize' : 'Move'} card: New card`, exact: true }), 30, 20);
    } else {
      await board.focus();
      await page.keyboard.press(gesture);
    }
    await expect(text).toHaveValue('Unapplied body');
    await expect(label).toHaveValue('Unapplied name');
    const geometry = { ...start };
    if (gesture === 'move') { geometry.x += 30; geometry.y += 20; }
    if (gesture === 'resize') { geometry.width += 30; geometry.height += 20; }
    if (gesture === 'ArrowRight') geometry.x += 1;
    if (gesture === 'Alt+ArrowDown') geometry.height += 1;
    expect((await canvasData(page)).nodes[0]).toEqual(geometry);
    await expect(inspector.getByRole('spinbutton', { name: 'Card width', exact: true })).toHaveValue(String(resizing ? geometry.width : 410));
    await expect(inspector.getByRole('spinbutton', { name: 'Card height', exact: true })).toHaveValue(String(resizing ? geometry.height : 270));
    await text.fill('After gesture edit');
    await inspector.getByRole('button', { name: 'Apply card', exact: true }).click();
    await expect(view.getByRole('alert')).toHaveCount(0);
    const edited = { ...geometry, text: 'After gesture edit', label: 'Unapplied name', width: resizing ? geometry.width : 410, height: resizing ? geometry.height : 270 };
    expect((await canvasData(page)).nodes[0]).toEqual(edited);
    await board.focus();
    await page.keyboard.press('ControlOrMeta+z');
    expect((await canvasData(page)).nodes[0]).toEqual(geometry);
    await board.focus();
    await page.keyboard.press('ControlOrMeta+z');
    expect((await canvasData(page)).nodes[0]).toEqual(start);
    await board.focus();
    await page.keyboard.press('ControlOrMeta+Shift+z');
    expect((await canvasData(page)).nodes[0]).toEqual(geometry);
    await board.focus();
    await page.keyboard.press('ControlOrMeta+Shift+z');
    expect((await canvasData(page)).nodes[0]).toEqual(edited);
  });
}

test('same-card move and resize preserve pending file and label edits through Apply', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  await addCanvasCard(view, 'Add note card');
  const inspector = view.getByRole('complementary', { name: 'Canvas inspector', exact: true });
  await inspector.getByRole('textbox', { name: 'Card file', exact: true }).fill('pending.md');
  await inspector.getByRole('textbox', { name: 'Card label', exact: true }).fill('Pending note');
  const start = (await canvasData(page)).nodes[0];
  await drag(page, view.getByRole('button', { name: 'Move card: Note', exact: true }), 20, 10);
  await drag(page, view.getByRole('button', { name: 'Resize card: Note', exact: true }), 30, 20);
  await expect(inspector.getByRole('textbox', { name: 'Card file', exact: true })).toHaveValue('pending.md');
  await expect(inspector.getByRole('textbox', { name: 'Card label', exact: true })).toHaveValue('Pending note');
  await inspector.getByRole('button', { name: 'Apply card', exact: true }).click();
  await expect(view.locator('.app-error')).toHaveCount(0);
  expect((await canvasData(page)).nodes[0]).toMatchObject({ file: 'pending.md', label: 'Pending note', x: start.x + 20, y: start.y + 10, width: start.width + 30, height: start.height + 20 });
});

test('cancelled and failed geometry gestures preserve drafts, dimensions, and source', async ({ page }) => {
  const initial = { nodes: [{ id: 'limit', type: 'text', text: 'Original', x: 999990, y: 0, width: 280, height: 180 }], edges: [] };
  await page.locator('input[type=file]').setInputFiles({ name: 'limit.canvas', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(initial)) });
  const view = canvas(page);
  await view.getByRole('button', { name: 'Fit canvas', exact: true }).click();
  await view.getByRole('button', { name: 'Edit card: Original', exact: true }).click();
  const inspector = view.getByRole('complementary', { name: 'Canvas inspector', exact: true });
  await inspector.getByRole('textbox', { name: 'Card text', exact: true }).fill('Draft');
  await inspector.getByRole('textbox', { name: 'Card label', exact: true }).fill('Draft label');
  await inspector.getByRole('spinbutton', { name: 'Card width', exact: true }).fill('410');
  await inspector.getByRole('spinbutton', { name: 'Card height', exact: true }).fill('270');
  for (const action of ['Move', 'Resize']) {
    await startDrag(page, view.getByRole('button', { name: `${action} card: Original`, exact: true }), 60, 40);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await canvasData(page)).toEqual(initial);
  }
  // Moving beyond the schema's coordinate limit is a real failed commit.
  await drag(page, view.getByRole('button', { name: 'Move card: Original', exact: true }), 60, 40);
  await expect(view.getByRole('alert')).toBeVisible();
  expect(await canvasData(page)).toEqual(initial);
  await expect(inspector.getByRole('textbox', { name: 'Card text', exact: true })).toHaveValue('Draft');
  await expect(inspector.getByRole('textbox', { name: 'Card label', exact: true })).toHaveValue('Draft label');
  await expect(inspector.getByRole('spinbutton', { name: 'Card width', exact: true })).toHaveValue('410');
  await expect(inspector.getByRole('spinbutton', { name: 'Card height', exact: true })).toHaveValue('270');
  await inspector.getByRole('button', { name: 'Apply card', exact: true }).click();
  await expect(view.getByRole('alert')).toHaveCount(0);
  expect((await canvasData(page)).nodes[0]).toMatchObject({ text: 'Draft', label: 'Draft label', width: 410, height: 270, x: 999990, y: 0 });
});

for (const timing of ['during gesture', 'before gesture', 'after owned commit']) {
  test(`external source change ${timing} never rebases inspector drafts`, async ({ page }) => {
    await runCommand(page, 'New canvas');
    const view = canvas(page);
    await addCanvasCard(view, 'Add text card');
    const start = (await canvasData(page)).nodes[0];
    const inspector = view.getByRole('complementary', { name: 'Canvas inspector', exact: true });
    await inspector.getByRole('textbox', { name: 'Card text', exact: true }).fill('Private draft');
    await inspector.getByRole('textbox', { name: 'Card label', exact: true }).fill('Private label');
    await inspector.getByRole('spinbutton', { name: 'Card width', exact: true }).fill('410');
    const handle = view.getByRole('button', { name: 'Resize card: New card', exact: true });
    if (timing !== 'before gesture') await startDrag(page, handle, 30, 20);
    // Dispatch to the real (hidden) source editor without unmounting Canvas. For the
    // race case, inject an external edit synchronously after its next owned delta.
    await page.locator('.cm-content').evaluate((element, race) => {
      type View = { state: { doc: { length: number; toString(): string } }; dispatch: (transaction: { changes: { from: number; to: number; insert: string } }) => void };
      const editor = (element as unknown as { cmTile: { root: { view: View } } }).cmTile.root.view;
      const external = () => {
        const data = JSON.parse(editor.state.doc.toString());
        data.nodes[0].text = 'External body';
        data.nodes[0].label = 'External label';
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: JSON.stringify(data) } });
      };
      if (race) {
        const dispatch = editor.dispatch.bind(editor);
        editor.dispatch = (transaction) => { editor.dispatch = dispatch; dispatch(transaction); external(); };
      } else external();
    }, timing === 'after owned commit');
    if (timing === 'before gesture') {
      await drag(page, view.getByRole('button', { name: 'Resize card: External label', exact: true }), 30, 20);
    } else await page.mouse.up();
    await expect(inspector.getByRole('textbox', { name: 'Card text', exact: true })).toHaveValue('Private draft');
    await expect(inspector.getByRole('textbox', { name: 'Card label', exact: true })).toHaveValue('Private label');
    await expect(inspector.getByRole('spinbutton', { name: 'Card width', exact: true })).toHaveValue('410');
    const external = await canvasData(page);
    expect(external.nodes[0]).toMatchObject({ text: 'External body', label: 'External label', x: start.x, y: start.y, width: timing === 'during gesture' ? start.width : start.width + 30, height: timing === 'during gesture' ? start.height : start.height + 20 });
    await inspector.getByRole('button', { name: 'Apply card', exact: true }).click();
    await expect(view.getByRole('alert')).toContainText('Canvas changed');
    expect(await canvasData(page)).toEqual(external);
  });
}

test('history change then own move does not make a stale draft applicable', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  const board = view.getByRole('application', { name: 'Canvas board', exact: true });
  await addLabeledCard(view, 'Saved', 'Saved body');
  await view.getByRole('button', { name: 'Edit card: Saved', exact: true }).click();
  const inspector = view.getByRole('complementary', { name: 'Canvas inspector', exact: true });
  await inspector.getByRole('textbox', { name: 'Card text', exact: true }).fill('Private draft');
  await board.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await drag(page, view.getByRole('button', { name: 'Move card: New card', exact: true }), 30, 20);
  await expect(inspector.getByRole('textbox', { name: 'Card text', exact: true })).toHaveValue('Private draft');
  const beforeApply = await canvasData(page);
  await inspector.getByRole('button', { name: 'Apply card', exact: true }).click();
  await expect(view.getByRole('alert')).toContainText('Canvas changed');
  expect(await canvasData(page)).toEqual(beforeApply);
});

test('Space-drag over connect and Open original buttons pans without activating them', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  const board = view.getByRole('application', { name: 'Canvas board', exact: true });
  await addCanvasCard(view, 'Add note card');
  const inspector = view.getByRole('complementary', { name: 'Canvas inspector', exact: true });
  await inspector.getByRole('textbox', { name: 'Card file', exact: true }).fill('missing.md');
  await inspector.getByRole('button', { name: 'Apply card', exact: true }).click();
  const original = await canvasData(page);
  const tabs = await page.getByRole('tab').count();
  const card = view.getByRole('article', { name: 'Canvas card: Note', exact: true });
  for (const name of ['Connect card: Note', 'Open card file: missing.md']) {
    await board.focus();
    const before = await card.boundingBox();
    await page.keyboard.down('Space');
    await drag(page, view.getByRole('button', { name, exact: true }), 25, 15);
    await page.keyboard.up('Space');
    const after = await card.boundingBox();
    if (!before || !after) throw new Error('Missing card box.');
    expect(Math.round(after.x - before.x)).toBe(25);
    expect(Math.round(after.y - before.y)).toBe(15);
    await expect(view.getByRole('button', { name: 'Connect card: Note', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.getByRole('tab').count()).toBe(tabs);
    expect(await canvasData(page)).toEqual(original);
  }
});

test('Escape, pointercancel, and lost pointer capture discard drag previews', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  const board = view.getByRole('application', { name: 'Canvas board', exact: true });
  await addCanvasCard(view, 'Add text card');
  await expect(view.getByRole('article', { name: 'Canvas card: New card', exact: true })).toBeVisible();
  const title = view.getByRole('button', { name: 'Move card: New card', exact: true });
  const start = (await canvasData(page)).nodes[0];
  const inspector = view.getByRole('complementary', { name: 'Canvas inspector', exact: true });
  await inspector.getByRole('textbox', { name: 'Card text', exact: true }).fill('Cancelled gesture draft');
  await inspector.getByRole('textbox', { name: 'Card label', exact: true }).fill('Cancelled label');
  await inspector.getByRole('spinbutton', { name: 'Card width', exact: true }).fill('410');

  await startDrag(page, title, 80, 60);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  let data = await canvasData(page);
  expect(data.nodes[0].x).toBe(start.x);
  expect(data.nodes[0].y).toBe(start.y);

  await page.evaluate(() => {
    const boardElement = document.querySelector('[aria-label="Canvas board"]');
    boardElement?.addEventListener('pointerdown', (event) => { (window as unknown as { notationPointerId: number }).notationPointerId = (event as PointerEvent).pointerId; }, { once: true, capture: true });
  });
  await startDrag(page, title, 80, 60);
  const pointerId = await page.evaluate(() => (window as unknown as { notationPointerId: number }).notationPointerId);
  await page.evaluate((id) => { document.querySelector('[aria-label="Canvas board"]')?.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: id })); }, pointerId);
  await page.mouse.up();
  data = await canvasData(page);
  expect(data.nodes[0].x).toBe(start.x);
  expect(data.nodes[0].y).toBe(start.y);

  await page.evaluate(() => {
    const boardElement = document.querySelector('[aria-label="Canvas board"]');
    boardElement?.addEventListener('pointerdown', (event) => { (window as unknown as { notationPointerId: number }).notationPointerId = (event as PointerEvent).pointerId; }, { once: true, capture: true });
  });
  await startDrag(page, title, 80, 60);
  const lostPointerId = await page.evaluate(() => (window as unknown as { notationPointerId: number }).notationPointerId);
  await page.evaluate((id) => { document.querySelector('[aria-label="Canvas board"]')?.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: id })); }, lostPointerId);
  await page.mouse.up();
  data = await canvasData(page);
  expect(data.nodes[0].x).toBe(start.x);
  expect(data.nodes[0].y).toBe(start.y);
  await expect(inspector.getByRole('textbox', { name: 'Card text', exact: true })).toHaveValue('Cancelled gesture draft');
  await expect(inspector.getByRole('textbox', { name: 'Card label', exact: true })).toHaveValue('Cancelled label');
  await expect(inspector.getByRole('spinbutton', { name: 'Card width', exact: true })).toHaveValue('410');
  await board.focus();
});

test('per-card connect buttons create, cancel, and clear source connections without the inspector', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  await addLabeledCard(view, 'Alpha');
  await addLabeledCard(view, 'Beta');
  const alphaConnect = view.getByRole('button', { name: 'Connect card: Alpha', exact: true });
  const betaConnect = view.getByRole('button', { name: 'Connect card: Beta', exact: true });

  await alphaConnect.click();
  await expect(alphaConnect).toHaveAttribute('aria-pressed', 'true');
  await alphaConnect.click();
  await expect(alphaConnect).toHaveAttribute('aria-pressed', 'false');
  await alphaConnect.click();
  await page.keyboard.press('Escape');
  await expect(alphaConnect).toHaveAttribute('aria-pressed', 'false');

  await alphaConnect.click();
  await betaConnect.click();
  await expect(view.getByRole('status')).toContainText('Connected Beta');
  let data = await canvasData(page);
  expect(data.edges).toHaveLength(1);
  const alpha = data.nodes.find(node => node.label === 'Alpha')!;
  const beta = data.nodes.find(node => node.label === 'Beta')!;
  expect(data.edges[0].fromNode).toBe(alpha.id);
  expect(data.edges[0].toNode).toBe(beta.id);

  await betaConnect.click();
  await betaConnect.click();
  expect((await canvasData(page)).edges).toHaveLength(1);

  await view.getByRole('button', { name: 'Edit card: Alpha', exact: true }).click();
  const inspector = view.getByRole('complementary', { name: 'Canvas inspector', exact: true });
  await alphaConnect.click();
  await expect(alphaConnect).toHaveAttribute('aria-pressed', 'true');
  await inspector.getByRole('button', { name: 'Delete card', exact: true }).click();
  await expect(view.getByRole('article', { name: 'Canvas card: Alpha', exact: true })).toHaveCount(0);
  await expect(betaConnect).toHaveAttribute('aria-pressed', 'false');
  await betaConnect.click();
  await expect(betaConnect).toHaveAttribute('aria-pressed', 'true');
  expect((await canvasData(page)).edges).toHaveLength(0);
});

test('Space and middle-button panning over cards leave card coordinates alone and preserve inspector typing', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  const board = view.getByRole('application', { name: 'Canvas board', exact: true });
  await addCanvasCard(view, 'Add text card');
  const card = view.getByRole('article', { name: 'Canvas card: New card', exact: true });
  await expect(card).toBeVisible();
  const inspector = view.getByRole('complementary', { name: 'Canvas inspector', exact: true });
  const textarea = inspector.getByRole('textbox', { name: 'Card text', exact: true });
  await textarea.fill('');
  await textarea.pressSequentially('two words');
  await expect(textarea).toHaveValue('two words');
  const beforeText = await canvasData(page);
  const start = beforeText.nodes[0];

  await board.click({ position: { x: 20, y: 20 } });
  const title = view.getByRole('button', { name: 'Move card: New card', exact: true });
  const beforeSpace = await card.boundingBox();
  await page.keyboard.down('Space');
  await drag(page, title, 70, 50);
  await page.keyboard.up('Space');
  const afterSpace = await card.boundingBox();
  if (!beforeSpace || !afterSpace) throw new Error('Canvas card has no box.');
  expect(Math.round(afterSpace.x - beforeSpace.x)).toBe(70);
  expect(Math.round(afterSpace.y - beforeSpace.y)).toBe(50);
  let data = await canvasData(page);
  expect(data.nodes[0].x).toBe(start.x);
  expect(data.nodes[0].y).toBe(start.y);

  const beforeMiddle = await card.boundingBox();
  const titleBox = await title.boundingBox();
  if (!beforeMiddle || !titleBox) throw new Error('Canvas card has no box.');
  await page.mouse.move(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(titleBox.x + titleBox.width / 2 - 40, titleBox.y + titleBox.height / 2 - 30, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  const afterMiddle = await card.boundingBox();
  if (!afterMiddle) throw new Error('Canvas card has no box.');
  expect(Math.round(afterMiddle.x - beforeMiddle.x)).toBe(-40);
  expect(Math.round(afterMiddle.y - beforeMiddle.y)).toBe(-30);
  data = await canvasData(page);
  expect(data.nodes[0].x).toBe(start.x);
  expect(data.nodes[0].y).toBe(start.y);
  await expect(textarea).toHaveValue('two words');
});

test('tab switch and content change during a drag discard the preview without committing', async ({ page }) => {
  await runCommand(page, 'New canvas');
  const view = canvas(page);
  const board = view.getByRole('application', { name: 'Canvas board', exact: true });
  await addLabeledCard(view, 'Alpha');
  const start = (await canvasData(page)).nodes[0];

  await runCommand(page, 'New canvas');
  await page.keyboard.press('ControlOrMeta+PageUp');
  await expect(view.getByRole('article', { name: 'Canvas card: Alpha', exact: true })).toBeVisible();
  const title = view.getByRole('button', { name: 'Move card: Alpha', exact: true });
  await startDrag(page, title, 80, 60);
  await page.keyboard.press('ControlOrMeta+PageDown');
  await page.mouse.up();
  await page.keyboard.press('ControlOrMeta+PageUp');
  await expect(view.getByRole('article', { name: 'Canvas card: Alpha', exact: true })).toBeVisible();
  let data = await canvasData(page);
  expect(data.nodes[0].x).toBe(start.x);
  expect(data.nodes[0].y).toBe(start.y);

  await board.focus();
  await startDrag(page, title, 80, 60);
  await page.keyboard.press('ControlOrMeta+z');
  await page.mouse.up();
  data = await canvasData(page);
  expect(data.nodes[0].x).toBe(start.x);
  expect(data.nodes[0].y).toBe(start.y);
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

  await view.getByRole('textbox', { name: 'Card label', exact: true }).fill('Pending note');
  await card.getByRole('button', { name: 'Choose note', exact: true }).click();
  const inspector = view.getByRole('complementary', { name: 'Canvas inspector', exact: true });
  const file = inspector.getByRole('textbox', { name: 'Card file', exact: true });
  await expect(file).toBeFocused();
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

function card(view: ReturnType<typeof canvas>, name: string) {
  return view.getByRole('article', { name: 'Canvas card: ' + name, exact: true });
}

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
