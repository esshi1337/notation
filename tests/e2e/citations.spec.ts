import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { runCommand } from './commands';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source', exact: true });
const preview = (page: Page) => page.getByRole('region', { name: 'Document preview', exact: true });

const document = [
  '---',
  'references:',
  '  - id: doe2020',
  '    type: book',
  '    title: Test Book',
  '    author:',
  '      - family: Doe',
  '        given: Jane',
  '    issued:',
  '      date-parts: [[2020]]',
  '---',
  '',
  'A narrative [@doe2020] citation and a suppressed [-@doe2020] citation.',
  '',
  '`[@code]` and $[@math]$ stay literal.',
  '',
  'An email author@example.test and [@link](https://example.test) are not citations.',
].join('\n');

async function exportMarkdown(page: Page) {
  const pending = page.waitForEvent('download');
  await runCommand(page, 'Save');
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error('Markdown export did not provide a file.');
  return readFile(path, 'utf8');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
  await source(page).fill(document);
});

test('Preview exposes citation placeholders and explains native CSL formatting requirement', async ({ page }) => {
  await runCommand(page, 'Preview');
  const bibliography = preview(page).getByRole('region', { name: 'Bibliography', exact: true });
  await expect(bibliography.getByRole('alert')).toContainText(/citation formatting requires the desktop app/i);
  const citations = preview(page).locator('.citation-reference');
  await expect(citations).toHaveCount(2);
  await expect(citations.nth(0)).toHaveText('[@doe2020]');
  await expect(citations.nth(1)).toHaveText('[-@doe2020]');
  expect(await exportMarkdown(page)).toBe(document);
});

test('Live Preview decorates citations without replacing their source text', async ({ page }) => {
  await runCommand(page, 'Live Preview');
  const citations = source(page).locator('.cm-live-citation');
  await expect(citations).toHaveCount(2);
  await expect(citations.nth(0)).toHaveText('[@doe2020]');
  await expect(source(page).locator('.cm-live-bibliography [role="alert"]')).toContainText(/citation formatting requires the desktop app/i);
  expect(await exportMarkdown(page)).toBe(document);
});


test('native-shaped citation fragments stay inline, retain formatting, and navigate to their bibliography', async ({ page }) => {
  const geometry = await page.evaluate(async () => {
    // Vite serves the public helper in the same browser realm as the app.
    // @ts-expect-error Browser-only Vite module path.
    const { inlineCitationHTML, sanitizeCitationHTML, connectCitationLinks } = await import('/src/render-citations.ts');
    const paragraph = document.createElement('p');
    paragraph.className = 'native-citation-regression';
    paragraph.style.cssText = 'position:fixed;left:20px;top:80px;width:600px;z-index:9999;background:var(--bg);font:14px/1.7 Geist,sans-serif';
    paragraph.append(document.createTextNode('A fact '));
    const citation = document.createElement('span'); citation.className = 'citation-reference';
    citation.innerHTML = inlineCitationHTML('<div><p><span class="citation"><a href="#ref-doe2020">(<em>Doe</em> 2020<sup>a</sup>)</a></span></p></div>');
    paragraph.append(citation, document.createTextNode('.'));
    const bibliography = document.createElement('section'); bibliography.id = 'regression-ref-doe2020'; bibliography.style.cssText = 'position:fixed;left:20px;top:180px;z-index:9999;background:var(--bg)';
    bibliography.innerHTML = sanitizeCitationHTML('<div class="csl-entry"><p>Doe, Jane. <em>Test Book.</em></p></div>');
    bibliography.setAttribute('role','region'); bibliography.setAttribute('aria-label','Regression bibliography');
    document.body.append(paragraph,bibliography);
    connectCitationLinks(citation,'regression-',()=>true);
    const before = document.createRange(); before.selectNodeContents(paragraph.firstChild!);
    const after = document.createRange(); after.selectNodeContents(paragraph.lastChild!);
    const link = citation.querySelector('a')!;
    const label = document.createRange(); label.selectNodeContents(citation.querySelector('em')!);
    return { before:before.getBoundingClientRect().y, citation:label.getBoundingClientRect().y, after:after.getBoundingClientRect().y, width:link.getBoundingClientRect().width };
  });
  const paragraph = page.locator('.native-citation-regression');
  await expect(paragraph.locator('.citation-reference p,.citation-reference div,.citation-reference section')).toHaveCount(0);
  await expect(paragraph.locator('em')).toHaveText('Doe');
  await expect(paragraph.locator('sup')).toHaveText('a');
  expect(Math.abs(geometry.before - geometry.citation)).toBeLessThan(2);
  expect(Math.abs(geometry.after - geometry.citation)).toBeLessThan(2);
  expect(geometry.width).toBeLessThan(200);
  await paragraph.getByRole('link').click();
  await expect(page.getByRole('region', { name:'Regression bibliography',exact:true })).toBeFocused();
  await expect(page.getByRole('region', { name:'Regression bibliography',exact:true }).locator('p')).toHaveCount(1);
});
