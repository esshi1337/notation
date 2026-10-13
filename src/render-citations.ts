import DOMPurify from 'dompurify';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { citationAt, orderedCitationGroups } from './citations';
import './citations.css';
export type CitationResult = { citations: { raw: string; html: string }[]; bibliographyHtml: string; error?: string };
export type CitationBinding = { element: HTMLElement; raw: string; id?: string };
type LinkHandler = (id: string) => void;
const cache = new Map<string,{time:number;pending:boolean;consumers:Set<() => boolean>;promise:Promise<CitationResult>}>();
let formattingQueue: Promise<unknown> = Promise.resolve();
let serial = 0;
export function citationScope() { return 'notation-citation-' + (++serial) + '-'; }
export function formatCitations(source: string, sourcePath: string | undefined, groups: string[], current: () => boolean = () => true): Promise<CitationResult> {
  if (!isTauri()) return Promise.reject(new Error('Citation formatting requires the desktop app with bundled Pandoc. Citation source is unchanged.'));
  const ordered = orderedCitationGroups(source, groups);
  if (ordered.length > 100) return Promise.reject(new Error('Citation formatting supports up to 100 distinct groups per note. Edit the source to reduce them.'));
  const key = JSON.stringify([sourcePath, source, ordered]), previous = cache.get(key);
  if (previous && (previous.pending || Date.now() - previous.time < 5000)) { previous.consumers.add(current); return previous.promise; }
  const consumers = new Set([current]);
  const entry = { time: Date.now(), pending: true, consumers, promise: Promise.resolve(null as unknown as CitationResult) };
  const promise = new Promise<void>(resolve => setTimeout(resolve, 250)).then(() => {
    const work = formattingQueue.catch(() => {}).then(async () => {
      if (![...consumers].some(consumer => consumer())) throw new Error('Citation source changed before formatting.');
      const result = await invoke<CitationResult>('render_citations', { content: source, sourcePath: sourcePath && (/^\//u.test(sourcePath) || /^[A-Za-z]:[\\/]/u.test(sourcePath)) ? sourcePath : undefined, citations: ordered });
      if (result.error) throw new Error(result.error); return result;
    });
    formattingQueue = work; return work;
  }).then(result => { entry.pending = false; entry.time = Date.now(); entry.consumers.clear(); return result; }).catch(cause => { cache.delete(key); entry.consumers.clear(); throw cause; });
  entry.promise = promise;
  cache.set(key, entry); while (cache.size > 4) cache.delete(cache.keys().next().value!); return promise;
}
export function sanitizeCitationHTML(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ['span','div','p','section','a','i','em','b','strong','sup','sub','small','ol','ul','li','h2','h3','br'], ALLOWED_ATTR: ['href','id','class','title','aria-label'], ALLOW_DATA_ATTR: false });
}
export function inlineCitationHTML(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = sanitizeCitationHTML(html);
  // Pandoc returns paragraph wrappers even for a single citation. Keep the
  // label phrasing-only so injecting it into a Markdown paragraph cannot
  // split the surrounding sentence or turn its link into a full-width block.
  for (const block of [...template.content.querySelectorAll('p,div,section,ol,ul,li,h2,h3')].reverse()) {
    block.replaceWith(document.createTextNode(' '), ...block.childNodes, document.createTextNode(' '));
  }
  for (const lineBreak of template.content.querySelectorAll('br')) lineBreak.replaceWith(document.createTextNode(' '));
  return template.innerHTML.trim();
}
export function connectCitationLinks(container: HTMLElement, scope: string, current: () => boolean, navigate?: LinkHandler) {
  for (const link of container.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = link.getAttribute('href')!;
    if (href.startsWith('#')) {
      let fragment = href.slice(1); try { fragment = decodeURIComponent(fragment); } catch { /* Keep malformed fragment text. */ } const id = fragment.startsWith(scope) ? fragment : scope + fragment; link.href = '#' + id;
      link.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); if (!current()) return; if (navigate) navigate(id); else { const target = document.getElementById(id); if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); } } });
    } else {
      try { if (!['http:','https:','mailto:'].includes(new URL(href, document.baseURI).protocol)) { link.removeAttribute('href'); continue; } } catch { link.removeAttribute('href'); continue; }
      link.target = '_blank'; link.rel = 'noopener noreferrer';
    }
  }
}
export async function hydrateCitations(bindings: CitationBinding[], bibliography: HTMLElement | null, source: string, sourcePath: string | undefined, current: () => boolean, options: { scope?: string; groups?: string[]; navigate?: LinkHandler; measure?: () => void } = {}) {
  const scope = options.scope ?? citationScope(), groups = options.groups ?? bindings.map((binding) => binding.raw);
  bindings.forEach((binding, index) => { binding.element.id = binding.id ?? scope + 'cite-' + index; binding.element.classList.add('citation-reference'); });
  if (bibliography) { bibliography.setAttribute('role', 'region'); bibliography.setAttribute('aria-label', 'Bibliography'); bibliography.setAttribute('aria-busy', 'true'); }
  try {
    const result = await formatCitations(source, sourcePath, groups, current); if (!current()) return;
    for (const binding of bindings) { const citation = result.citations.find((entry) => entry.raw === binding.raw); binding.element.innerHTML = citation ? inlineCitationHTML(citation.html) : ''; if (!citation) binding.element.textContent = binding.raw; else if (!binding.element.querySelector('a[href^="#"]')) { const key = citationAt(binding.raw)?.keys[0]; if (key) { const link = document.createElement('a'); link.href = '#ref-' + key; link.title = 'Go to bibliography: ' + key; link.append(...binding.element.childNodes); binding.element.append(link); } } connectCitationLinks(binding.element, scope, current, options.navigate); }
    if (bibliography) {
      const heading = document.createElement('h2'); heading.textContent = 'Bibliography';
      const body = document.createElement('div'); body.innerHTML = sanitizeCitationHTML(result.bibliographyHtml);
      for (const entry of body.querySelectorAll<HTMLElement>('[id]')) {
        const original = entry.id; entry.id = scope + original;
        if (original.startsWith('ref-')) {
          const binding = bindings.find((binding) => citationAt(binding.raw)?.keys.includes(original.slice(4)));
          if (binding) { const back = document.createElement('a'); back.className = 'citation-back'; back.href = '#' + binding.element.id; back.textContent = '↩'; back.setAttribute('aria-label', 'Back to citation ' + original.slice(4)); entry.append(document.createTextNode(' '), back); }
        }
      }
      bibliography.replaceChildren(heading, body); connectCitationLinks(bibliography, scope, current, options.navigate);
    }
  } catch (cause) {
    if (!current()) return;
    for (const binding of bindings) { binding.element.textContent = binding.raw; binding.element.classList.add('citation-unresolved'); binding.element.title = String(cause instanceof Error ? cause.message : cause); }
    if (bibliography) { const alert = document.createElement('div'); alert.className = 'citation-error'; alert.setAttribute('role', 'alert'); alert.textContent = cause instanceof Error ? cause.message : String(cause); bibliography.replaceChildren(alert); }
  } finally { if (current()) { bibliography?.setAttribute('aria-busy', 'false'); options.measure?.(); } }
}
