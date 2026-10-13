import { parser } from '@lezer/markdown';
import type { MarkdownConfig } from '@lezer/markdown';
import { scanFrontmatter } from './frontmatter';
import { scanWikiLinks } from './wiki-syntax';
import type { WikiLinkSpan } from './wiki-syntax';

export type TaskSpan = { from: number; to: number; marker: string; checked: boolean; label: string; listed: boolean };
export type MathSpan = { from: number; to: number; content: string; display: boolean; block: boolean };

function escaped(text: string, at: number): boolean {
  let slashes = 0;
  while (at > 0 && text[--at] === '\\') slashes++;
  return slashes % 2 === 1;
}

export function mathAt(text: string, from: number): MathSpan | null {
  if (text[from] !== '$' || escaped(text, from)) return null;
  const display = text[from + 1] === '$';
  const size = display ? 2 : 1;
  if (!display && (!text[from + 1] || /\s/u.test(text[from + 1]))) return null;
  for (let at = from + size; at < text.length; at++) {
    if (!display && text[at] === '\n') return null;
    if (text[at] !== '$' || escaped(text, at)) continue;
    if (display && text[at + 1] !== '$') continue;
    if (!display && (text[at + 1] === '$' || /\s/u.test(text[at - 1]) || /[0-9]/u.test(text[at + 1] ?? ''))) return null;
    if (at === from + size) return null;
    return { from, to: at + size, content: text.slice(from + size, at), display, block: false };
  }
  return null;
}

export const mathMarkdown: MarkdownConfig = {
  defineNodes: [{ name: 'NotationMathInline' }, { name: 'NotationMathBlock', block: true }],
  parseInline: [{
    name: 'NotationMath', before: 'Emphasis',
    parse(cx, next, pos) {
      if (next !== 36) return -1;
      const span = mathAt(cx.text, pos - cx.offset);
      return span ? cx.addElement(cx.elt('NotationMathInline', pos, span.to + cx.offset)) : -1;
    },
  }],
  parseBlock: [{
    name: 'NotationMathBlock', before: 'FencedCode',
    endLeaf(_cx, line) { return line.text.slice(line.pos).trim() === '$$'; },
    parse(cx, line) {
      if (line.indent >= line.baseIndent + 4 || !line.text.slice(line.pos).startsWith('$$')) return false;
      const start = cx.lineStart + line.pos;
      const sameLine = mathAt(line.text, line.pos);
      if (sameLine && !line.text.slice(sameLine.to).trim()) {
        cx.addElement(cx.elt('NotationMathBlock', start, cx.lineStart + sameLine.to));
        cx.nextLine();
        return true;
      }
      if (line.text.slice(line.pos).trim() !== '$$') return false;
      let quoteDepth = 0, inList = false;
      for (let depth = 0; depth < cx.depth; depth++) {
        const parent = cx.parentType(depth).name;
        if (parent === 'Blockquote') quoteDepth++;
        if (parent === 'ListItem') inList = true;
      }
      const baseIndent = line.baseIndent;
      let end = cx.lineStart + line.text.length;
      while (cx.nextLine()) {
        // nextLine skips enclosing quote/list markup into line.pos. Stop at
        // their boundary without consuming the first line outside the block.
        const quoteMarks = line.markers.filter((mark) => cx.parser.nodeSet.types[mark.type].name === 'QuoteMark').length;
        if (quoteMarks < quoteDepth || (inList && line.text.slice(line.pos).trim() && line.baseIndent < baseIndent)) break;
        end = cx.lineStart + line.text.length;
        if (line.text.slice(line.pos).trim() === '$$') {
          cx.addElement(cx.elt('NotationMathBlock', start, end));
          cx.nextLine();
          return true;
        }
      }
      cx.addElement(cx.elt('NotationMathBlock', start, end));
      return true;
    },
  }],
};

export const featureParser = parser.configure(mathMarkdown);
let cachedText: string | undefined;
let cachedFrontmatter = true;
let cachedResult: { tasks: TaskSpan[]; maths: MathSpan[]; links: WikiLinkSpan[] };

export function markdownSource(text: string, allowFrontmatter = true): string {
  const frontmatter = allowFrontmatter ? scanFrontmatter(text) : null;
  // Work in UTF-16 code units, like CodeMirror positions (including emoji).
  return frontmatter?.closed ? text.slice(0, frontmatter.bodyStart).replace(/[^\r\n]/g, ' ') + text.slice(frontmatter.bodyStart) : text;
}

export function analyzeMarkdown(text: string, allowFrontmatter = true): { tasks: TaskSpan[]; maths: MathSpan[]; links: WikiLinkSpan[] } {
  if (cachedText === text && cachedFrontmatter === allowFrontmatter) return cachedResult;
  const excluded: { from: number; to: number }[] = [];
  const linkExcluded: { from: number; to: number }[] = [];
  const frontmatter = allowFrontmatter ? scanFrontmatter(text) : null;
  if (frontmatter?.closed) excluded.push({ from: 0, to: frontmatter.bodyStart });
  const maths: MathSpan[] = [];
  featureParser.parse(markdownSource(text, allowFrontmatter)).iterate({
    enter(node) {
      if (node.name === 'Link') linkExcluded.push({ from: node.from, to: node.to });
      if (node.name === 'NotationMathInline' || node.name === 'NotationMathBlock') {
        const span = mathAt(text, node.from);
        if (span && span.to <= node.to) maths.push({ ...span, block: node.name === 'NotationMathBlock' });
        excluded.push({ from: node.from, to: node.to });
        return false;
      }
      if (['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag'].includes(node.name)) {
        excluded.push({ from: node.from, to: node.to });
        return false;
      }
    },
  });
  const tasks: TaskSpan[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const match = /^([ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?)(\[(?: |x|X)?\])(?=[ \t]|\r?$)/u.exec(line);
    if (match) {
      const from = offset + match[1].length, to = from + match[2].length;
      if (!excluded.some((range) => from < range.to && to > range.from)) tasks.push({
        from, to, marker: match[2], checked: /x/iu.test(match[2]),
        label: line.slice(match[0].length).trim(),
        listed: /(?:[-+*]|\d+[.)])[ \t]+$/u.test(match[1]),
      });
    }
    offset += line.length + 1;
  }
  cachedText = text;
  cachedFrontmatter = allowFrontmatter;
  return cachedResult = { tasks, maths, links: scanWikiLinks(text, excluded).filter((link) => !linkExcluded.some((range) => range.from <= link.from && range.to >= link.to)) };
}

export function taskName(task: TaskSpan): string {
  const label = task.label.replace(/[*_`]/gu, '');
  return label ? `Task: ${label}` : 'Task';
}

export type TaskToggle = { task: TaskSpan; snapshot?: string };

export type CalloutSpan = { from: number; to: number; type: string; title: string; folded: boolean; key: string; body: string; mapping: number[] };
export type QuoteSpan = { from: number; to: number; raw: string; body: string; mapping: number[] };

function quoteBody(raw: string, from: number, skipHeader: boolean) {
  const lines = raw.split('\n');
  let body = '', offset = from;
  const mapping: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (skipHeader && index === 0) { offset += line.length + 1; continue; }
    const prefix = /^ {0,3}>[ \t]?/u.exec(line)?.[0].length ?? 0;
    const plain = line.slice(prefix);
    for (let at = 0; at < plain.length; at++) mapping.push(offset + prefix + at);
    body += plain;
    if (index < lines.length - 1) { mapping.push(offset + line.length); body += '\n'; }
    offset += line.length + 1;
  }
  mapping.push(from + raw.length);
  return { body, mapping };
}

export function analyzeQuotes(text: string, allowFrontmatter = true): QuoteSpan[] {
  const quotes: QuoteSpan[] = [];
  featureParser.parse(markdownSource(text, allowFrontmatter)).iterate({ enter(node) {
    if (['FencedCode', 'CodeBlock', 'HTMLBlock', 'NotationMathBlock'].includes(node.name)) return false;
    if (node.name !== 'Blockquote') return;
    const raw = text.slice(node.from, node.to);
    quotes.push({ from: node.from, to: node.to, raw, ...quoteBody(raw, node.from, false) });
    return false;
  } });
  return quotes;
}

export function analyzeCallouts(text: string, allowFrontmatter = true): CalloutSpan[] {
  const callouts: CalloutSpan[] = [];
  for (const quote of analyzeQuotes(text, allowFrontmatter)) {
    const { raw, from, to } = quote, lines = raw.split('\n');
    const header = /^ {0,3}>[ \t]*\[!([A-Za-z]+)\]([+-]?)(?:[ \t]+(.*))?$/u.exec(lines[0].replace(/\r$/u, ''));
    if (!header) continue;
    const type = header[1].toUpperCase();
    const title = header[3]?.trim() || type[0] + type.slice(1).toLowerCase();
    callouts.push({ from, to, type, title, folded: header[2] === '-', key: `${type}:${title}:${from}`, ...quoteBody(raw, from, true) });
  }
  return callouts;
}

export function containsCallout(text: string, depth = 0): boolean {
  if (depth > 24) return false;
  return analyzeCallouts(text, false).length > 0 || analyzeQuotes(text, false).some((quote) => containsCallout(quote.body, depth + 1));
}
