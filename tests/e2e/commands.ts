import { expect, type Page } from '@playwright/test';

export const commandPalette = (page: Page) => page.getByRole('dialog', { name: 'Commands', exact: true });
export const commandResults = (page: Page) => commandPalette(page).getByRole('listbox', { name: 'Commands', exact: true });

/** Run a visible application command through the searchable palette. */
export async function runCommand(page: Page, label: string) {
  const palette = commandPalette(page);
  if (!(await palette.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Commands', exact: true }).click();
  }
  await expect(palette).toBeVisible();
  const search = palette.getByRole('textbox', { name: 'Search commands', exact: true });
  await search.fill(label);
  const results = commandResults(page);
  const option = results.getByRole('option', { name: label, exact: true });
  await expect(option).toBeVisible();
  await option.click();
}

export async function renameDocument(page: Page, name: string) {
  await runCommand(page, 'Rename document');
  const dialog = page.getByRole('dialog', { name: 'Rename document', exact: true });
  await expect(dialog).toBeVisible();
  const field = dialog.getByRole('textbox', { name: 'Document name' });
  await field.fill(name);
  const confirm = dialog.getByRole('button', { name: /rename|save/i });
  if (await confirm.count()) await confirm.click();
  else await field.press('Enter');
  await expect(dialog).not.toBeVisible();
}

export async function blurEditor(page: Page) {
  await page.getByRole('button', { name: 'Commands', exact: true }).focus();
}
