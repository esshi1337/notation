// Detection, the Typst document template and both engines, without a browser:
// KaTeX runs as in the app, and the same pinned Typst WebAssembly compiler and
// renderer the worker loads compile every Typst corpus entry.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import katex from 'katex';
import { createTypstCompiler, createTypstRenderer } from '@myriaddreamin/typst.ts';
import { withAccessModel, withPackageRegistry } from '@myriaddreamin/typst.ts/options.init';
import { createServer } from 'vite';
import { INVALID, LATEX, TEX_FALLBACK, TYPST } from './math-corpus.mjs';

const server = await createServer({ configFile: false, cacheDir: 'node_modules/.vite/typst-math', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, logLevel: 'error' });
let syntax, preferences, sandbox;
try { syntax = await server.ssrLoadModule('/src/math-syntax.ts'); preferences = await server.ssrLoadModule('/src/preferences.ts'); sandbox = await server.ssrLoadModule('/src/typst-sandbox.ts'); } finally { await server.close(); }
const { noFiles, noPackages, refuseSourceEvaluation } = sandbox;
const { looksLikeLatex, mathEngineFor, readMathMode, documentMathMode, resolveMathMode, setDefaultMathMode, defaultMathMode, typstMathProblem, typstEquation, typstMathDocument, typstDiagnostic, TYPST_INK } = syntax;

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('✓ ' + name); }

// The app's exact KaTeX options (src/math.ts).
const latexRenders = (source, display) => { try { katex.renderToString(source, { displayMode: !!display, throwOnError: true, trust: false, strict: 'error', maxExpand: 200, maxSize: 20, output: 'htmlAndMathml' }); return true; } catch { return false; } };

const fontBytes = readFileSync(new URL('../src/assets/typst/NewCMMath-Book.otf', import.meta.url));
const wasm = (name) => readFileSync(new URL('../node_modules/@myriaddreamin/' + name, import.meta.url));
const requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { requests.push(String(args[0])); return realFetch(...args); };
// Run the compiler as the worker does (src/typst-worker.ts): the bundled font
// only, no files, no packages, and `new Function` refused as under the app's
// Content-Security-Policy.
const NativeFunction = globalThis.Function;
refuseSourceEvaluation(globalThis);
const evaluated = (() => { try { new Function('return 1'); return true; } catch (error) { return !(error instanceof EvalError); } })();
const bundledFont = Object.assign(async (_, { builder }) => { await builder.add_raw_font(new Uint8Array(fontBytes)); }, { _kind: 'fontLoader', _preloadRemoteFontOptions: { assets: false } });
const compiler = createTypstCompiler();
await compiler.init({ getModule: () => wasm('typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm'), beforeBuild: [bundledFont, withAccessModel(noFiles), withPackageRegistry(noPackages)] });
const renderer = createTypstRenderer();
await renderer.init({ getModule: () => wasm('typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm'), beforeBuild: [] });
/** Compile exactly as src/typst-worker.ts does. */
async function typst(source, display) {
  compiler.addSource('/main.typ', typstMathDocument(source, !!display));
  return compiler.runWithWorld({ mainFilePath: '/main.typ' }, async (world) => {
    const artifact = await world.vector({ diagnostics: 'full' });
    if (!artifact.result) return { error: typstDiagnostic(artifact.diagnostics) };
    const [metrics] = await world.query({ selector: '<notation-math>', field: 'value' });
    const svg = await renderer.renderSvg({ format: 'vector', artifactContent: artifact.result, data_selection: { body: true, defs: true, css: false, js: false } });
    return { svg, width: metrics[0], height: metrics[1], descent: metrics[2] };
  });
}

await test('the bundled math font is the pinned typst-assets v0.15.1 file', () => {
  assert.equal(createHash('sha256').update(fontBytes).digest('hex'), '2ea09ebc9167b1e1a66f31390dc917f2d4004ecfca72d51b28010e4ad6becd95');
});
await test('every real-world LaTeX snippet is detected and still renders with KaTeX in auto mode', () => {
  for (const { s, d } of LATEX) {
    assert.equal(looksLikeLatex(s), true, 'not detected as LaTeX: ' + s);
    assert.equal(mathEngineFor(s, 'auto'), 'latex', s);
    assert.equal(latexRenders(s, d), true, 'KaTeX rejected: ' + s);
  }
  assert.ok(LATEX.length >= 50);
});
await test('every Typst snippet is read as Typst and compiles with the bundled engine', async () => {
  for (const { s, d } of TYPST) {
    assert.equal(looksLikeLatex(s), false, 'misread as LaTeX: ' + s);
    assert.equal(mathEngineFor(s, 'auto'), 'typst', s);
    const result = await typst(s, d);
    assert.equal(result.error, undefined, s + ' → ' + result.error);
    assert.ok(result.width > 0 && result.height > 0 && result.descent >= 0, s + ' has no size');
    assert.ok(result.svg.includes('<path'), s + ' has no glyph outlines');
  }
  assert.ok(TYPST.length >= 45);
});
await test('plain TeX without markers fails in Typst and renders with KaTeX, so auto mode falls back', async () => {
  for (const { s, d } of TEX_FALLBACK) {
    assert.equal(mathEngineFor(s, 'auto'), 'typst', s);
    const result = await typst(s, d);
    assert.ok(result.error, 'Typst unexpectedly accepted: ' + s);
    assert.equal(latexRenders(s, d), true, 'KaTeX rejected: ' + s);
  }
});
await test('invalid math fails in the engine that owns it', async () => {
  for (const { s, engine } of INVALID) {
    assert.equal(mathEngineFor(s, 'auto'), engine, s);
    assert.equal(latexRenders(s, false), false, s);
    if (engine === 'typst') assert.ok((await typst(s, false)).error, s);
  }
});
await test('explicit modes never consult the detector', () => {
  for (const source of ['\\frac{a}{b}', 'a/b', 'x^{2}']) {
    assert.equal(mathEngineFor(source, 'typst'), 'typst');
    assert.equal(mathEngineFor(source, 'latex'), 'latex');
  }
});
await test('Typst escapes and line breaks are not mistaken for LaTeX', () => {
  for (const source of ['a \\ b', 'x \\\n y', 'a &= b \\ c &= d', '\\u{221E}', '\\$ 5', '\\# 1', '{1, 2, 3}', 'x^(2)', 'a_(i j)']) assert.equal(looksLikeLatex(source), false, source);
  for (const source of ['a \\\\ b', 'x^{2}', 'x_ {i}', '\\{a\\}', 'a\\,b', 'a\\ b', '\\ell']) assert.equal(looksLikeLatex(source), true, source);
});
await test('the math property accepts typst, latex and auto, quoted or commented, and ignores anything else', () => {
  const doc = (value) => '---\ntitle: T\n' + value + '\n---\n$x$';
  assert.equal(documentMathMode(doc('math: latex')), 'latex');
  assert.equal(documentMathMode(doc('math: "typst"')), 'typst');
  assert.equal(documentMathMode(doc("math: 'auto'  # default")), 'auto');
  assert.equal(documentMathMode(doc('math: LaTeX')), 'latex');
  assert.equal(documentMathMode(doc('math: katex')), 'latex');
  assert.equal(documentMathMode(doc('math: mathjax')), null);
  assert.equal(documentMathMode(doc('nested:\n  math: latex')), null);
  assert.equal(documentMathMode('math: latex\n\n$x$'), null);
  assert.equal(documentMathMode('---\nmath: latex\n'), null, 'unclosed frontmatter is not a property block');
  assert.equal(documentMathMode('﻿---\r\nmath: latex\r\n---\r\n'), 'latex');
  assert.equal(documentMathMode(undefined), null);
});
await test('a note property overrides the view default, which overrides the Settings default', () => {
  assert.equal(defaultMathMode(), 'auto');
  assert.equal(resolveMathMode('$x$'), 'auto');
  assert.equal(resolveMathMode('$x$', 'latex'), 'latex');
  assert.equal(resolveMathMode('---\nmath: typst\n---\n', 'latex'), 'typst');
  setDefaultMathMode('latex');
  assert.equal(resolveMathMode('$x$'), 'latex');
  assert.equal(resolveMathMode('---\nmath: auto\n---\n'), 'auto');
  setDefaultMathMode('nonsense'); assert.equal(defaultMathMode(), 'auto');
});
await test('the Settings preference defaults to Typst with LaTeX fallback and rejects unknown values', () => {
  assert.equal(preferences.DEFAULT_UI_PREFERENCES.mathSyntax, 'auto');
  for (const value of [undefined, null, 1, 'mathjax', {}]) assert.equal(preferences.readUIPreferences({ mathSyntax: value }).mathSyntax, 'auto');
  for (const value of ['auto', 'typst', 'latex']) assert.equal(preferences.readUIPreferences({ mathSyntax: value }).mathSyntax, value);
  assert.equal(readMathMode(' Typst '), 'typst');
});
await test('equations that cannot be one Typst equation are rejected before compiling', () => {
  assert.match(typstMathProblem('a $ b'), /unescaped \$/u);
  assert.equal(typstMathProblem('a \\$ b'), null);
  assert.match(typstMathProblem('  '), /empty/u);
  assert.match(typstMathProblem('x'.repeat(17000)), /16 KiB/u);
  assert.equal(typstEquation(' x ', false), '$x$');
  assert.equal(typstEquation('x', true), '$ x $');
  assert.equal(typstEquation('x \\', false), '$x \\ $', 'a trailing line break must not escape the closing delimiter');
});
await test('inline metrics report the true descent, and the equation is drawn in the sentinel ink', async () => {
  const flat = await typst('x', false), deep = await typst('y_j + q', false), tall = await typst('sum_(i=1)^n x_i', false);
  assert.ok(flat.descent < 0.5, 'x sits on the baseline: ' + flat.descent);
  assert.ok(deep.descent > 2 && deep.descent < 6, 'descenders extend below it: ' + deep.descent);
  assert.ok(tall.height > flat.height && tall.descent > flat.descent);
  assert.ok(flat.svg.toLowerCase().includes(TYPST_INK));
  const display = await typst('sum_(i=1)^n x_i', true);
  assert.ok(display.height > tall.height, 'display style is larger than inline style');
  assert.equal(display.descent, 0);
});
await test('the engine starts and compiles with JavaScript source evaluation refused (the app CSP)', () => {
  assert.equal(evaluated, false, 'new Function must be refused while the compiler runs');
  assert.throws(() => new Function('return globalThis'), EvalError);
  assert.throws(() => Function('m', 'return import(m)'), EvalError);
});
await test('Typst code inside an equation cannot read files, import packages or use the network', async () => {
  assert.match((await typst('#read("/etc/passwd")', false)).error, /failed to load file|file not found/u);
  assert.match((await typst('#image("secret.png")', false)).error, /failed to load file|file not found/u);
  assert.match((await typst('#{ include "other.typ" }', false)).error, /failed to load file|file not found/u);
  assert.match((await typst('#{ import "@preview/cetz:0.3.4": canvas }', false)).error, /package not found/u);
  assert.deepEqual(requests.filter((url) => /^https?:/u.test(url)), [], 'no HTTP request was made while compiling');
});
await test('diagnostics become one bounded sentence', () => {
  assert.equal(typstDiagnostic([{ severity: 'error', message: 'unknown variable: mc, hints: try `m c`' }]), 'unknown variable: mc. Hint: try `m c`');
  assert.equal(typstDiagnostic([]), 'the equation did not compile');
  assert.ok(typstDiagnostic([{ severity: 'error', message: 'x'.repeat(1000) }]).length <= 320);
});
globalThis.fetch = realFetch;
globalThis.Function = NativeFunction;
console.log(`\n${passed} Typst math checks passed.`);
process.exit(0);
