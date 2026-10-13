import { Marked, Renderer } from 'marked';
import type { Tokens } from 'marked';
import { analyzeCallouts, analyzeMarkdown, analyzeQuotes, markdownSource, mathAt } from './markdown-features';
import type { CalloutSpan, MathSpan, TaskSpan } from './markdown-features';
import { parseWikiLink } from './wiki-syntax';
import type { WikiLinkSpan } from './wiki-syntax';
import { parseFrontmatter } from './frontmatter';
import type { Frontmatter } from './frontmatter';
import { extractFootnotes } from './footnotes';
import { mediaKind } from './media-path';
import { citationAt, scanCitations } from './citations';
import type { CitationSpan } from './citations';
import { resolveVariable } from './templates';

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function calloutKind(type: string) {
  if (['WARNING', 'WARN', 'CAUTION', 'ATTENTION'].includes(type)) return 'warning';
  if (['TIP', 'HINT', 'IMPORTANT', 'SUCCESS'].includes(type)) return 'tip';
  if (['DANGER', 'ERROR', 'FAILURE', 'FAIL', 'BUG'].includes(type)) return 'danger';
  if (['QUESTION', 'HELP', 'FAQ'].includes(type)) return 'question';
  return 'information';
}

export function calloutIcon(type: string): string {
  const paths = {
    warning: '<path d="M8 2 15 14H1Z"/><path d="M8 6v4m0 2v.1"/>',
    tip: '<path d="M5 10a5 5 0 1 1 6 0l-1 2H6Z"/><path d="M6 14h4"/>',
    danger: '<path d="M5 1h6l4 4v6l-4 4H5l-4-4V5Z"/><path d="m5.5 5.5 5 5m0-5-5 5"/>',
    question: '<circle cx="8" cy="8" r="7"/><path d="M5.5 5.5a2.5 2.5 0 1 1 4 2C8 8.5 8 9 8 10m0 2v.1"/>',
    information: '<circle cx="8" cy="8" r="7"/><path d="M8 7v5m0-8v.1"/>',
  };
  return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">' + paths[calloutKind(type)] + '</svg>';
}

export function calloutMarkup(callout: CalloutSpan, index: number, body: string) {
  return `<section class="callout callout-${calloutKind(callout.type)}" role="region" aria-label="${escapeHtml(`Callout: ${callout.title}`)}" data-callout-index="${index}" data-callout-type="${escapeHtml(callout.type)}"><div class="callout-heading"><button class="callout-toggle" data-callout-toggle><span class="callout-icon" data-callout-icon aria-hidden="true"></span><span class="callout-type">${escapeHtml(callout.type)}</span><span class="callout-title">${escapeHtml(callout.title)}</span><span class="callout-chevron">⌄</span></button><button class="callout-edit" data-callout-edit aria-label="Edit callout">Edit</button></div><div class="callout-body" data-callout-body>${body}</div></section>`;
}

export function frontmatterMarkup(frontmatter: Frontmatter): string {
  if (frontmatter.error) return `<section class="frontmatter-properties" aria-label="Frontmatter"><div role="alert" class="frontmatter-error">${escapeHtml(frontmatter.error)}</div><button data-edit-properties>Edit properties</button></section>`;
  const entries = Object.entries(frontmatter.values);
  const rows = entries.slice(0, 8).map(([key, value]) => {
    let label: string;
    try { label = typeof value === 'string' ? value : JSON.stringify(value) ?? 'null'; } catch { label = '[complex value]'; }
    return `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(label.length > 180 ? label.slice(0, 180) + '…' : label)}</dd>`;
  }).join('');
  return `<section class="frontmatter-properties" aria-label="Frontmatter"><div class="frontmatter-heading"><strong>Properties${entries.length ? ` · ${entries.length}` : ''}</strong><button data-edit-properties>Edit properties</button></div>${rows ? `<dl>${rows}</dl>` : ''}${entries.length > 8 ? '<span class="frontmatter-more">More properties in the properties panel</span>' : ''}</section>`;
}

type RenderResult = { citations?: CitationSpan[]; documentSource?: string; html: string; tasks: TaskSpan[]; maths: MathSpan[]; diagrams: string[]; callouts: CalloutSpan[]; links: WikiLinkSpan[]; frontmatter: Frontmatter | null; embeds?: WikiLinkSpan[]; queries?: string[]; cells?: {id:string;code:string;runnable:boolean}[]; advanced?: {engine:string;source:string}[] };

function buildMarkdown(text: string, allowCallouts: boolean, offset: number, outer?: CalloutSpan, suppliedVariables?:Record<string,unknown>): RenderResult {
  const result: RenderResult = { citations: [], documentSource: text, html: '', tasks: [], maths: [], diagrams: [], callouts: [], links: [], embeds: [], queries: [], cells: [], advanced: [], frontmatter: outer ? null : parseFrontmatter(text) };
  if (!result.frontmatter?.closed) result.frontmatter = null;
  const variables=suppliedVariables??result.frontmatter?.values??{};
  const footnotes = new Map<string,{body:string;position:(at:number)=>number}>(), footnoteOrder:string[]=[];
  function renderFragment(source: string, position: (from: number) => number, depth: number, allowFrontmatter = false): string {
    if (depth > 24) return `<pre>${escapeHtml(source)}</pre>`;
    const extracted = extractFootnotes(source,allowFrontmatter);
    for(const definition of extracted.definitions) if(!footnotes.has(definition.id)) footnotes.set(definition.id,{body:definition.body,position:(at)=>position(definition.mapping[at]??definition.to)});
    source = extracted.source;
    const features = analyzeMarkdown(source, allowFrontmatter);
    const quotes = analyzeQuotes(source, allowFrontmatter), callouts = allowCallouts ? analyzeCallouts(source, allowFrontmatter) : [];
    let taskCursor = 0, quoteCursor = 0, citationCursor = 0;
    const citationSpans = scanCitations(source);
    const taskHtml = (marker?: string, label?: string) => {
      const task = features.tasks[taskCursor];
      if (!task || (marker !== undefined && (task.marker !== marker || task.label !== label))) return null;
      taskCursor++;
      const index = result.tasks.push({ ...task, from: position(task.from), to: position(task.to) }) - 1;
      return `<input type="checkbox" class="task-checkbox" data-task-index="${index}"${task.checked ? ' checked' : ''}>`;
    };
    const mathToken = (source: string, block: boolean) => {
      const span = mathAt(source, 0);
      return span ? { type: block ? 'notationBlockMath' : 'notationInlineMath', raw: source.slice(0, span.to), span: { ...span, block } } : undefined;
    };
    const mathHtml = (token: Tokens.Generic) => {
      const span = token.span as MathSpan, index = result.maths.push(span) - 1, tag = span.block ? 'div' : 'span';
      return `<${tag} class="rendered-math" data-math-index="${index}"></${tag}>`;
    };
    const renderer = new Renderer(), defaultCode = renderer.code.bind(renderer);
    let insideLink = false;
    let insideList=false;
    renderer.list=function(token){const previous=insideList;insideList=true;try{return Renderer.prototype.list.call(this,token);}finally{insideList=previous;}};
    renderer.link = function (token) {
      const previous = insideLink;
      insideLink = true;
      try { return Renderer.prototype.link.call(this, token); } finally { insideLink = previous; }
    };
    renderer.code = (token) => {
      const cell=/^(?:js|javascript)\s+cell:([A-Za-z][A-Za-z0-9_-]{0,63})$/u.exec(token.lang?.trim()??'');
      if(cell){const index=result.cells!.push({id:cell[1],code:token.text,runnable:depth===0&&!insideList})-1;return `<section class="code-cell" data-cell-index="${index}"><pre><code>${escapeHtml(token.text)}</code></pre></section>`;}
      const engine=token.lang?.trim().toLowerCase();
      if(engine&&['dot','graphviz','d2','plantuml','puml'].includes(engine)){const index=result.advanced!.push({engine:engine==='graphviz'?'dot':engine==='puml'?'plantuml':engine,source:token.text})-1;return `<div class="diagram advanced-diagram" data-advanced-index="${index}">Rendering ${escapeHtml(engine)}…</div>`;}
      if (token.lang?.trim().toLowerCase() === 'query') {
        const index = result.queries!.push(token.text) - 1;
        return `<div class="database-view" data-query-index="${index}">Loading query…</div>`;
      }
      if (token.lang?.trim().toLowerCase() !== 'mermaid') return defaultCode(token);
      const index = result.diagrams.push(token.text) - 1;
      return `<div class="diagram" data-diagram="${index}"><span class="diagram-loading">Rendering diagram…</span></div>`;
    };
    renderer.checkbox = () => taskHtml() ?? '<input type="checkbox" disabled>';
    renderer.blockquote = (token) => {
      const quote = quotes[quoteCursor++];
      if (!quote) return `<blockquote>${escapeHtml(token.text)}</blockquote>`;
      // Nested fragments own their task cursors; skip those source spans in the
      // parent before rendering subsequent sibling lists/checkboxes.
      while (features.tasks[taskCursor]?.from < quote.to) taskCursor++;
      while (citationSpans[citationCursor]?.from < quote.to) citationCursor++;
      const callout = callouts.find((item) => item.from === quote.from);
      if (callout) {
        const from = position(callout.from), to = position(callout.to);
        const mapped = { ...callout, from, to, key: `${callout.type}:${callout.title}:${from}`, mapping: callout.mapping.map(position) };
        const index = result.callouts.push(mapped) - 1;
        return calloutMarkup(mapped, index, renderFragment(callout.body, (at) => position(callout.mapping[at] ?? callout.to), depth + 1));
      }
      return `<blockquote>${renderFragment(quote.body, (at) => position(quote.mapping[at] ?? quote.to), depth + 1)}</blockquote>`;
    };
    const marked = new Marked({ renderer });
    marked.use({ extensions: [
      { name: 'notationCitation', level: 'inline', start: source => source.indexOf('['), tokenizer(source) { if (this.lexer.state.inLink || this.lexer.state.inRawBlock) return undefined; const span = citationAt(source); return span && !['(', '['].includes(source[span.to]) ? { type: 'notationCitation', raw: span.raw } : undefined; }, renderer(token) { if (insideLink) return escapeHtml(token.raw); let span = citationSpans.slice(citationCursor).find(item => item.raw === token.raw); if (!span) return escapeHtml(token.raw); citationCursor = citationSpans.indexOf(span) + 1; const index = result.citations!.push({ ...span, from: position(span.from), to: position(span.to) }) - 1; return `<span class="citation-reference" data-citation-index="${index}">${escapeHtml(token.raw)}</span>`; } },
      {name:'notationVariable',level:'inline',start:source=>source.indexOf('{{'),tokenizer(source){const match=/^\{\{([^{}\r\n]{1,256})\}\}/u.exec(source);return match?{type:'notationVariable',raw:match[0],name:match[1].trim()}:undefined;},renderer(token){const value=resolveVariable(token.name as string,variables);return `<span class="document-variable${value===null?' unresolved-variable':''}" title="${escapeHtml('Variable: '+token.name)}">${escapeHtml(value??token.raw)}</span>`;}},
      {
        name:'notationFootnote',level:'inline',start:source=>source.indexOf('[^'),
        tokenizer(source){const match=/^\[\^([A-Za-z0-9_-]{1,128})\]/u.exec(source);return match?{type:'notationFootnote',raw:match[0],id:match[1]}:undefined;},
        renderer(token){if(insideLink)return escapeHtml(token.raw);const id=token.id as string;if(!footnoteOrder.includes(id)&&footnoteOrder.length<100)footnoteOrder.push(id);return `<sup><a href="#" class="footnote-reference" data-footnote-ref="${escapeHtml(id)}" aria-label="Footnote ${escapeHtml(id)}">${footnoteOrder.indexOf(id)+1||escapeHtml(id)}</a></sup>`;},
      },
      {
        name: 'notationEmbed', level: 'inline', start: (source) => source.indexOf('![['),
        tokenizer(source) {
          if (!source.startsWith('![[') || this.lexer.state.inLink || this.lexer.state.inRawBlock) return undefined;
          const end = source.indexOf(']]'), link = end >= 0 ? parseWikiLink(source.slice(1, end + 2)) : null;
          return link ? { type: 'notationEmbed', raw: '!' + link.raw, link } : undefined;
        },
        renderer(token) {
          const link = token.link as WikiLinkSpan;
          if (insideLink) return escapeHtml('!' + link.raw);
          const kind=mediaKind(link.note);
          if(kind)return `<img src="${escapeHtml(link.note + (link.heading ? '#' + link.heading : ''))}" data-media-kind="${kind}" alt="${escapeHtml(link.label)}">`;
          const index = result.embeds!.push(link) - 1;
          return `<span class="note-embed" data-embed-index="${index}">Loading ${escapeHtml(link.label)}…</span>`;
        },
      },
      {
        name: 'notationBlockId', level: 'inline', start: (source) => { const match = /(?:^|[ \t])\^[A-Za-z0-9][A-Za-z0-9-]*[ \t]*(?=\n|$)/u.exec(source); return match ? match.index + match[0].indexOf('^') : undefined; },
        tokenizer(source) { const match = /^\^[A-Za-z0-9][A-Za-z0-9-]*[ \t]*(?=\n|$)/u.exec(source); return match ? { type: 'notationBlockId', raw: match[0] } : undefined; }, renderer: () => '',
      },
      {
        name: 'notationBlockMath', level: 'block', start: (source) => source.search(/^\$\$/mu),
        tokenizer(source) {
          if (!source.startsWith('$$')) return undefined;
          const token = mathToken(source, true);
          return !token || source.slice(token.raw.length).split('\n')[0].trim() ? undefined : token;
        }, renderer: mathHtml,
      },
      { name: 'notationInlineMath', level: 'inline', start: (source) => source.indexOf('$'), tokenizer: (source) => mathToken(source, false), renderer: mathHtml },
      {
        name: 'notationWikiLink', level: 'inline', start: (source) => source.indexOf('[['),
        tokenizer(source) {
          if (!source.startsWith('[[') || this.lexer.state.inLink || this.lexer.state.inRawBlock) return undefined;
          const end = source.indexOf(']]'), link = end >= 0 ? parseWikiLink(source.slice(0, end + 2)) : null;
          return link ? { type: 'notationWikiLink', raw: link.raw, link } : undefined;
        },
        renderer(token) {
          const link = token.link as WikiLinkSpan;
          if (insideLink) return escapeHtml(link.raw);
          const index = result.links.push(link) - 1;
          return `<a class="wiki-link" href="#" data-wiki-index="${index}" title="${escapeHtml(link.target)}">${escapeHtml(link.label)}</a>`;
        },
      },
      {
        name: 'notationBareTask', level: 'block', start: (source) => source.search(/^[ \t]{0,3}\[(?: |x|X)?\](?=[ \t\n]|$)/mu),
        tokenizer(source) {
          const match = /^[ \t]{0,3}(\[(?: |x|X)?\])(?=[ \t\n]|$)[ \t]*([^\n]*)(?:\n|$)/u.exec(source);
          return match ? { type: 'notationBareTask', raw: match[0], marker: match[1], label: match[2].trim(), tokens: this.lexer.inlineTokens(match[2]) } : undefined;
        },
        renderer(token) {
          const checkbox = taskHtml(token.marker as string, token.label as string);
          return checkbox ? `<p class="task-line">${checkbox} ${this.parser.parseInline(token.tokens ?? [])}</p>\n` : `<p>${escapeHtml(token.raw)}</p>\n`;
        },
      },
    ] });
    return marked.parse(markdownSource(source, allowFrontmatter), { async: false }) as string;
  }
  if (outer) {
    result.callouts.push(outer);
    result.html = calloutMarkup(outer, 0, renderFragment(outer.body, (at) => outer.mapping[at] ?? outer.to, 1));
  } else {
    result.html = (result.frontmatter ? frontmatterMarkup(result.frontmatter) : '') + renderFragment(text, (at) => at + offset, 0, true);
  }
  if(footnoteOrder.length){
    let items='';
    for(let at=0;at<footnoteOrder.length&&at<100;at++){
      const id=footnoteOrder[at],definition=footnotes.get(id);
      const body=definition?renderFragment(definition.body,definition.position,1):`<p role="alert">Missing footnote: ${escapeHtml(id)}</p>`;
      items+=`<li data-footnote-id="${escapeHtml(id)}">${body}<a href="#" data-footnote-back="${escapeHtml(id)}" aria-label="Back to footnote ${escapeHtml(id)}">↩</a></li>`;
    }
    result.html+='<section class="footnotes" aria-label="Footnotes"><ol>'+items+'</ol></section>';
  }
  return result;
}

export function renderMarkdown(text: string, allowCallouts = true, offset = 0, variables?:Record<string,unknown>) { return buildMarkdown(text, allowCallouts, offset,undefined,variables); }
export function renderCallout(callout: CalloutSpan,variables?:Record<string,unknown>) { return buildMarkdown(callout.body, true, 0, callout,variables); }
