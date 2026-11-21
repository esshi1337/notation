import { expect, test, type Page } from '@playwright/test';
import { runCommand } from './commands';

/** Load the app as a desktop window whose backend reports the given engine status. */
async function openDesktop(page: Page, status: Record<string, unknown>) {
  await page.addInitScript((engineStatus) => {
    Object.assign(window, {
      isTauri: true,
      exportCalls: [] as string[],
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: (path: string) => path,
        async invoke(cmd: string) {
          (window as unknown as { exportCalls: string[] }).exportCalls.push(cmd);
          if (cmd === 'bootstrap_state') return { settings: {}, draft: null, scriptDraft: null, scripts: [], recents: [], workspace: null, workspaceCatalog: { activeId: null, workspaces: [] }, session: null };
          if (cmd === 'engine_status') return engineStatus;
          if (cmd === 'launch_ready') return [];
          if (cmd === 'plugin:event|listen') return 1;
          return null;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
    });
  }, status);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Document source' })).toBeVisible();
  await runCommand(page, 'Export');
  return page.getByRole('region', { name: 'Export', exact: true });
}

test('a platform without native engines shows PDF, DOCX and PPTX as unavailable', async ({ page }) => {
  const message = 'Not available on macOS yet. PDF, DOCX and PPTX export, citations and D2, PlantUML and Graphviz diagrams run only inside the Linux sandbox.';
  const panel = await openDesktop(page, { available: false, platformSupported: false, engines: { pandoc: false, typst: false, d2: false, plantuml: false }, resourceDir: '/x', error: message });
  const format = panel.getByRole('combobox', { name: 'Export format' });
  await expect(panel.getByRole('note')).toContainText('not available on this platform yet');
  for (const value of ['pdf', 'docx', 'pptx']) await expect(format.locator(`option[value="${value}"]`)).toHaveJSProperty('disabled', true);
  for (const value of ['html', 'self-contained']) await expect(format.locator(`option[value="${value}"]`)).toHaveJSProperty('disabled', false);
  await expect(format).toHaveValue('html');
  await expect(panel.getByText(/reinstall/iu)).toHaveCount(0);
});

test('a supported platform keeps every export format selectable', async ({ page }) => {
  const panel = await openDesktop(page, { available: true, platformSupported: true, engines: { pandoc: true, typst: true, d2: true, plantuml: true }, resourceDir: '/x' });
  const format = panel.getByRole('combobox', { name: 'Export format' });
  for (const value of ['html', 'self-contained', 'pdf', 'docx', 'pptx']) await expect(format.locator(`option[value="${value}"]`)).toHaveJSProperty('disabled', false);
  await expect(panel.getByRole('note')).toHaveCount(0);
  await format.selectOption('pdf');
  await expect(format).toHaveValue('pdf');
});
