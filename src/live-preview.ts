import { Prec, StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree, foldedRanges } from '@codemirror/language';
import { renderMermaidInto } from './mermaid';
import type { DiagramTheme } from './mermaid';
import { analyzeCallouts, analyzeMarkdown, analyzeQuotes, containsCallout, featureParser, markdownSource, taskName } from './markdown-features';
import type { CalloutSpan, MathSpan, QuoteSpan, TaskSpan } from './markdown-features';
import { renderMathInto } from './math';
import { toggleTask } from './tasks';
import { frontmatterMarkup, renderCallout, renderMarkdown } from './render-markdown';
import { renderContent, clearRenderedContent } from './render-content';
import { parseFrontmatter } from './frontmatter';
import type { Frontmatter } from './frontmatter';
import type { WikiLinkSpan } from './wiki-syntax';
import type { EmbedDocument } from './render-content';
import { scanBlockReferences } from './block-references';
import type { CellSession } from './cells';
import { extractFootnotes } from './footnotes';
import { markdownTables } from './tables';
import { scanCitations, orderedCitationGroups } from './citations';
import type { CitationSpan } from './citations';
import { citationScope, hydrateCitations } from './render-citations';
import { inlineVariables } from './variables';
import type { VariableSpan } from './variables';

export type LiveNavigation = { openWiki?: (target: string, sourcePath?: string) => void; editProperties?: () => void; sourcePath?: string; loadEmbed?: (target: string, sourcePath?: string) => Promise<EmbedDocument>; openPath?: (path: string) => void; cells?: CellSession; variables?:Record<string,unknown>; citationScope?:string; citationGroups?:string[]; documentSource?:string; includeBibliography?:boolean; variableSource?:string };

let citationText: string | undefined, citationSpans: CitationSpan[] = [];
function liveCitations(text: string) { if (citationText !== text) { citationText = text; citationSpans = (renderMarkdown(text).citations ?? []).sort((a,b) => a.from - b.from); } return citationSpans; }
function citationNavigate(view: EditorView, id: string, scope: string) {
  const from = id.startsWith(scope + 'cite-') ? Number(id.slice((scope + 'cite-').length)) : view.state.doc.length;
  view.dispatch({ effects: EditorView.scrollIntoView(Number.isFinite(from) ? Math.min(view.state.doc.length, from) : view.state.doc.length, { y: 'center' }) });
  requestAnimationFrame(() => { const element = document.getElementById(id); if (element) { element.tabIndex = -1; element.focus({ preventScroll: true }); element.scrollIntoView({ block: 'nearest' }); } else if (Number.isFinite(from) && from !== view.state.doc.length) revealDocumentSource(view, from); });
}
class CitationWidget extends WidgetType {
  constructor(readonly citation: CitationSpan, readonly source: string, readonly navigation: LiveNavigation) { super(); }
  eq(other: CitationWidget) { return this.citation.raw === other.citation.raw && this.citation.from === other.citation.from && this.source === other.source && this.navigation.sourcePath === other.navigation.sourcePath && this.navigation.citationScope === other.navigation.citationScope; }
  toDOM(view: EditorView) {
    const span = document.createElement('span'); span.className = 'cm-live-citation citation-reference'; span.textContent = this.citation.raw;
    const scope = this.navigation.citationScope!; span.id = scope + 'cite-' + this.citation.from;
    const token = { alive: true }; lifecycle.set(span, token);
    span.addEventListener('dblclick', event => revealSource(view, this.citation.from, event));
    void hydrateCitations([{ element: span, raw: this.citation.raw, id: span.id }], null, this.source, this.navigation.sourcePath, () => token.alive && span.isConnected, { scope, groups: this.navigation.citationGroups, navigate: id => citationNavigate(view, id, scope), measure: () => view.requestMeasure() });
    return span;
  }
  destroy(dom: HTMLElement) { const token = lifecycle.get(dom); if (token) token.alive = false; }
  ignoreEvent() { return true; }
}
class BibliographyWidget extends WidgetType {
  constructor(readonly source: string, readonly spans: CitationSpan[], readonly navigation: LiveNavigation) { super(); }
  eq(other: BibliographyWidget) { return this.source === other.source && this.navigation.sourcePath === other.navigation.sourcePath && this.navigation.citationScope === other.navigation.citationScope; }
  toDOM(view: EditorView) {
    const dom = document.createElement('section'); dom.className = 'bibliography cm-live-bibliography'; dom.textContent = 'Formatting citations…';
    const token = { alive: true }; lifecycle.set(dom, token); const scope = this.navigation.citationScope!;
    const bindings = this.spans.map(span => ({ element: document.createElement('span'), raw: span.raw, id: scope + 'cite-' + span.from }));
    void hydrateCitations(bindings, dom, this.source, this.navigation.sourcePath, () => token.alive && dom.isConnected, { scope, groups: this.navigation.citationGroups, navigate: id => citationNavigate(view, id, scope), measure: () => view.requestMeasure() });
    return dom;
  }
  destroy(dom: HTMLElement) { const token = lifecycle.get(dom); if (token) token.alive = false; }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 150; }
}

class VariableWidget extends WidgetType {
  constructor(readonly variable:VariableSpan){super();}
  eq(other:VariableWidget){return this.variable.raw===other.variable.raw&&this.variable.value===other.variable.value;}
  toDOM(){const span=document.createElement('span');span.className='document-variable'+(this.variable.value===null?' unresolved-variable':'');span.textContent=this.variable.value??this.variable.raw;span.title='Variable: '+this.variable.name;return span;}
  ignoreEvent(){return false;}
}
class FootnoteWidget extends WidgetType {
  constructor(readonly id:string,readonly number:number,readonly from:number){super();}
  eq(other:FootnoteWidget){return this.id===other.id&&this.number===other.number&&this.from===other.from;}
  toDOM(view:EditorView){const sup=document.createElement('sup'),link=document.createElement('a');link.href='#';link.className='footnote-reference';link.textContent=String(this.number);link.setAttribute('aria-label','Footnote '+this.id);link.onclick=event=>revealSource(view,this.from,event);sup.append(link);return sup;}
  ignoreEvent(){return true;}
}

class DocumentWidget extends WidgetType {
  constructor(readonly raw: string, readonly from: number, readonly theme: DiagramTheme, readonly navigation: LiveNavigation, readonly kind: string) { super(); }
  eq(other: DocumentWidget) { return this.raw === other.raw && this.from === other.from && this.theme === other.theme && this.navigation.sourcePath === other.navigation.sourcePath && (!(this.kind === 'footnote' || /\[[^\]\r\n]*@/u.test(this.raw)) || this.navigation.documentSource === other.navigation.documentSource) && this.navigation.variableSource === other.navigation.variableSource; }
  toDOM(view: EditorView) {
    const dom = document.createElement('div'); dom.className = 'markdown-body cm-live-document cm-live-' + this.kind;
    const token = { alive: true }; lifecycle.set(dom,token);
    const offset = this.kind === 'footnote' ? this.from - (this.raw.indexOf('\n\n') + 2) : this.kind === 'table' ? this.from : 0;
    queueMicrotask(() => { if (dom.isConnected) void renderContent(dom, renderMarkdown(this.raw,true,offset,this.navigation.variables), {
      theme: this.theme, folds: new Map(), current: () => token.alive && dom.isConnected,
      toggle: task => this.kind === 'footnote' ? toggleTask(view,{task}) : false, edit: () => revealDocumentSource(view,this.from), ...this.navigation,
      measure: () => view.requestMeasure(),
    }).then(() => { if (token.alive && dom.isConnected) view.requestMeasure(); }); });
    dom.addEventListener('dblclick', event => { if (!(event.target as HTMLElement).closest('button,a,input')) revealSource(view,this.from,event); });
    return dom;
  }
  destroy(dom: HTMLElement) { const token = lifecycle.get(dom); if (token) token.alive = false; clearRenderedContent(dom); }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 150; }
}

export function wikiNavigation(navigation: LiveNavigation): Extension {
  const open = (view: EditorView, at: number) => {
    const link = analyzeMarkdown(view.state.doc.toString()).links.find((item) => at >= item.from && at <= item.to);
    if (!link || !navigation.openWiki) return false;
    navigation.openWiki(link.target); return true;
  };
  return [EditorView.domEventHandlers({ click(event, view) {
    if (!(event.ctrlKey || event.metaKey)) return false;
    const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (at === null || !open(view, at)) return false;
    event.preventDefault(); return true;
  } }), Prec.highest(keymap.of([{ key: 'Mod-Enter', run: (view) => open(view, view.state.selection.main.head) }]))];
}

const setEditorFocus = StateEffect.define<boolean>();
const editorFocused = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setEditorFocus)) value = effect.value;
    return value;
  },
});

// Kept outside the mode compartment so reconfiguring layout/theme preserves
// actual focus along with the editor's document, selection, and undo history.
export const livePreviewFocus: Extension = [
  editorFocused,
  // Use CodeMirror's focus lifecycle: it reconciles focus after view updates
  // and accounts for WebKit's selection/focus behavior while replacing DOM.
  EditorView.focusChangeEffect.of((state, focusing) =>
    state.field(editorFocused) === focusing ? null : setEditorFocus.of(focusing)),
];

const lifecycle = new WeakMap<HTMLElement, { alive: boolean }>();

export function revealDocumentSource(view: EditorView, at: number) {
  view.dispatch({ selection: { anchor: Math.min(at, view.state.doc.length) }, effects: setEditorFocus.of(true), scrollIntoView: true });
  view.focus();
  view.dispatch({});
}

function revealSource(view: EditorView, at: number, event: Event) {
  event.preventDefault(); event.stopPropagation(); revealDocumentSource(view, at);
}

class CalloutWidget extends WidgetType {
  constructor(readonly callout: CalloutSpan, readonly theme: DiagramTheme, readonly folds: Map<string, boolean>, readonly navigation: LiveNavigation) { super(); }
  eq(other: CalloutWidget) { return JSON.stringify(this.callout) === JSON.stringify(other.callout) && this.theme === other.theme && this.navigation.sourcePath === other.navigation.sourcePath && (!/\[[^\]\r\n]*@/u.test(this.callout.body) || this.navigation.documentSource === other.navigation.documentSource) && this.navigation.variableSource === other.navigation.variableSource; }
  updateDOM(dom: HTMLElement, view: EditorView) {
    const previous = lifecycle.get(dom); if (previous) previous.alive = false;
    const token = { alive: true }; lifecycle.set(dom, token);
    const result = renderCallout(this.callout,this.navigation.variables);
    void renderContent(dom, result, {
      theme: this.theme, folds: this.folds, current: () => token.alive && dom.isConnected,
      toggle: (task) => toggleTask(view, { task }), edit: (from) => revealDocumentSource(view, from),
      ...this.navigation,
      measure: () => { if (token.alive && dom.isConnected) view.requestMeasure(); },
    });
    return true;
  }
  toDOM(view: EditorView) {
    const dom = document.createElement('div'); dom.className = 'cm-live-callout markdown-body';
    // Mermaid needs a connected host; defer hydration until insertion.
    queueMicrotask(() => { if (dom.isConnected) this.updateDOM(dom, view); });
    return dom;
  }
  destroy(dom: HTMLElement) { const token = lifecycle.get(dom); if (token) token.alive = false; clearRenderedContent(dom); }
  ignoreEvent() { return true; }
  get estimatedHeight() { return this.callout.folded ? 45 : 140; }
}

class RichQuoteWidget extends WidgetType {
  constructor(readonly quote: QuoteSpan, readonly theme: DiagramTheme, readonly folds: Map<string, boolean>, readonly navigation: LiveNavigation) { super(); }
  eq(other: RichQuoteWidget) { return this.quote.raw === other.quote.raw && this.quote.from === other.quote.from && this.theme === other.theme && this.navigation.sourcePath === other.navigation.sourcePath && (!/\[[^\]\r\n]*@/u.test(this.quote.raw) || this.navigation.documentSource === other.navigation.documentSource) && this.navigation.variableSource === other.navigation.variableSource; }
  toDOM(view: EditorView) {
    const dom = document.createElement('div'); dom.className = 'cm-live-rich-quote markdown-body';
    const token = { alive: true }; lifecycle.set(dom, token);
    dom.addEventListener('dblclick', (event) => { if (!(event.target as HTMLElement).closest('button,input,a')) revealSource(view, this.quote.from, event); });
    queueMicrotask(() => { if (dom.isConnected) void renderContent(dom, renderMarkdown(this.quote.raw, true, this.quote.from,this.navigation.variables), {
      theme: this.theme, folds: this.folds, current: () => token.alive && dom.isConnected,
      toggle: (task) => toggleTask(view, { task }), edit: (from) => revealDocumentSource(view, from),
      measure: () => view.requestMeasure(), ...this.navigation,
    }); });
    return dom;
  }
  destroy(dom: HTMLElement) { const token = lifecycle.get(dom); if (token) token.alive = false; clearRenderedContent(dom); }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 150; }
}

class FrontmatterWidget extends WidgetType {
  constructor(readonly frontmatter: Frontmatter, readonly navigation: LiveNavigation) { super(); }
  eq(other: FrontmatterWidget) { return this.frontmatter.raw === other.frontmatter.raw && this.frontmatter.error === other.frontmatter.error; }
  toDOM(view: EditorView) {
    const dom = document.createElement('div'); dom.className = 'cm-live-frontmatter markdown-body';
    void renderContent(dom, { html: frontmatterMarkup(this.frontmatter), frontmatter: this.frontmatter, tasks: [], maths: [], diagrams: [], callouts: [], links: [] }, {
      theme: 'dark', folds: new Map(), current: () => dom.isConnected, toggle: () => false,
      edit: (from) => revealDocumentSource(view, from), ...this.navigation,
    });
    const source = document.createElement('button'); source.className = 'frontmatter-source'; source.textContent = 'Edit YAML source';
    source.addEventListener('click', (event) => revealSource(view, 0, event)); dom.append(source);
    return dom;
  }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 45 + Math.min(Object.keys(this.frontmatter.values).length, 8) * 22; }
}

class WikiWidget extends WidgetType {
  constructor(readonly link: WikiLinkSpan, readonly navigation: LiveNavigation) { super(); }
  eq(other: WikiWidget) { return this.link.raw === other.link.raw && this.link.from === other.link.from; }
  toDOM() {
    const link = document.createElement('a'); link.className = 'wiki-link cm-live-wiki';
    link.href = '#'; link.textContent = this.link.label; link.title = this.link.target;
    link.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.navigation.openWiki?.(this.link.target); });
    return link;
  }
  ignoreEvent() { return true; }
}

class TaskWidget extends WidgetType {
  constructor(readonly task: TaskSpan) { super(); }
  eq(other: TaskWidget) { return JSON.stringify(this.task) === JSON.stringify(other.task); }
  updateDOM(dom: HTMLElement) {
    const input = dom as HTMLInputElement;
    input.checked = this.task.checked;
    input.setAttribute('aria-label', taskName(this.task));
    input.dataset.taskFrom = String(this.task.from);
    return true;
  }
  toDOM(view: EditorView) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'task-checkbox';
    this.updateDOM(input);
    input.addEventListener('mousedown', (event) => event.stopPropagation());
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('change', () => {
      const task = analyzeMarkdown(view.state.doc.toString()).tasks.find((span) => span.from === Number(input.dataset.taskFrom));
      if (task) toggleTask(view, { task });
    });
    return input;
  }
  ignoreEvent() { return true; }
}

class MathWidget extends WidgetType {
  constructor(readonly span: MathSpan) { super(); }
  eq(other: MathWidget) { return JSON.stringify(this.span) === JSON.stringify(other.span); }
  toDOM(view: EditorView) {
    const element: HTMLElement = document.createElement(this.span.block ? 'div' : 'span');
    element.className = `cm-live-math${this.span.display ? ' cm-live-math-display' : ''}${this.span.block ? ' cm-live-math-block' : ''}`;
    element.setAttribute('role', 'button');
    element.setAttribute('aria-label', this.span.display ? 'Edit block equation' : 'Edit inline equation');
    element.tabIndex = 0;
    renderMathInto(element, this.span.content, this.span.display);
    const edit = (event: Event) => revealSource(view, this.span.from + (this.span.display ? 2 : 1), event);
    element.addEventListener('mousedown', edit);
    element.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') edit(event); });
    return element;
  }
  ignoreEvent() { return true; }
  get estimatedHeight() { return this.span.block ? 70 : -1; }
}

class MermaidWidget extends WidgetType {
  constructor(readonly source: string, readonly theme: DiagramTheme, readonly from: number, readonly editAt: number) { super(); }

  eq(other: MermaidWidget) {
    return this.source === other.source && this.theme === other.theme && this.from === other.from && this.editAt === other.editAt;
  }

  toDOM(view: EditorView) {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-live-mermaid';
    wrapper.setAttribute('role', 'button');
    wrapper.setAttribute('aria-label', 'Edit Mermaid diagram');
    wrapper.tabIndex = 0;
    const diagram = document.createElement('div');
    diagram.className = 'diagram cm-live-mermaid-content';
    const hint = document.createElement('span');
    hint.className = 'cm-live-mermaid-edit';
    hint.textContent = 'Click to edit Mermaid';
    wrapper.append(diagram, hint);
    const token = { alive: true };
    lifecycle.set(wrapper, token);
    const edit = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: Math.min(this.editAt, view.state.doc.length) }, effects: setEditorFocus.of(true), scrollIntoView: true });
      view.focus();
      // Reconcile CM's notified focus before a rapid subsequent blur. Its DOM
      // focus observer otherwise runs on a timer, after our explicit reveal.
      view.dispatch({});
    };
    wrapper.addEventListener('mousedown', edit);
    wrapper.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') edit(event);
    });
    // toDOM runs before insertion; wait until the widget is in the document.
    queueMicrotask(() => {
      if (token.alive && wrapper.isConnected) {
        void renderMermaidInto(diagram, this.source, this.theme, () => token.alive).then(() => {
          if (token.alive && wrapper.isConnected) view.requestMeasure();
        });
      }
    });
    return wrapper;
  }

  destroy(dom: HTMLElement) { const token = lifecycle.get(dom); if (token) token.alive = false; clearRenderedContent(dom); }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 180; }
}

class BulletWidget extends WidgetType {
  constructor(readonly marker: string) { super(); }
  eq(other: BulletWidget) { return this.marker === other.marker; }
  toDOM() {
    const bullet = document.createElement('span');
    bullet.className = 'cm-live-bullet';
    bullet.textContent = /^[*+-]$/u.test(this.marker) ? '•' : this.marker;
    return bullet;
  }
  ignoreEvent() { return false; }
}

function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  if (!state.field(editorFocused)) return lines;
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let line = first; line <= last; line++) lines.add(line);
  }
  return lines;
}

function decorationsFor(state: EditorState, theme: DiagramTheme, standalone: boolean, folds: Map<string, boolean>, navigation: LiveNavigation): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const active = activeLines(state);
  const touchesActive = (from: number, to: number) => {
    for (let line = state.doc.lineAt(from).number; line <= state.doc.lineAt(to).number; line++) {
      if (active.has(line)) return true;
    }
    return false;
  };
  const widgetHidden = (from: number, to: number) => {
    let intersects = false;
    foldedRanges(state).between(from,to,(start,end) => { if (start < to && end > from) intersects = true; });
    return intersects || touchesActive(from,to);
  };
  const hide = (from: number, to: number) => {
    if (to > from && !touchesActive(from, to)) decorations.push(Decoration.replace({}).range(from, to));
  };
  const mark = (from: number, to: number, className: string) => {
    for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(to).number; number++) {
      if (active.has(number)) continue;
      const line = state.doc.line(number);
      const start = Math.max(from, line.from), end = Math.min(to, line.to);
      if (end > start) decorations.push(Decoration.mark({ class: className }).range(start, end));
    }
  };
  const lineStyle = (from: number, className: string) => {
    const line = state.doc.lineAt(from);
    if (!active.has(line.number)) decorations.push(Decoration.line({ class: className }).range(line.from));
  };

  if (standalone) {
    if (!state.field(editorFocused) && state.doc.length) decorations.push(Decoration.replace({
      widget: new MermaidWidget(state.doc.toString(), theme, 0, 0), block: true,
    }).range(0, state.doc.length));
    return Decoration.set(decorations, true);
  }

  const text = state.doc.toString(), frontmatter = parseFrontmatter(text);
  const citations = liveCitations(text);
  navigation={...navigation,variables:frontmatter?.values??{},documentSource:text,variableSource:frontmatter?.raw??'',citationGroups:orderedCitationGroups(text,citations.map(span => span.raw)),includeBibliography:false};
  const footnotes=extractFootnotes(text);
  const tree = frontmatter?.closed || footnotes.definitions.length ? featureParser.parse(footnotes.source) : ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  const features = analyzeMarkdown(text);
  for (const block of scanBlockReferences(text)) hide(block.markerFrom,block.markerTo);
  const callouts = analyzeCallouts(text);
  const tables = markdownTables(text).filter(table => !table.error);
  for (const table of tables) if (!widgetHidden(table.from, table.to)) decorations.push(Decoration.replace({ widget:new DocumentWidget(text.slice(table.from,table.to),table.from,theme,navigation,'table'),block:true }).range(table.from,table.to));
  const richQuotes = analyzeQuotes(text).filter((quote) => !callouts.some((callout) => callout.from === quote.from) && containsCallout(quote.body));
  const insideCallout = (from: number) => [...callouts, ...richQuotes, ...footnotes.definitions, ...tables].some((callout) => from >= callout.from && from < callout.to);
  for (const citation of citations) if (!insideCallout(citation.from) && !widgetHidden(citation.from, citation.to)) decorations.push(Decoration.replace({ widget: new CitationWidget(citation,text,navigation), inclusive:false }).range(citation.from,citation.to));
  if (citations.length || frontmatter?.values.nocite) decorations.push(Decoration.widget({ widget: new BibliographyWidget(text,citations,navigation), block:true, side:1 }).range(state.doc.length));
  const variables=inlineVariables(text,navigation.variables??{});
  for(const variable of variables)if(!insideCallout(variable.from)&&!widgetHidden(variable.from,variable.to))decorations.push(Decoration.replace({widget:new VariableWidget(variable)}).range(variable.from,variable.to));
  for(const definition of footnotes.definitions)if(!widgetHidden(definition.from,definition.to))decorations.push(Decoration.replace({widget:new DocumentWidget('[^'+definition.id+']\n\n'+text.slice(definition.from,definition.to),definition.from,theme,navigation,'footnote'),block:true}).range(definition.from,definition.to));
  const footnoteIds=[...new Set(footnotes.references.map(ref=>ref.id))];
  for(const reference of footnotes.references){const definition=footnotes.definitions.find(item=>item.id===reference.id);if(definition&&!insideCallout(reference.from)&&!widgetHidden(reference.from,reference.to))decorations.push(Decoration.replace({widget:new FootnoteWidget(reference.id,footnoteIds.indexOf(reference.id)+1,definition.from)}).range(reference.from,reference.to));}
  if (frontmatter?.closed && !widgetHidden(0, frontmatter.to)) decorations.push(Decoration.replace({ widget: new FrontmatterWidget(frontmatter, navigation), block: true }).range(0, frontmatter.to));
  for (const quote of richQuotes) if (!widgetHidden(quote.from, quote.to)) decorations.push(Decoration.replace({ widget: new RichQuoteWidget(quote, theme, folds, navigation), block: true }).range(quote.from, quote.to));
  for (const callout of callouts) if (!widgetHidden(callout.from, callout.to)) decorations.push(Decoration.replace({
    widget: new CalloutWidget(callout, theme, folds, navigation), block: true,
  }).range(callout.from, callout.to));
  for (const link of features.links) if (!insideCallout(link.from) && !widgetHidden(link.from, link.to)) {
    const embedded = text[link.from - 1] === '!' && text[link.from - 2] !== '\\';
    const from = embedded ? link.from - 1 : link.from;
    decorations.push(Decoration.replace({ widget: embedded ? new DocumentWidget('!' + link.raw,from,theme,navigation,'embed') : new WikiWidget(link,navigation), inclusive: false }).range(from,link.to));
  }
  for (const task of features.tasks) {
    if (insideCallout(task.from)) continue;
    const markerSelected = state.field(editorFocused) && state.selection.ranges.some((range) =>
      range.empty ? range.from >= task.from && range.from < task.to : range.from < task.to && range.to > task.from);
    if (!markerSelected) decorations.push(Decoration.replace({ widget: new TaskWidget(task), inclusive: false }).range(task.from, task.to));
  }
  for (const span of features.maths) {
    if (insideCallout(span.from)) continue;
    if (!widgetHidden(span.from, span.to)) decorations.push(Decoration.replace({ widget: new MathWidget(span), block: span.block, inclusive: false }).range(span.from, span.to));
  }
  tree.iterate({
    enter(node) {
      const { from, to, name } = node;
      // A wikilink owns its whole span. Lezer also sees its inner brackets as
      // a Markdown link; decorating those again overlaps the inline widget.
      if (features.links.some((link) => from >= link.from && to <= link.to)) return false;
      if (citations.some(citation => from >= citation.from && to <= citation.to) || tables.some(table => from >= table.from && to <= table.to)) return false;
      if (footnotes.references.some(reference=>from>=reference.from&&to<=reference.to)||variables.some(variable=>from>=variable.from&&to<=variable.to))return false;
      if (name === 'Blockquote' && [...callouts, ...richQuotes].some((callout) => callout.from === from && callout.to === to)) return false;
      if (name === 'NotationMathInline' || name === 'NotationMathBlock') return false;
      if (name === 'FencedCode') {
        const info = node.node.getChild('CodeInfo');
        const language=info?state.sliceDoc(info.from,info.to).trim():'';
        if (info && (language.toLowerCase() === 'query' || /^(?:dot|graphviz|d2|plantuml|puml)$/iu.test(language) || /^(?:js|javascript)\s+cell:/u.test(language)) && !widgetHidden(from,to)) {
          decorations.push(Decoration.replace({widget: new DocumentWidget(state.sliceDoc(from,to),from,theme,navigation,language==='query'?'query':/cell:/u.test(language)?'cell':'advanced'),block:true}).range(from,to)); return false;
        }
        if (info && state.sliceDoc(info.from, info.to).trim().toLowerCase() === 'mermaid' && !widgetHidden(from, to)) {
          const body = node.node.getChild('CodeText');
          decorations.push(Decoration.replace({
            widget: new MermaidWidget(body ? state.sliceDoc(body.from, body.to) : '', theme, from, body?.from ?? state.doc.lineAt(from).to),
            block: true,
          }).range(from, to));
        }
        return false;
      }
      if(name==='Image'){if(!widgetHidden(from,to))decorations.push(Decoration.replace({widget:new DocumentWidget(state.sliceDoc(from,to),from,theme,navigation,'media')}).range(from,to));return false;}
      if (name === 'CodeBlock' || name === 'HTMLBlock') return false;
      if (name.startsWith('ATXHeading')) decorations.push(Decoration.line({ class: `cm-live-heading cm-live-h${name.slice(-1)}` }).range(state.doc.lineAt(from).from));
      if (name === 'HeaderMark') {
        let start = from, end = to;
        const parent = node.node.parent!;
        if (from === parent.from) {
          while (end < parent.to && /[ \t]/u.test(state.sliceDoc(end, end + 1))) end++;
        } else {
          while (start > parent.from && /[ \t]/u.test(state.sliceDoc(start - 1, start))) start--;
        }
        hide(start, end);
      }
      if (name === 'StrongEmphasis') mark(from, to, 'cm-live-strong');
      if (name === 'Emphasis') mark(from, to, 'cm-live-emphasis');
      if (name === 'EmphasisMark') hide(from, to);
      if (name === 'InlineCode') {
        mark(from, to, 'cm-live-code');
        for (const child of node.node.getChildren('CodeMark')) hide(child.from, child.to);
        return false;
      }
      if (name === 'Link') {
        const marks = node.node.getChildren('LinkMark');
        const first = marks[0];
        const close = marks.find((child) => state.sliceDoc(child.from, child.to) === ']');
        if (first && close) {
          hide(from, first.to);
          hide(close.from, to);
          mark(first.to, close.from, 'cm-live-link');
        }
      }
      if (name === 'ListMark' && !touchesActive(from, to)) {
        decorations.push(Decoration.replace({ widget: new BulletWidget(state.sliceDoc(from, to)) }).range(from, to));
        lineStyle(from, 'cm-live-list');
      }
      if (name === 'QuoteMark') {
        hide(from, to + (state.sliceDoc(to, to + 1) === ' ' ? 1 : 0));
        lineStyle(from, 'cm-live-quote');
      }
    },
  });
  return Decoration.set(decorations, true);
}

export function livePreview(theme: DiagramTheme, standalone: boolean, folds: Map<string, boolean>, navigation: LiveNavigation = {}): Extension {
  navigation = { ...navigation, citationScope: citationScope() };
  const field = StateField.define<DecorationSet>({
    create: (state) => decorationsFor(state, theme, standalone, folds, navigation),
    update: (_value, transaction) => decorationsFor(transaction.state, theme, standalone, folds, navigation),
    provide: (state) => EditorView.decorations.from(state),
  });
  return [field, EditorView.editorAttributes.of({ class: 'cm-live-preview' })];
}
