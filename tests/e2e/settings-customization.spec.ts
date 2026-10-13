import { expect, test, type Page } from '@playwright/test';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const settingsDialog = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const settingsTab = (page: Page, name: string) => settingsDialog(page).getByRole('tab', { name, exact: true });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('custom appearance and editor preferences persist and reset to defaults', async ({ page }) => {
  await runCommand(page, 'Settings');
  let settings = settingsDialog(page);
  await settingsTab(page, 'Appearance').click();
  await settings.getByRole('combobox', { name: 'Dark preset' }).selectOption('charcoal');
  await settings.getByRole('textbox', { name: 'Accent color', exact: true }).fill('#336699');
  await settings.getByRole('combobox', { name: 'Density' }).selectOption('comfortable');
  await settings.getByRole('spinbutton', { name: 'Sidebar width' }).fill('320');
  await settings.getByRole('checkbox', { name: 'Show status bar' }).uncheck();

  await settingsTab(page, 'Editor').click();
  await settings.getByRole('combobox', { name: 'Editor font' }).selectOption('sans');
  await settings.getByRole('spinbutton', { name: 'Line height' }).fill('2');
  await settings.getByRole('spinbutton', { name: 'Reading width' }).fill('700');
  await settings.getByRole('checkbox', { name: 'Show line numbers' }).uncheck();
  await page.keyboard.press('Escape');
  await expect(settings).not.toBeVisible();

  await page.reload();
  await runCommand(page, 'Settings');
  settings = settingsDialog(page);
  await settingsTab(page, 'Appearance').click();
  await expect(settings.getByRole('combobox', { name: 'Dark preset' })).toHaveValue('charcoal');
  await expect(settings.getByRole('textbox', { name: 'Accent color', exact: true })).toHaveValue('#336699');
  await expect(settings.getByRole('combobox', { name: 'Density' })).toHaveValue('comfortable');
  await expect(settings.getByRole('spinbutton', { name: 'Sidebar width' })).toHaveValue('320');
  await expect(settings.getByRole('checkbox', { name: 'Show status bar' })).not.toBeChecked();
  await settings.getByRole('button', { name: 'Reset appearance', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: 'Dark preset' })).toHaveValue('midnight');
  await expect(settings.getByRole('textbox', { name: 'Accent color', exact: true })).toHaveValue('#d8d8df');
  await expect(settings.getByRole('combobox', { name: 'Density' })).toHaveValue('compact');

  await settingsTab(page, 'Editor').click();
  await expect(settings.getByRole('combobox', { name: 'Editor font' })).toHaveValue('sans');
  await expect(settings.getByRole('spinbutton', { name: 'Line height' })).toHaveValue('2');
  await expect(settings.getByRole('spinbutton', { name: 'Reading width' })).toHaveValue('700');
  await expect(settings.getByRole('checkbox', { name: 'Show line numbers' })).not.toBeChecked();
  await settings.getByRole('button', { name: 'Reset editor', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: 'Editor font' })).toHaveValue('mono');
  await expect(settings.getByRole('spinbutton', { name: 'Line height' })).toHaveValue('1.7');
  await expect(settings.getByRole('spinbutton', { name: 'Reading width' })).toHaveValue('800');
  await expect(settings.getByRole('checkbox', { name: 'Show line numbers' })).toBeChecked();
});

test('shortcut remapping persists, conflicting bindings are rejected, and reset restores defaults', async ({ page }) => {
  await runCommand(page, 'Settings');
  let settings = settingsDialog(page);
  await settingsTab(page, 'Shortcuts').click();
  const newBinding = settings.getByRole('textbox', { name: 'Shortcut for New', exact: true });
  await newBinding.fill('Ctrl+Shift+J');
  await newBinding.press('Enter');
  await expect(newBinding).toHaveValue('Mod+Shift+J');

  const saveBinding = settings.getByRole('textbox', { name: 'Shortcut for Save', exact: true });
  await saveBinding.fill('Ctrl+Shift+J');
  await saveBinding.press('Enter');
  await expect(settings.getByRole('alert')).toContainText(/already assigned to New/i);
  await expect(saveBinding).not.toHaveValue('Mod+Shift+J');
  await expect(newBinding).toHaveValue('Mod+Shift+J');

  await page.keyboard.press('Escape');
  await page.reload();
  await runCommand(page, 'Settings');
  settings = settingsDialog(page);
  await settingsTab(page, 'Shortcuts').click();
  await expect(settings.getByRole('textbox', { name: 'Shortcut for New', exact: true })).toHaveValue('Mod+Shift+J');

  await page.keyboard.press('Escape');
  await source(page).focus();
  await page.keyboard.press('Control+Shift+J');
  await expect(page.getByRole('tablist', { name: 'Documents', exact: true }).getByRole('tab')).toHaveCount(2);
  await runCommand(page, 'Settings');
  settings = settingsDialog(page);
  await settingsTab(page, 'Shortcuts').click();
  await expect(settings.getByRole('textbox', { name: 'Shortcut for New', exact: true })).toHaveValue('Mod+Shift+J');
  await settings.getByRole('button', { name: 'Reset shortcut: New', exact: true }).click();
  await expect(settings.getByRole('textbox', { name: 'Shortcut for New', exact: true })).toHaveValue('Mod+N');
  await settings.getByRole('button', { name: 'Reset shortcuts', exact: true }).click();
  await expect(settings.getByRole('textbox', { name: 'Shortcut for Save', exact: true })).toHaveValue('Mod+S');
});

test('compact controls and document tabs fit a narrow desktop window without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 520 });
  await expect(source(page)).toBeVisible();
  const dimensions = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const trigger = document.querySelector<HTMLElement>('button[aria-label="Commands"]');
    const tabs = document.querySelector<HTMLElement>('[role="tablist"][aria-label="Documents"]');
    return {
      viewport: root.clientWidth,
      document: Math.max(root.scrollWidth, body.scrollWidth),
      triggerHeight: trigger?.getBoundingClientRect().height ?? Infinity,
      tabsHeight: tabs?.getBoundingClientRect().height ?? Infinity,
    };
  });
  expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.triggerHeight, JSON.stringify(dimensions)).toBeLessThanOrEqual(36);
  expect(dimensions.tabsHeight, JSON.stringify(dimensions)).toBeLessThanOrEqual(36);
});

test('Settings checkboxes align with their labels and retain pointer and keyboard toggles', async ({ page }) => {
  await runCommand(page, 'Settings');
  const settings = settingsDialog(page);
  for (const [section, name] of [['Appearance', 'Show status bar'], ['Editor', 'Show line numbers']]) {
    await settingsTab(page, section).click();
    const checkbox = settings.getByRole('checkbox', { name, exact: true });
    const delta = await checkbox.evaluate(input => {
      const label = input.parentElement!;
      const baseline = document.createElement('span'), cap = document.createElement('span');
      baseline.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      cap.style.cssText = 'position:absolute;width:0;height:1cap';
      label.append(baseline, cap);
      const box = input.getBoundingClientRect();
      const textCenter = baseline.getBoundingClientRect().top - cap.getBoundingClientRect().height / 2;
      baseline.remove(); cap.remove();
      return Math.abs(box.top + box.height / 2 - textCenter);
    });
    expect(delta).toBeLessThan(.75);
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
    await checkbox.press('Space');
    await expect(checkbox).toBeChecked();
  }
});
