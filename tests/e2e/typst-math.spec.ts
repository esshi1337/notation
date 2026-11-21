import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openSettings, runCommand, setSetting } from './commands';
import { INVALID, LATEX, TEX_FALLBACK, TYPST, corpusNote } from '../math-corpus.mjs';

const source = (page: Page) => page.getByRole('textbox', { name: 'Document source' });
const reading = (page: Page) => page.getByRole('region', { name: 'Document preview' });
const equations = (page: Page) => reading(page).locator('.rendered-math');
const engines = (page: Page) => equations(page).evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.mathEngine));
const settledPreview = async (page: Page, count: number) => {
  await expect(equations(page)).toHaveCount(count);
  await expect(reading(page).locator('[data-math-engine="pending"]')).toHaveCount(0);
  await expect(reading(page)).toHaveAttribute('aria-busy', 'false');
};
/** Requests that leave the app's own origin while the page is in use. */
function watchNetwork(page: Page) {
  const external: string[] = [];
  page.on('request', (request) => { const url = new URL(request.url()); if (!['127.0.0.1', 'localhost'].includes(url.hostname) && !['data:', 'blob:'].includes(url.protocol)) external.push(request.url()); });
  return external;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(source(page)).toBeVisible();
});

test('Typst math is the default, LaTeX is detected, and plain TeX falls back to KaTeX, all offline', async ({ page }) => {
  const external = watchNetwork(page);
  const entries = [...TYPST, ...LATEX, ...TEX_FALLBACK];
  await source(page).fill(corpusNote(entries));
  await settledPreview(page, entries.length);
  const rendered = await engines(page);
  const expected = [...TYPST.map(() => 'typst'), ...LATEX.map(() => 'latex'), ...TEX_FALLBACK.map(() => 'latex')];
  for (const [index, entry] of entries.entries()) expect(rendered[index], entry.s).toBe(expected[index]);
  await expect(reading(page).getByRole('alert')).toHaveCount(0);
  await expect(reading(page).locator('svg.typst-math-svg')).toHaveCount(TYPST.length);
  await expect(reading(page).locator('.katex')).toHaveCount(LATEX.length + TEX_FALLBACK.length);
  // The fallback says why Typst was not used.
  await expect(equations(page).nth(TYPST.length + LATEX.length)).toHaveAttribute('title', /KaTeX fallback.*unknown variable/u);
  await expect(equations(page).first()).toHaveAttribute('title', 'Typst math');
  expect(external).toEqual([]);
});

test('the Typst engine is loaded only when a note contains Typst math', async ({ page }) => {
  const loaded: string[] = [];
  page.on('request', (request) => { if (/typst.*\.wasm|typst-worker|NewCMMath/u.test(request.url())) loaded.push(request.url()); });
  await source(page).fill('# LaTeX only\n\nInline $\\frac{a}{b}$ and $\\alpha^{2}$.\n\n$$\n\\sum_{i=1}^{n} i\n$$\n');
  await settledPreview(page, 3);
  expect(await engines(page)).toEqual(['latex', 'latex', 'latex']);
  expect(page.workers()).toHaveLength(0);
  expect(loaded).toEqual([]);
  await source(page).fill('# Typst\n\nInline $a/b$.\n');
  await settledPreview(page, 1);
  expect(await engines(page)).toEqual(['typst']);
  expect(loaded.some((url) => url.includes('typst_ts_web_compiler_bg'))).toBe(true);
  expect(loaded.some((url) => url.includes('NewCMMath-Book'))).toBe(true);
});

test('invalid math shows a localized error from the engine that owns it', async ({ page }) => {
  await source(page).fill(corpusNote(INVALID) + '\nStill readable.\n');
  await settledPreview(page, INVALID.length);
  const alerts = reading(page).getByRole('alert');
  await expect(alerts).toHaveCount(INVALID.length);
  await expect(alerts.nth(0)).toContainText('Math error: KaTeX parse error');
  await expect(alerts.nth(1)).toContainText('Math error: Typst: ');
  await expect(reading(page)).toContainText('Still readable.');
  await runCommand(page, 'Live Preview');
  await expect(page.locator('.cm-live-math').getByRole('alert')).toHaveCount(INVALID.length);
  await expect(page.locator('.cm-live-math').getByRole('alert').nth(1)).toContainText('Math error: Typst: ');
});

test('a math property overrides detection for one note', async ({ page }) => {
  const body = '\nA $a/b$ and B $\\frac{a}{b}$ and C $mat(1, 2; 3, 4)$.\n';
  await source(page).fill(body);
  await settledPreview(page, 3);
  expect(await engines(page)).toEqual(['typst', 'latex', 'typst']);

  await source(page).fill('---\nmath: latex\n---\n' + body);
  await settledPreview(page, 3);
  // LaTeX only: exactly the pre-Typst behaviour, a slash and literal letters.
  expect(await engines(page)).toEqual(['latex', 'latex', 'latex']);
  await expect(reading(page).locator('svg.typst-math-svg')).toHaveCount(0);

  await source(page).fill('---\nmath: typst\n---\n' + body);
  await settledPreview(page, 3);
  // Typst only: no fallback, so the LaTeX equation is an error.
  expect(await engines(page)).toEqual(['typst', 'error', 'typst']);
  await expect(reading(page).getByRole('alert')).toContainText('Math error: Typst: ');

  await runCommand(page, 'Live Preview');
  const live = page.locator('.cm-live-math');
  await expect(live).toHaveCount(3);
  await expect.poll(() => live.evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.mathEngine))).toEqual(['typst', 'error', 'typst']);
});

test('the Settings default selects the engine for notes without a property and persists', async ({ page }) => {
  await source(page).fill('# Default\n\nA $a/b$ and B $\\frac{a}{b}$.\n');
  await settledPreview(page, 2);
  expect(await engines(page)).toEqual(['typst', 'latex']);
  await openSettings(page);
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Editor', exact: true }).click();
  await setSetting(page, 'Math syntax', 'LaTeX only');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect.poll(() => engines(page)).toEqual(['latex', 'latex']);
  await runCommand(page, 'Live Preview');
  await expect.poll(() => page.locator('.cm-live-math').evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.mathEngine))).toEqual(['latex', 'latex']);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('notation.settings') || '{}').mathSyntax)).toBe('latex');
  await page.reload();
  await expect(page.locator('.cm-live-math').first()).toBeVisible();
  await expect.poll(() => page.locator('.cm-live-math').evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.mathEngine))).toEqual(['latex', 'latex']);
});

test('Typst equations follow the text colour, sit on the baseline and scroll when wide', async ({ page }) => {
  const wide = Array.from({ length: 60 }, (_, index) => 'x_' + (index + 1)).join(' + ');
  await source(page).fill('# Layout\n\nBase x $x$ and deep $y_j + q$ and tall $sum_(i=1)^n x_i$ text.\n\n$$\n' + wide + ' = 0\n$$\n\n$$\na/b\n$$\n');
  await settledPreview(page, 5);
  const geometry = await reading(page).evaluate((region) => {
    const svgs = [...region.querySelectorAll<SVGSVGElement>('svg.typst-math-svg')];
    const paragraph = svgs[0].closest('p')!;
    // A zero-size inline box sits exactly on the paragraph's text baseline.
    const probe = document.createElement('span'); probe.style.cssText = 'display:inline-block;width:0;height:0'; paragraph.prepend(probe);
    const baseline = probe.getBoundingClientRect().bottom; probe.remove();
    const inline = svgs.slice(0, 3).map((svg) => {
      const box = svg.getBoundingClientRect(), descent = -parseFloat(svg.style.verticalAlign) * parseFloat(getComputedStyle(svg).fontSize);
      return { offset: box.bottom - baseline - descent, descent, height: box.height };
    });
    const displays = [...region.querySelectorAll<HTMLElement>('.typst-display')];
    const text = getComputedStyle(paragraph).color;
    const ink = getComputedStyle(svgs[0].querySelector('path')!).fill;
    const centre = (element: Element) => { const box = element.getBoundingClientRect(); return box.left + box.width / 2; };
    return {
      inline, text, ink,
      wide: { client: displays[0].clientWidth, scroll: displays[0].scrollWidth, overflow: getComputedStyle(displays[0]).overflowX, page: region.scrollWidth - region.clientWidth },
      centred: Math.abs(centre(displays[1].querySelector('svg')!) - centre(displays[1])),
    };
  });
  // The SVG's bottom edge is its descent below the baseline, to within a pixel.
  for (const item of geometry.inline) expect(Math.abs(item.offset)).toBeLessThanOrEqual(1);
  expect(geometry.inline[0].descent).toBeLessThan(1);
  expect(geometry.inline[1].descent).toBeGreaterThan(3);
  expect(geometry.inline[2].height).toBeGreaterThan(geometry.inline[0].height);
  expect(geometry.ink).toBe(geometry.text);
  expect(geometry.wide.overflow).toBe('auto');
  expect(geometry.wide.scroll).toBeGreaterThan(geometry.wide.client + 100);
  expect(geometry.wide.page).toBeLessThanOrEqual(0);
  expect(geometry.centred).toBeLessThanOrEqual(1);

  // The same SVG takes the other theme's text colour without recompiling.
  const before = geometry.ink;
  await openSettings(page);
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await setSetting(page, 'Theme', 'light');
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await settledPreview(page, 5);
  const after = await reading(page).evaluate((region) => ({ ink: getComputedStyle(region.querySelector('svg.typst-math-svg path')!).fill, text: getComputedStyle(region.querySelector('p')!).color }));
  expect(after.ink).toBe(after.text);
  expect(after.ink).not.toBe(before);
});

test('click-to-edit, keyboard editing and re-rendering work for Typst equations in Live Preview', async ({ page }) => {
  await source(page).fill('# Edit\n\nValue $a/b$.\n\n$$\nsum_(i=1)^n i\n$$\n\nEnd.');
  await runCommand(page, 'Live Preview');
  const inline = page.getByRole('button', { name: 'Edit inline equation' });
  const block = page.getByRole('button', { name: 'Edit block equation' });
  await expect(inline.locator('svg.typst-math-svg')).toBeVisible();
  await expect(block.locator('.typst-display svg.typst-math-svg')).toBeVisible();
  await expect(inline).toHaveAttribute('title', 'Typst math');
  await inline.click();
  await expect(source(page)).toContainText('$a/b$');
  await source(page).locator('.cm-line').filter({ hasText: 'Value $a/b$.' }).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('# Edit\n\nValue $c/d + 1$.\n\n$$\nsum_(i=1)^n i\n$$\n\nEnd.');
  await page.getByRole('button', { name: 'Commands', exact: true }).focus();
  await expect(inline.locator('svg.typst-math-svg')).toHaveAttribute('aria-label', 'c/d + 1');
  await block.focus();
  await block.press('Enter');
  await expect(source(page)).toContainText('sum_(i=1)^n i');
  await page.getByRole('button', { name: 'Commands', exact: true }).focus();
  await expect(block.locator('svg.typst-math-svg')).toBeVisible();
  const pending = page.waitForEvent('download');
  await runCommand(page, 'Save');
  expect(await readFile((await (await pending).path())!, 'utf8')).toBe('# Edit\n\nValue $c/d + 1$.\n\n$$\nsum_(i=1)^n i\n$$\n\nEnd.');
});

test('rendered Typst SVG is inert: no links, scripts, foreign content or shared ids', async ({ page }) => {
  await source(page).fill('# Safe\n\n$#link("javascript:alert(1)")[x] + #text(red)[y]$ and $x$ and $x$.\n\n$#read("/etc/passwd")$\n');
  await settledPreview(page, 4);
  expect(await engines(page)).toEqual(['typst', 'typst', 'typst', 'error']);
  const audit = await reading(page).evaluate((region) => {
    const svgs = [...region.querySelectorAll('svg.typst-math-svg')];
    const elements = svgs.flatMap((svg) => [...svg.querySelectorAll('*')]);
    return {
      tags: [...new Set(elements.map((element) => element.localName))].sort(),
      ids: elements.filter((element) => element.id).length,
      handlers: elements.flatMap((element) => [...element.attributes]).filter((attribute) => /^on|href|style|class/u.test(attribute.name)).length,
      red: elements.some((element) => /^#?(?:ff4136|red)/iu.test(element.getAttribute('fill') ?? '')),
    };
  });
  expect(audit.tags).toEqual(['g', 'path']);
  expect(audit.ids).toBe(0);
  expect(audit.handlers).toBe(0);
  expect(audit.red).toBe(true);
  await expect(reading(page).getByRole('alert')).toContainText('Math error: Typst: ');
});

test('a runaway equation is stopped and the next equation still renders', async ({ page }) => {
  test.setTimeout(60_000);
  // Typst refuses `while true`; a long counted loop is accepted and never finishes in time.
  const runaway = '$#{ let n = 0; for a in range(3000) { for b in range(3000) { for c in range(3000) { n += 1 } } } }$';
  await source(page).fill('# Runaway\n\n' + runaway + '\n');
  await expect(reading(page).getByRole('alert')).toContainText('took too long to compile', { timeout: 30_000 });
  await source(page).fill('# Runaway\n\n' + runaway + ' then $a/b$.\n');
  await settledPreview(page, 2);
  expect(await engines(page)).toEqual(['error', 'typst']);
});

test('the Typst engine starts under the desktop Content-Security-Policy', async ({ page, baseURL }) => {
  // The packaged app serves every file with this policy; the dev server sends
  // none. It forbids evaluating JavaScript from strings, also inside workers.
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')) as { app: { security: { devCsp: string } } };
  const origin = new URL(baseURL!).host;
  const policy = config.app.security.devCsp.replaceAll('127.0.0.1:1420', origin);
  expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
  const governed: string[] = [];
  await page.route((url) => url.pathname === '/' || url.pathname.includes('typst-worker'), async (route) => {
    const response = await route.fetch();
    governed.push(new URL(route.request().url()).pathname);
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } });
  });
  const violations: string[] = [];
  page.on('console', (message) => { if (/Content Security Policy/iu.test(message.text())) violations.push(message.text()); });
  await page.goto('/');
  await expect(source(page)).toBeVisible();
  await source(page).fill('# Policy\n\nA $sum_(i=1)^n x_i$ and $#read("secret.txt")$.\n');
  await settledPreview(page, 2);
  expect(await engines(page)).toEqual(['typst', 'error']);
  await expect(reading(page).getByRole('alert')).toContainText('Math error: Typst: ');
  await expect(reading(page).getByRole('alert')).not.toContainText('could not start');
  expect(governed.some((path) => path.includes('typst-worker'))).toBe(true);
  expect(violations.filter((text) => /script|eval/iu.test(text))).toEqual([]);
});

test('self-contained HTML export embeds Typst math as SVG and LaTeX math as KaTeX, with no scripts', async ({ page }) => {
  await source(page).fill('# Export math\n\nTypst $sum_(i=1)^n x_i$ and LaTeX $\\frac{a}{b}$.\n\n$$\nintegral_0^oo e^(-x^2) dif x\n$$\n');
  await settledPreview(page, 3);
  await runCommand(page, 'Export');
  const panel = page.getByRole('region', { name: 'Export', exact: true });
  await panel.getByRole('combobox', { name: 'Export format' }).selectOption('self-contained');
  const pending = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export document', exact: true }).click();
  const html = await readFile((await (await pending).path())!, 'utf8');
  expect(html).not.toMatch(/<script\b/iu);
  expect(html).not.toContain('math-pending');
  expect((html.match(/<svg[^>]*class="typst-math-svg"/gu) ?? []).length).toBe(2);
  expect(html).toContain('aria-label="sum_(i=1)^n x_i"');
  expect(html).toContain('currentColor');
  expect(html).toContain('class="katex"');
  expect(html).toContain('.typst-display{');
  const offline = await page.context().newPage();
  await offline.route('**/*', (route) => route.abort());
  await offline.setContent(html);
  await expect(offline.locator('svg.typst-math-svg')).toHaveCount(2);
  const box = await offline.locator('svg.typst-math-svg').first().boundingBox();
  expect(box!.width).toBeGreaterThan(20);
  expect(box!.height).toBeGreaterThan(10);
  const colours = await offline.evaluate(() => ({ ink: getComputedStyle(document.querySelector('svg.typst-math-svg path')!).fill, text: getComputedStyle(document.querySelector('main p')!).color }));
  expect(colours.ink).toBe(colours.text);
  await offline.close();
});

test('the native converter receives Typst equations as source markers and LaTeX as TeX', async ({ page }) => {
  const markdown = '# Converter\n\nTypst $a/b$ and LaTeX $\\frac{1}{2}$.\n\n$$\nsum_(i=1)^n x_i\n$$\n\nMid-sentence $$x^2$$ display.\n';
  await source(page).fill(markdown);
  await settledPreview(page, 4);
  const result = await page.evaluate(async (text) => {
    const { buildHtmlExport } = await import('/src/export-html.ts');
    const { prepareConverterHtml } = await import('/src/export-converter.ts');
    const built = await buildHtmlExport({ name: 'converter.md', text, documentId: 1 }, { format: 'self-contained', theme: 'light' });
    const pdf = prepareConverterHtml(built.html), office = prepareConverterHtml(built.html, { images: true });
    const markers = (content: string) => {
      const template = document.createElement('template'); template.innerHTML = content;
      return Array.from(template.content.querySelectorAll<HTMLElement>('span.notation-typst-math'), (marker) => ({
        typst: marker.dataset.typst, display: marker.dataset.display, width: Number(marker.dataset.width), height: Number(marker.dataset.height),
        svg: marker.dataset.svg ?? null, parent: marker.parentElement?.localName ?? null, alone: marker.parentElement?.childNodes.length === 1, empty: marker.childNodes.length === 0,
        picture: (() => {
          if (!marker.dataset.svg) return null;
          const root = new DOMParser().parseFromString(marker.dataset.svg, 'image/svg+xml').documentElement;
          return { root: root.localName, invalid: !!root.querySelector('parsererror'), width: Number(root.getAttribute('width')), height: Number(root.getAttribute('height')), paths: root.querySelectorAll('path').length };
        })(),
      }));
    };
    return { pdf: markers(pdf.content), office: markers(office.content), pdfContent: pdf.content, assets: [pdf.assets.length, office.assets.length] };
  }, markdown);
  expect(result.pdf.map((marker) => [marker.typst, marker.display])).toEqual([['a/b', '0'], ['sum_(i=1)^n x_i', '1'], ['x^2', '1']]);
  // A block equation is a paragraph of its own; the others stay in their sentence.
  expect(result.pdf.map((marker) => [marker.parent, marker.alone])).toEqual([['p', false], ['p', true], ['p', false]]);
  for (const marker of result.pdf) {
    expect(marker.empty).toBe(true);
    expect(marker.width).toBeGreaterThan(3);
    expect(marker.height).toBeGreaterThan(3);
    // PDF needs no picture: the Typst engine typesets the source.
    expect(marker.svg).toBeNull();
  }
  expect(result.pdfContent).toContain('\\(\\frac{1}{2}\\)');
  expect(result.pdfContent).not.toMatch(/<svg|typst-math-svg|class="katex"/u);
  // Equations are not figures: they do not use the 100-asset budget.
  expect(result.assets).toEqual([0, 0]);
  for (const [index, marker] of result.office.entries()) {
    expect(marker.typst).toBe(result.pdf[index].typst);
    // A standalone SVG: black ink at four times the point size, with nothing page-specific left.
    expect(marker.picture).toMatchObject({ root: 'svg', invalid: false });
    expect(marker.picture!.width).toBeCloseTo(marker.width * 4, 1);
    expect(marker.picture!.height).toBeCloseTo(marker.height * 4, 1);
    expect(marker.picture!.paths).toBeGreaterThan(0);
    expect(marker.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(marker.svg).toContain('#000000');
    expect(marker.svg).not.toMatch(/currentColor|style=|class=|<script|href=/u);
  }
});
