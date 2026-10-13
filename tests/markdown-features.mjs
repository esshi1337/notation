import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server = await createServer({ cacheDir: 'node_modules/.vite-markdown-features', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, logLevel: 'error' });
let passed = 0;
function check(name, run) { run(); passed++; console.log('✓ ' + name); }
try {
  const { renderMarkdown, calloutKind, calloutIcon } = await server.ssrLoadModule('/src/render-markdown.ts');
  const { analyzeMarkdown, markdownSource } = await server.ssrLoadModule('/src/markdown-features.ts');
  const { wikiCompletionAt, findWikiHeadingLine, scanWikiHeadings } = await server.ssrLoadModule('/src/wiki-links.ts');
  check('nested callouts map every checkbox back to its exact Markdown marker', () => {
    const text = '> [!warning] Outer\n> [] first\n>\n> > [!question]- Inner\n> > - [x] second\n> >\n> > [[Other#Heading|alias]] and $x$\n> >\n> > ```mermaid\n> > graph TD; A-->B\n> > ```\n\n- [ ] third';
    const result = renderMarkdown(text);
    assert.deepEqual(result.callouts.map(c => c.type), ['WARNING', 'QUESTION']);
    assert.deepEqual(result.tasks.map(t => t.label), ['first', 'second', 'third']);
    for (const task of result.tasks) assert.equal(text.slice(task.from, task.to), task.marker);
    assert.equal(result.links[0].target, 'Other#Heading|alias');
    assert.equal(result.maths.length, 1); assert.equal(result.diagrams.length, 1);
    assert.deepEqual([...result.html.matchAll(/data-task-index="(\d+)"/g)].map(m => +m[1]), [0, 1, 2]);
    assert.deepEqual([...result.html.matchAll(/data-callout-index="(\d+)"/g)].map(m => +m[1]), [0, 1]);
  });
  check('ordinary quotes and list-contained callouts retain correct sibling task positions', () => {
    const text = '- Item\n\n  > [!tip] In list\n  > [] inner\n\n> ordinary\n>\n> > [!danger] Nested\n> > [] deeper\n\n[] outside';
    const result = renderMarkdown(text);
    assert.deepEqual(result.callouts.map(c => c.type), ['TIP', 'DANGER']);
    assert.deepEqual(result.tasks.map(t => t.label), ['inner', 'deeper', 'outside']);
    for (const task of result.tasks) assert.equal(text.slice(task.from, task.to), task.marker);
  });
  check('frontmatter masking preserves UTF-16 and CRLF source offsets', () => {
    const text = '\uFEFF---\r\ntitle: "😀 [[ignored]]"\r\ntags: [x]\r\n...\r\n# Body\r\n\r\n[] real\r\n[[Note]]';
    assert.equal(markdownSource(text).length, text.length);
    const result = renderMarkdown(text), features = analyzeMarkdown(text);
    assert.equal(result.frontmatter.values.title, '😀 [[ignored]]');
    assert.equal(features.tasks.length, 1); assert.equal(features.links.length, 1);
    assert.equal(text.slice(features.tasks[0].from, features.tasks[0].to), '[]');
    assert.equal(text.slice(result.tasks[0].from, result.tasks[0].to), '[]');
    assert.equal(result.links.length, 1);
  });
  check('CRLF callouts and empty tasks render with exact source ranges', () => {
    const text = '> [!warning] Windows\r\n> []\r\n>\r\n> > [!tip] Nested\r\n> > [x] done\r\n\r\n[]\r\n';
    const result = renderMarkdown(text);
    assert.deepEqual(result.callouts.map(c => c.type), ['WARNING', 'TIP']);
    assert.equal(result.tasks.length, 3);
    for (const task of result.tasks) assert.equal(text.slice(task.from, task.to), task.marker);
  });
  check('wikilinks stay literal inside code, math, escaped syntax and Markdown links', () => {
    const text = '`[[code]]`\n\n```md\n[[fenced]]\n```\n\n$[[math]]$ \\[[escaped]] [label](https://example.com/[[inside]]) [[real|Visible]]';
    assert.deepEqual(analyzeMarkdown(text).links.map(l => l.note), ['real']);
    assert.deepEqual(renderMarkdown(text).links.map(l => l.note), ['real']);
    assert.match(renderMarkdown(text).html, />Visible<\/a>/);
  });
  check('heading navigation uses current Markdown and excludes metadata and code', () => {
    const text = '---\ntitle: fake\n---\n# Real *Heading*\n\n```md\n# Hidden\n```\n\nNext heading\n------------';
    assert.deepEqual(scanWikiHeadings(text).map(h => h.text), ['Real Heading', 'Next heading']);
    assert.equal(findWikiHeadingLine(text, 'real-heading'), 4);
    assert.equal(findWikiHeadingLine(text, 'Next%20heading'), 10);
    assert.equal(findWikiHeadingLine(text, 'Hidden'), null);
  });
  check('completion offers notes and headings only in Markdown text', () => {
    assert.equal(wikiCompletionAt('[[Pro', 5).query, 'Pro');
    assert.equal(wikiCompletionAt('[[Project]]', 5).query, 'Pro');
    assert.equal(wikiCompletionAt('[[Note#Section]]', 10).query, 'Sec');
    assert.equal(wikiCompletionAt('[[Note#Sec', 10).kind, 'heading');
    for (const text of ['`[[Pro`', '$[[Pro$', '```md\n[[Pro\n```', '---\ntitle: [[Pro\n---']) {
      assert.equal(wikiCompletionAt(text, text.indexOf('Pro') + 3), null, text);
    }
    assert.equal(wikiCompletionAt('[[Note|ali', 10), null);
  });
  check('callout families have distinct monochrome symbols with safe unknown fallback', () => {
    const types = ['WARNING', 'TIP', 'DANGER', 'QUESTION', 'INFO'];
    assert.equal(new Set(types.map(calloutIcon)).size, 5);
    assert.deepEqual(types.map(calloutKind), ['warning', 'tip', 'danger', 'question', 'information']);
    assert.equal(calloutKind('CUSTOM'), 'information');
    assert.ok(types.every(t => calloutIcon(t).includes('stroke="currentColor"')));
  });
  check('nested thematic breaks never become frontmatter and unclosed YAML keeps body visible', () => {
    assert.equal(renderMarkdown('> [!note]\n> ---\n> hello\n> ---').frontmatter, null);
    const result = renderMarkdown('---\ntitle: unfinished\n\n# Visible\n\n[] task');
    assert.equal(result.frontmatter, null); assert.equal(result.tasks.length, 1); assert.match(result.html, /Visible/);
  });
  console.log(`Markdown features: ${passed} scenarios passed`);
} finally { await server.close(); }
