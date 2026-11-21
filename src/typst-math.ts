// Typst math in the webview. Expressions are compiled in a dedicated worker
// that is created the first time a note needs Typst (the WebAssembly compiler
// is large), and every result is cached, so re-rendering a preview or
// re-creating an editor widget is synchronous. The SVG the renderer returns is
// rebuilt from an allow-list before it reaches the document.
import { TYPST_INK, TYPST_TEXT_PT } from './math-syntax';
import type { TypstRequest, TypstResponse } from './typst-worker';

export type TypstMathResult = { ok: true; svg: SVGSVGElement } | { ok: false; error: string };

/** Font size of an equation relative to its surrounding text, as for KaTeX. */
export const TYPST_MATH_SCALE = 1.21;
const SVG = 'http://www.w3.org/2000/svg';
const CACHE_LIMIT = 1500;
const START_TIMEOUT = 45_000, COMPILE_TIMEOUT = 6_000;
// The loaded compiler holds a few hundred megabytes. Results stay cached, so
// an idle engine is released and started again for the next new equation.
const IDLE_TIMEOUT = 180_000;

const cache = new Map<string, TypstMathResult>();
const inflight = new Map<string, Promise<TypstMathResult>>();
type Job = { request: TypstRequest; resolve: (result: TypstMathResult) => void; key: string };
const jobs = new Map<number, Job>();
let worker: Worker | undefined, ready = false, watchdog: ReturnType<typeof setTimeout> | undefined;
let serial = 0, idPrefix = 0, answers = 0;
/** Counters for tests and measurements; not used for behaviour. */
export const typstMathStats = { workers: 0, compiled: 0, cacheHits: 0, startMs: 0, timeouts: 0, idleStops: 0 };

const key = (content: string, display: boolean) => (display ? 'D' : 'I') + content;

function remember(cacheKey: string, result: TypstMathResult) {
  cache.delete(cacheKey);
  cache.set(cacheKey, result);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

const SHAPES = new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'clipPath', 'linearGradient', 'radialGradient', 'stop']);
const ATTRIBUTES = new Set(['d', 'transform', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'points', 'clip-path', 'clip-rule', 'id', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'fx', 'fy']);
const number = (value: string | null) => { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; };

/**
 * Rebuild the renderer's SVG as plain shapes. Only geometry and paint survive:
 * scripts, styles, links, images, foreign HTML (the renderer's text-selection
 * layer) and every unknown attribute are dropped. Glyph `<use>` references
 * are replaced by their outlines, so equations share no ids with each other.
 */
export function cleanTypstSvg(raw: string, width: number, height: number, descent: number, label: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(raw, 'image/svg+xml');
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') throw new Error('the renderer returned invalid SVG');
  const prefix = 'tm' + (++idPrefix) + '-';
  const glyphs = new Map<string, Element>();
  for (const glyph of parsed.querySelectorAll('defs > path[id]')) glyphs.set(glyph.getAttribute('id')!, glyph);
  const paint = (value: string) => {
    if (value.toLowerCase() === TYPST_INK) return 'currentColor';
    const reference = /^url\(\s*["']?#([\w-]+)["']?\s*\)$/u.exec(value);
    if (reference) return 'url(#' + prefix + reference[1] + ')';
    return /url\(|[<>;{}@\\]|expression/iu.test(value) ? null : value;
  };
  const copy = (source: Element): Element | null => {
    if (source.localName === 'use') {
      const glyph = glyphs.get((source.getAttribute('href') ?? source.getAttribute('xlink:href') ?? '').slice(1));
      const data = glyph?.getAttribute('d');
      if (!data) return null;
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', data);
      const x = number(source.getAttribute('x')), y = number(source.getAttribute('y'));
      const transform = ((source.getAttribute('transform') ?? '') + (x || y ? ' translate(' + x + ',' + y + ')' : '')).trim();
      if (transform) path.setAttribute('transform', transform);
      return path;
    }
    if (!SHAPES.has(source.localName)) return null;
    // Glyph outlines are inlined where they are used.
    if (source.localName === 'defs' && source.classList.contains('glyph')) return null;
    const element = document.createElementNS(SVG, source.localName);
    for (const attribute of source.attributes) {
      if (!ATTRIBUTES.has(attribute.name)) continue;
      const value = attribute.name === 'id' ? prefix + attribute.value.replace(/[^\w-]/gu, '') : paint(attribute.value);
      if (value !== null) element.setAttribute(attribute.name, value);
    }
    for (const child of source.children) { const copied = copy(child); if (copied) element.append(copied); }
    return (source.localName === 'defs' || source.localName === 'g') && !element.childElementCount ? null : element;
  };
  const svg = document.createElementNS(SVG, 'svg');
  for (const child of parsed.documentElement.children) { const copied = copy(child); if (copied) svg.append(copied); }
  const em = (points: number) => +(points / TYPST_TEXT_PT * TYPST_MATH_SCALE).toFixed(4) + 'em';
  svg.setAttribute('viewBox', '0 0 ' + +width.toFixed(4) + ' ' + +height.toFixed(4));
  svg.setAttribute('class', 'typst-math-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'none');
  // Sizes are in em so the equation scales with its text; the offset puts the
  // Typst baseline on the text baseline. Ink may overhang the layout box.
  svg.setAttribute('style', 'width:' + em(width) + ';height:' + em(height) + ';vertical-align:' + em(-descent) + ';overflow:visible');
  return svg;
}

function fail(job: Job, error: string) { inflight.delete(job.key); job.resolve({ ok: false, error }); }
function failAll(error: string) { for (const [id, job] of [...jobs]) { jobs.delete(id); fail(job, error); } }

function stopWorker() {
  clearTimeout(watchdog);
  worker?.terminate();
  worker = undefined; ready = false;
}
/** Hand the jobs a stopped worker never answered to a fresh one. */
function resume() {
  const waiting = [...jobs.values()];
  if (!waiting.length) return;
  const next = startWorker();
  for (const job of waiting) next.postMessage(job.request);
  watch();
}
function watch() {
  clearTimeout(watchdog);
  if (!jobs.size) { if (worker && ready) watchdog = setTimeout(() => { typstMathStats.idleStops++; stopWorker(); }, IDLE_TIMEOUT); return; }
  const seen = answers;
  watchdog = setTimeout(() => {
    // A busy main thread can run this timer before an answer that is already
    // queued. Let queued messages in first, and act only if none arrived.
    watchdog = setTimeout(() => { if (answers === seen) expire(); }, 60);
  }, ready ? COMPILE_TIMEOUT : START_TIMEOUT);
}
function expire() {
  // The worker compiles in request order, so the oldest job is the stuck one.
  const [id, stuck] = jobs.entries().next().value!;
  jobs.delete(id);
  typstMathStats.timeouts++;
  const started = ready;
  stopWorker();
  if (!started) { failAll('the Typst engine did not start in time'); fail(stuck, 'the Typst engine did not start in time'); return; }
  // A runaway equation stays an error for this session.
  const message = 'the equation took too long to compile';
  remember(stuck.key, { ok: false, error: message });
  fail(stuck, message);
  resume();
}
function startWorker(): Worker {
  if (worker) return worker;
  typstMathStats.workers++;
  const created = worker = new Worker(new URL('./typst-worker.ts', import.meta.url), { type: 'module' });
  created.onmessage = (event: MessageEvent<TypstResponse>) => {
    if (created !== worker) return;
    const message = event.data;
    answers++;
    if ('ready' in message) { ready = true; typstMathStats.startMs = message.ms; watch(); return; }
    const job = jobs.get(message.id);
    if (!job) return;
    jobs.delete(message.id);
    if (!ready && 'error' in message) {
      // The engine itself failed to load. Nothing queued can succeed on this
      // worker; a later equation gets a fresh attempt.
      stopWorker();
      fail(job, 'the Typst engine could not start: ' + message.error);
      failAll('the Typst engine could not start: ' + message.error);
      return;
    }
    let result: TypstMathResult;
    if ('error' in message && message.crashed) {
      // The engine may be unusable after a trap (out of memory, stack
      // overflow). The equation that caused it stays an error.
      stopWorker();
      typstMathStats.timeouts++;
      result = { ok: false, error: 'the Typst engine stopped: ' + message.error };
      remember(job.key, result);
      inflight.delete(job.key);
      job.resolve(result);
      resume();
      return;
    }
    watch();
    if ('error' in message) result = { ok: false, error: message.error };
    else {
      try { result = { ok: true, svg: cleanTypstSvg(message.svg, message.width, message.height, message.descent, job.request.content.trim()) }; }
      catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    typstMathStats.compiled++;
    remember(job.key, result);
    inflight.delete(job.key);
    job.resolve(result);
  };
  created.onerror = (event) => {
    if (created !== worker) return;
    const message = 'the Typst engine could not start' + (event.message ? ': ' + event.message : '');
    stopWorker();
    failAll(message);
  };
  return created;
}

/** A finished result for this expression, without starting any work. */
export function cachedTypstMath(content: string, display: boolean): TypstMathResult | undefined {
  const cached = cache.get(key(content, display));
  if (cached) typstMathStats.cacheHits++;
  return cached;
}
/** Compile (or reuse) an expression. Never rejects. */
export function renderTypstMath(content: string, display: boolean): Promise<TypstMathResult> {
  const cacheKey = key(content, display);
  const cached = cache.get(cacheKey);
  if (cached) { typstMathStats.cacheHits++; return Promise.resolve(cached); }
  const running = inflight.get(cacheKey);
  if (running) return running;
  const promise = new Promise<TypstMathResult>((resolve) => {
    const request: TypstRequest = { id: ++serial, content, display };
    const job: Job = { request, resolve, key: cacheKey };
    try {
      const target = startWorker();
      jobs.set(request.id, job);
      target.postMessage(request);
      // Arms the compile watchdog (and cancels a pending idle stop).
      if (jobs.size === 1) watch();
    } catch (error) {
      jobs.delete(request.id);
      queueMicrotask(() => fail(job, 'the Typst engine is unavailable: ' + (error instanceof Error ? error.message : String(error))));
    }
  });
  inflight.set(cacheKey, promise);
  return promise;
}
/** A fresh copy of a cached equation for insertion into a document. */
export function typstMathElement(result: Extract<TypstMathResult, { ok: true }>, display: boolean, source: string): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = display ? 'typst-math typst-display' : 'typst-math';
  wrapper.dataset.typst = source;
  wrapper.append(result.svg.cloneNode(true));
  return wrapper;
}
