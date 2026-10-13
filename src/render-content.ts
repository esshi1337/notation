import { citationScope, hydrateCitations } from './render-citations';
import { orderedCitationGroups } from './citations';
import { parseFrontmatter } from './frontmatter';
import DOMPurify from 'dompurify';
import { renderMathInto } from './math';
import { renderMermaidInto } from './mermaid';
import type { DiagramTheme } from './mermaid';
import { taskName } from './markdown-features';
import type { TaskSpan } from './markdown-features';
import type { renderMarkdown } from './render-markdown';
import { calloutIcon } from './render-markdown';
import { renderMarkdown as renderEmbeddedMarkdown } from './render-markdown';
import { renderQuery } from './render-query';
import { renderCell } from './render-cell';
import type { CellSession } from './cells';
import { renderAdvancedInto } from './advanced-diagrams';
import { prepareMedia, renderMedia } from './media';

export type EmbedDocument = { path: string; content: string; label: string; key: string; variables?:Record<string,unknown>; fullContent?:string };
let footnoteSerial=0;
const cleanups=new WeakMap<HTMLElement,()=>void>();
export function clearRenderedContent(target:HTMLElement){cleanups.get(target)?.();cleanups.delete(target);for(const child of target.querySelectorAll<HTMLElement>('*')){cleanups.get(child)?.();cleanups.delete(child);}}

export async function renderContent(target: HTMLElement, result: ReturnType<typeof renderMarkdown>, context: {
  theme: DiagramTheme; folds: Map<string, boolean>; current: () => boolean;
  toggle: (task: TaskSpan) => boolean; edit: (from: number) => void; measure?: () => void;
  openWiki?: (target: string, sourcePath?: string) => void; editProperties?: () => void;
  sourcePath?: string; loadEmbed?: (target: string, sourcePath?: string) => Promise<EmbedDocument>;
  openPath?: (path: string) => void; embedTrail?: string[];
  prepareHtml?: (html: string, sourcePath?: string) => string;
  cells?: CellSession;
  documentSource?: string; citationScope?: string; citationGroups?: string[]; includeBibliography?: boolean;
}) {
  const focusedTask = target.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.taskFrom : undefined;
  clearRenderedContent(target);
  target.innerHTML = DOMPurify.sanitize(context.prepareHtml ? context.prepareHtml(result.html,context.sourcePath) : prepareMedia(result.html), { USE_PROFILES: { html: true } });
  // Capture this document's placeholders before recursive embeds introduce
  // their own local indexes into the DOM.
  const embedElements = [...target.querySelectorAll<HTMLElement>('[data-embed-index]')];
  const diagramElements = [...target.querySelectorAll<HTMLElement>('[data-diagram]')];
  const advancedElements=[...target.querySelectorAll<HTMLElement>('[data-advanced-index]')];
  const mediaElements=[...target.querySelectorAll<HTMLElement>('[data-media-source]')];
  const source = context.documentSource ?? result.documentSource ?? '';
  const citationBindings = [...target.querySelectorAll<HTMLElement>('[data-citation-index]')].map(element => { const span = result.citations?.[Number(element.dataset.citationIndex)]; return span ? { element, raw: span.raw, id: context.citationScope ? context.citationScope + 'cite-' + span.from : undefined } : null; }).filter((binding): binding is NonNullable<typeof binding> => !!binding);
  let bibliography: HTMLElement | null = null;
  if (context.includeBibliography !== false && (citationBindings.length || parseFrontmatter(source)?.values.nocite)) { bibliography = document.createElement('section'); bibliography.className = 'bibliography'; target.append(bibliography); }
  const citationWork = citationBindings.length || bibliography ? hydrateCitations(citationBindings, bibliography, source, context.sourcePath, context.current, { scope: context.citationScope ?? citationScope(), groups: context.citationGroups ?? orderedCitationGroups(source, result.citations?.map(span => span.raw)), measure: context.measure }) : Promise.resolve();
  const footnotePrefix='notation-footnote-'+(++footnoteSerial)+'-';
  const definitions=[...target.querySelectorAll<HTMLElement>('[data-footnote-id]')];
  const references=[...target.querySelectorAll<HTMLAnchorElement>('[data-footnote-ref]')];
  const internalLink=(link:HTMLAnchorElement,to:HTMLElement)=>{link.href='#'+to.id;link.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(context.current()){to.tabIndex=-1;to.focus({preventScroll:true});to.scrollIntoView({block:'nearest'});}});};
  definitions.forEach((note,index)=>note.id=footnotePrefix+'d'+index);
  references.forEach((reference,index)=>{reference.id=footnotePrefix+'r'+index;const note=definitions.find(item=>item.dataset.footnoteId===reference.dataset.footnoteRef);if(note)internalLink(reference,note);});
  for(const back of target.querySelectorAll<HTMLAnchorElement>('[data-footnote-back]')){const reference=references.find(item=>item.dataset.footnoteRef===back.dataset.footnoteBack);if(reference)internalLink(back,reference);}
  for (const input of target.querySelectorAll<HTMLInputElement>('input.task-checkbox')) {
    const task = result.tasks[Number(input.dataset.taskIndex)];
    if (!task) { input.remove(); continue; }
    input.setAttribute('aria-label', taskName(task)); input.dataset.taskFrom = String(task.from);
    input.addEventListener('mousedown', (event) => event.stopPropagation());
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('change', () => { if (!context.current() || !context.toggle(task)) input.checked = task.checked; });
    if (input.dataset.taskFrom === focusedTask) input.focus({ preventScroll: true });
  }
  for (const region of target.querySelectorAll<HTMLElement>('[data-callout-index]')) {
    const callout = result.callouts[Number(region.dataset.calloutIndex)];
    if (!callout) continue;
    const icon = region.querySelector<HTMLElement>('[data-callout-icon]');
    if (icon) icon.innerHTML = calloutIcon(callout.type);
    const toggle = region.querySelector<HTMLButtonElement>('[data-callout-toggle]')!;
    const body = region.querySelector<HTMLElement>('[data-callout-body]')!;
    const update = () => {
      const folded = context.folds.get(callout.key) ?? callout.folded;
      toggle.setAttribute('aria-label', `Toggle callout: ${callout.title}`);
      toggle.setAttribute('aria-expanded', String(!folded)); body.hidden = folded;
    };
    update();
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      context.folds.set(callout.key, toggle.getAttribute('aria-expanded') === 'true');
      update(); context.measure?.();
    });
    region.querySelector<HTMLButtonElement>('[data-callout-edit]')?.addEventListener('click', (event) => {
      event.stopPropagation(); if (context.current()) context.edit(callout.from);
    });
  }
  for (const button of target.querySelectorAll<HTMLButtonElement>('[data-edit-properties]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (context.current()) context.editProperties ? context.editProperties() : context.edit(0);
    });
  }
  for (const link of target.querySelectorAll<HTMLAnchorElement>('[data-wiki-index]')) {
    const span = result.links[Number(link.dataset.wikiIndex)];
    if (!span) continue;
    link.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      if (context.current()) context.openWiki?.(span.target, context.sourcePath);
    });
  }
  for (const element of target.querySelectorAll<HTMLElement>('[data-math-index]')) {
    const math = result.maths[Number(element.dataset.mathIndex)];
    if (math) renderMathInto(element, math.content, math.display);
  }
  for (const link of target.querySelectorAll<HTMLAnchorElement>('a:not([data-wiki-index]):not([data-footnote-ref]):not([data-footnote-back])')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  for(const [index,cell] of (result.cells??[]).entries()){const element=target.querySelector<HTMLElement>(`[data-cell-index="${index}"]`);if(element)cleanups.set(element,renderCell(element,cell.id,cell.runnable?context.cells:undefined,context.current));}
  for (const [index, source] of (result.queries ?? []).entries()) {
    const element = target.querySelector<HTMLElement>(`[data-query-index="${index}"]`);
    if (element) await renderQuery(element, source, context.current, context.openPath);
  }
  for (const [index, embed] of (result.embeds ?? []).entries()) {
    if (!context.current()) return;
    const element = embedElements.find(element => Number(element.dataset.embedIndex) === index);
    if (!element) continue;
    element.setAttribute('role','region'); element.setAttribute('aria-label','Embedded note: ' + embed.label);
    const actions = document.createElement('div'); actions.className = 'embed-actions';
    const header = document.createElement('button'); header.className = 'embed-heading'; header.textContent = embed.label;
    header.addEventListener('click', event => { event.stopPropagation(); if (context.current()) context.openWiki?.(embed.target, context.sourcePath); });
    const refresh = document.createElement('button'); refresh.textContent = 'Refresh'; refresh.setAttribute('aria-label','Refresh embed: ' + embed.label);
    const body = document.createElement('div'); body.className = 'embed-body'; actions.append(header,refresh); element.replaceChildren(actions,body);
    let serial = 0;
    const hydrate = async () => {
      const ticket = ++serial, current = () => context.current() && ticket === serial;
      refresh.disabled = true; body.removeAttribute('role'); body.textContent = 'Loading…';
      try {
        if (!context.loadEmbed) throw new Error('Open the target note to preview this embed.');
        const trail = context.embedTrail ?? [];
        if (trail.length >= 5) throw new Error('Embed depth limit reached (5).');
        const loaded = await context.loadEmbed(embed.target, context.sourcePath);
        if (!current()) return;
        if (trail.includes(loaded.key)) throw new Error('Circular embed: ' + embed.label);
        await renderContent(body, renderEmbeddedMarkdown(loaded.content,true,0,loaded.variables), {
          ...context, current, cells: undefined, sourcePath: loaded.path, embedTrail: [...trail,loaded.key],
          toggle: () => false, edit: () => context.openPath?.(loaded.path), editProperties: () => context.openPath?.(loaded.path),
        });
        for (const input of body.querySelectorAll<HTMLInputElement>('input.task-checkbox')) input.disabled = true;
      } catch (error) { if (current()) { body.textContent = error instanceof Error ? error.message : String(error); body.setAttribute('role','alert'); } }
      finally { if(current()) {refresh.disabled=false;context.measure?.();} }
    };
    refresh.addEventListener('click', event=>{event.stopPropagation();if(context.current())void hydrate();});
    await hydrate();
  }
  for (const [index, source] of result.diagrams.entries()) {
    if (!context.current()) return;
    const element = diagramElements.find(element => Number(element.dataset.diagram) === index);
    if (element) await renderMermaidInto(element, source, context.theme, context.current);
  }
  for(const [index,diagram] of (result.advanced??[]).entries()){
    if(!context.current())return;const element=advancedElements.find(item=>Number(item.dataset.advancedIndex)===index);
    if(element)await renderAdvancedInto(element,diagram.engine,diagram.source,context.theme==='dark',context.current);
  }
  if(!context.prepareHtml)for(const element of mediaElements){if(!context.current())return;cleanups.set(element,await renderMedia(element,context.sourcePath,context.current));}
  await citationWork;
  if (context.current()) context.measure?.();
}
