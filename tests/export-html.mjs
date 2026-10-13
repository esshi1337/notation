import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server = await createServer({ cacheDir: 'node_modules/.vite-export-tests', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, logLevel: 'error' });
let passed = 0;
function test(name, run) { run(); passed++; console.log('✓ ' + name); }
try {
  const { exportFilename, htmlExportShell, externalStyleResource } = await server.ssrLoadModule('/src/export-html.ts');
  const { exportFontStyles } = await server.ssrLoadModule('/src/export-fonts.ts');
  test('HTML shell escapes note titles and forbids scripts and external resources in standalone mode', () => {
    const html = htmlExportShell('<script>title</script>', '<p>Body</p>', 'body{color:black}', true);
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('<title>&lt;script&gt;title&lt;/script&gt;</title>'));
    assert.ok(html.includes('img-src data:;')); assert.ok(!html.includes('img-src data: https:'));
    assert.ok(html.includes("default-src &#39;none&#39;")); assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('<style>body{color:black}</style>')); assert.ok(html.includes('<p>Body</p>'));
  });
  test('normal HTML permits linked images while filename generation stays an HTML export', () => {
    assert.ok(htmlExportShell('Note', '', '', false).includes('img-src data: https: http: file: blob:'));
    assert.equal(exportFilename('My note.md'), 'My note.html');
    assert.equal(exportFilename('../unusual:name.mmd'), '..-unusual-name.html');
    assert.equal(exportFilename(''), 'document.html');
  });
  test('CSS resource audit accepts SVG fragment URLs and data without backtracking over quotes', () => {
    for (const css of ['marker:url(#arrow)', 'marker:url("#arrow")', "marker:url('#arrow')", 'src:url("data:font/woff2;base64,AAA")']) assert.equal(externalStyleResource(css), false, css);
    for (const css of ['src:url(https://example.com/font)', 'background:url("../image.png")', 'fill:url( #a );background:url(https://example.com/a)']) assert.equal(externalStyleResource(css), true, css);
  });
  const body = exportFontStyles(false), math = exportFontStyles(true);
  test('export fonts are available synchronously before a native save dialog can open', () => {
    assert.equal(typeof body, 'string'); assert.equal(typeof math, 'string');
    assert.ok(body.length > 1000); assert.ok(math.length > body.length);
  });
  test('bundled Geist and KaTeX font styles embed every font with no external font URLs', () => {
    assert.ok(body.includes('font-family:"Geist"')); assert.ok(body.includes('font-family:"Geist Mono"'));
    assert.ok(math.includes('font-family:KaTeX_Main')); assert.ok(math.includes('.katex'));
    assert.equal(externalStyleResource(body), false); assert.equal(externalStyleResource(math), false);
    assert.ok([...math.matchAll(/url\("(data:font\/woff2;base64,[^"]+)"\)/gu)].length >= 20);
    assert.ok(!math.includes('url(fonts/'));
  });
  console.log(passed + ' HTML export helper scenarios passed.');
} finally { await server.close(); }
