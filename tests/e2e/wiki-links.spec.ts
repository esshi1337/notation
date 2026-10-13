import { expect, test, type Page } from '@playwright/test';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const preview = (page: Page) => page.getByRole('region', { name: 'Document preview' });

async function importMarkdown(page: Page, name: string, text: string) {
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) });
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('renders wiki aliases and heading targets while excluding frontmatter, code, and math', async ({ page }) => {
  const markdown = [
    '---',
    'related: [[Frontmatter target]]',
    '---',
    '# A heading',
    '',
    '[[Target|A display label]] [[#A heading|Jump to heading]] [[Target#Deep heading|Jump to target section]]',
    '',
    '`[[inline code]]`',
    '',
    '```md',
    '[[fenced code]]',
    '```',
    '',
    '$\\text{[[math]]}$',
  ].join('\n');
  await source(page).fill(markdown);
  await expect(preview(page).getByRole('heading', { name: 'A heading', exact: true })).toBeVisible();
  await expect(preview(page).getByRole('link', { name: 'A display label', exact: true })).toBeVisible();
  await expect(preview(page).getByRole('link', { name: 'Jump to heading', exact: true })).toBeVisible();
  await expect(preview(page).getByRole('link', { name: 'Jump to target section', exact: true })).toBeVisible();
  await expect(preview(page).getByRole('link')).toHaveCount(3);
  await expect(preview(page).getByRole('region', { name: 'Frontmatter' })).toBeVisible();
  await expect(preview(page).locator('p code')).toHaveText('[[inline code]]');
  await expect(preview(page).locator('pre code')).toContainText('[[fenced code]]');
  await expect(preview(page).locator('.katex')).toHaveCount(1);
});

test('wiki completion inserts note and heading targets from open browser tabs', async ({ page }) => {
  await importMarkdown(page, 'Target.md', '# Target\n\n## Deep heading\n\nTarget content.');
  await runCommand(page, 'New');
  await source(page).fill('[[Tar');
  const options = page.locator('.cm-tooltip-autocomplete [role="option"]');
  await expect(options.filter({ hasText: 'Target' }).first()).toBeVisible();
  await source(page).press('Enter');
  await expect(source(page)).toHaveText('[[Target]]');

  await source(page).fill('[[Ta]]');
  await source(page).press('ArrowLeft');
  await source(page).press('ArrowLeft');
  await source(page).pressSequentially('r');
  await expect(options.filter({ hasText: 'Target' }).first()).toBeVisible();
  await source(page).press('Enter');
  await expect(source(page)).toHaveText('[[Target]]');

  await source(page).fill('[[Target#Dee]]');
  await source(page).press('ArrowLeft');
  await source(page).press('ArrowLeft');
  await source(page).pressSequentially('p');
  await expect(options.filter({ hasText: 'Deep heading' }).first()).toBeVisible();
  await source(page).press('Enter');
  await expect(source(page)).toHaveText('[[Target#Deep heading]]');

  await runCommand(page, 'Live Preview');
  const liveLink = page.locator('.cm-live-wiki[title="Target#Deep heading"]');
  await expect(liveLink).toBeVisible();
  await liveLink.click();
  await expect(page.getByRole('tab', { name: 'Target.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.editor-tab-host:not([hidden]) .cm-activeLine').filter({ hasText: 'Deep heading' })).toBeVisible();
  await page.getByRole('tab', { name: 'untitled.md', exact: true }).click();
  await runCommand(page, 'Source');
  await expect(source(page)).toHaveText('[[Target#Deep heading]]');
});

test('wiki completion stays inactive in fenced code and math', async ({ page }) => {
  const suggestions = page.locator('.cm-tooltip-autocomplete');
  await source(page).fill('```md\n[[Target');
  await expect(suggestions).toHaveCount(0);
  await source(page).fill('$$\n[[Target');
  await expect(suggestions).toHaveCount(0);
});

test('Mod+Enter follows a plain wiki reference at the editor caret', async ({ page }) => {
  await importMarkdown(page, 'Target.md', '# Target\n\n## Reference destination\n\nReference body.');
  await runCommand(page, 'New');
  await source(page).fill('[[Target#Reference destination]]');
  await source(page).press('ControlOrMeta+Enter');
  await expect(page.getByRole('tab', { name: 'Target.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.editor-tab-host:not([hidden]) .cm-activeLine').filter({ hasText: 'Reference destination' })).toBeVisible();
});
