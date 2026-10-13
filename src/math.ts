import katex from 'katex';
import DOMPurify from 'dompurify';

export function renderMathInto(target: HTMLElement, content: string, display: boolean): void {
  try {
    const html = katex.renderToString(content, {
      displayMode: display, throwOnError: true, trust: false, strict: 'error',
      maxExpand: 200, maxSize: 20, output: 'htmlAndMathml',
    });
    target.innerHTML = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true, mathMl: true, svg: true },
      // Keep KaTeX's text-only TeX annotation for accessible math and exports.
      // annotation-xml remains disallowed.
      ADD_TAGS: ['semantics', 'annotation'], ADD_ATTR: ['encoding'],
    });
  } catch (error) {
    const alert = document.createElement('span');
    alert.className = 'math-error';
    alert.setAttribute('role', 'alert');
    const label = document.createElement('strong');
    label.textContent = 'Math error';
    const detail = document.createElement('span');
    detail.textContent = `: ${error instanceof Error ? error.message : String(error)}`;
    alert.append(label, detail);
    target.replaceChildren(alert);
  }
}
