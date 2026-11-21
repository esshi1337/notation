import katex from 'katex';
import DOMPurify from 'dompurify';
import { defaultMathMode, mathEngineFor, typstMathProblem } from './math-syntax';
import type { MathEngine, MathMode } from './math-syntax';
import { cachedTypstMath, renderTypstMath, typstMathElement } from './typst-math';
import type { TypstMathResult } from './typst-math';

// The newest render of a target wins; a slow Typst compilation must not
// overwrite what a later render put there.
const tickets = new WeakMap<HTMLElement, number>();
let serial = 0;

function latexMarkup(content: string, display: boolean): string {
  const html = katex.renderToString(content, {
    displayMode: display, throwOnError: true, trust: false, strict: 'error',
    maxExpand: 200, maxSize: 20, output: 'htmlAndMathml',
  });
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    // Keep KaTeX's text-only TeX annotation for accessible math and exports.
    // annotation-xml remains disallowed.
    ADD_TAGS: ['semantics', 'annotation'], ADD_ATTR: ['encoding'],
  });
}
function showError(target: HTMLElement, message: string) {
  const alert = document.createElement('span');
  alert.className = 'math-error';
  alert.setAttribute('role', 'alert');
  const label = document.createElement('strong');
  label.textContent = 'Math error';
  const detail = document.createElement('span');
  detail.textContent = `: ${message}`;
  alert.append(label, detail);
  target.replaceChildren(alert);
}
function mark(target: HTMLElement, engine: MathEngine | 'error', note: string) {
  target.dataset.mathEngine = engine;
  target.removeAttribute('aria-busy');
  target.title = note;
}
function renderLatex(target: HTMLElement, content: string, display: boolean) {
  try { target.innerHTML = latexMarkup(content, display); mark(target, 'latex', 'LaTeX math (KaTeX)'); }
  catch (error) { showError(target, error instanceof Error ? error.message : String(error)); mark(target, 'error', 'LaTeX math (KaTeX)'); }
}
function applyTypst(target: HTMLElement, result: TypstMathResult, content: string, display: boolean, mode: MathMode) {
  if (result.ok) { target.replaceChildren(typstMathElement(result, display, content.trim())); mark(target, 'typst', 'Typst math'); return; }
  if (mode === 'auto') {
    // Typst is the default reading of an equation, not the only one: plain TeX
    // such as `mc^2` is not valid Typst but always was valid here.
    try {
      target.innerHTML = latexMarkup(content, display);
      mark(target, 'latex', 'LaTeX math (KaTeX fallback). As Typst: ' + result.error);
      return;
    } catch { /* Report the primary engine's error below. */ }
  }
  showError(target, 'Typst: ' + result.error);
  mark(target, 'error', 'Typst math');
}

/**
 * Render an equation into `target`. LaTeX and already compiled Typst are
 * inserted synchronously. A new Typst expression shows its source until the
 * worker answers; the returned promise settles when the target is final, and
 * `settled` is called only for that asynchronous completion.
 */
export function renderMathInto(target: HTMLElement, content: string, display: boolean, mode: MathMode = defaultMathMode(), settled?: () => void): Promise<void> {
  const ticket = ++serial;
  tickets.set(target, ticket);
  if (mathEngineFor(content, mode) === 'latex') { renderLatex(target, content, display); return Promise.resolve(); }
  const problem = typstMathProblem(content);
  const known: TypstMathResult | undefined = problem ? { ok: false, error: problem } : cachedTypstMath(content, display);
  if (known) { applyTypst(target, known, content, display, mode); return Promise.resolve(); }
  const pending = document.createElement('span');
  pending.className = 'math-pending';
  pending.textContent = content.trim();
  target.replaceChildren(pending);
  target.dataset.mathEngine = 'pending';
  target.setAttribute('aria-busy', 'true');
  return renderTypstMath(content, display).then((result) => {
    if (tickets.get(target) !== ticket) return;
    applyTypst(target, result, content, display, mode);
    settled?.();
  });
}
