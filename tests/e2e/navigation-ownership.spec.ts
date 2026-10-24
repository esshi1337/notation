import { expect, test } from '@playwright/test';
import { openSettings } from './commands';

for (const theme of ['dark', 'light']) {
  test(`${theme} navigation gives tools and app actions separate homes`, async ({ page }) => {
    await page.addInitScript(theme => localStorage.setItem('notation.settings', JSON.stringify({ theme })), theme);
    await page.goto('/');
    const sidebar = page.getByRole('navigation', { name: 'App sidebar' });
    const tools = ['Explorer', 'Workspace', 'Note graph', 'Git', 'History', 'Properties', 'Templates', 'Table editor', 'Scripts'];
    await expect(sidebar.getByRole('button')).toHaveCount(tools.length);
    for (const name of tools) await expect(sidebar.getByRole('button', { name: `${name} panel`, exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Open settings', exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole('button', { name: 'Export panel', exact: true })).toHaveCount(0);
    for (const name of ['New document', 'Commands', 'Open workspace panel']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
    const graph = sidebar.getByRole('button', { name: 'Note graph panel' }).locator('svg');
    const git = sidebar.getByRole('button', { name: 'Git panel' }).locator('svg');
    await expect(git).toHaveAttribute('data-icon', 'git');
    expect(await git.getAttribute('data-icon-source')).not.toBe(await graph.getAttribute('data-icon-source'));

    await page.getByRole('button', { name: 'App menu', exact: true }).click();
    const menu = page.getByRole('menu', { name: 'App menu', exact: true });
    for (const name of tools) await expect(menu.locator(`button[aria-label="${name}"]`)).toHaveCount(0);
    for (const name of ['New', 'Commands', 'Open', 'Save', 'Save As', 'Rename document', 'Export', 'Settings']) {
      await expect(menu.locator(`button[aria-label="${name}"]`)).toHaveCount(1);
    }
    await expect(menu.locator('.compact-menu-brand')).toHaveText('Notation');
    const brand = await menu.locator('.compact-menu-brand').evaluate(element => {
      const area = element.getBoundingClientRect(), icon = element.querySelector('svg')!.getBoundingClientRect();
      const title = element.querySelector('strong')!.getBoundingClientRect();
      return { horizontal: Math.abs((icon.left + title.right) / 2 - (area.left + area.right) / 2), vertical: Math.abs(icon.y + icon.height / 2 - title.y - title.height / 2) };
    });
    expect(brand.horizontal).toBeLessThan(.6);
    expect(brand.vertical).toBeLessThan(.6);
    await page.screenshot({ path: `test-results/navigation-${theme}.png` });
    await page.keyboard.press('Escape');
    await openSettings(page);
    await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close settings' }).click();
    await expect(page.getByRole('button', { name: 'App menu', exact: true })).toBeFocused();
    await sidebar.getByRole('button', { name: 'Scripts panel' }).click();
    await expect(page.getByRole('dialog', { name: 'Scripts', exact: true })).toBeVisible();
  });
}
