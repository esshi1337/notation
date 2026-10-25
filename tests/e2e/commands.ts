import { expect, type Page } from '@playwright/test';

export const commandPalette = (page: Page) => page.getByRole('dialog', { name: 'Commands', exact: true });
export const commandResults = (page: Page) => commandPalette(page).getByRole('listbox', { name: 'Commands', exact: true });

export async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'App menu', exact: true }).click();
  await page.getByRole('menu', { name: 'App menu', exact: true }).getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
}

/** Opt in to Scripts through Settings; the preference is off by default. */
export async function enableScripts(page: Page) {
  await openSettings(page);
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  const toggle = settings.getByRole('checkbox', { name: 'Enable scripts', exact: true });
  if (!(await toggle.isChecked())) await toggle.check();
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await expect(settings).toHaveCount(0);
}

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

const settingLabels: Record<string, string> = {
  dark: 'Dark', light: 'Light', compact: 'Compact', comfortable: 'Comfortable',
  left: 'Left', right: 'Right', midnight: 'Midnight', charcoal: 'Charcoal',
  mono: 'IBM Plex Mono', sans: 'Source Sans 3', source: 'Source', split: 'Split',
  preview: 'Preview', live: 'Live Preview', '220': 'Narrow', '260': 'Standard', '340': 'Wide',
};
const segmentedSettings = ['Theme', 'Density', 'Sidebar position'];
export async function setSetting(page: Page, name: string, value: string) {
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const label = settingLabels[value] ?? value;
  if (segmentedSettings.includes(name)) {
    await settings.getByRole('radiogroup', { name, exact: true }).getByRole('radio', { name: label, exact: true }).click();
  } else {
    await settings.getByRole('combobox', { name, exact: true }).click();
    await settings.getByRole('option', { name: new RegExp('^' + label + '(?:\\s|$)') }).click();
  }
}
export async function expectSetting(page: Page, name: string, value: string) {
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const label = settingLabels[value] ?? value;
  if (segmentedSettings.includes(name)) {
    await expect(settings.getByRole('radiogroup', { name, exact: true }).getByRole('radio', { name: label, exact: true })).toHaveAttribute('aria-checked', 'true');
  } else await expect(settings.getByRole('combobox', { name, exact: true })).toContainText(label);
}
