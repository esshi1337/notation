import { expect, test, type Page } from '@playwright/test';
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
