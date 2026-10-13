import { featureParser, markdownSource } from './markdown-features';
export type CitationSpan = { from: number; to: number; raw: string; keys: string[] };
function escaped(text: string, at: number) { let count = 0; while (at > 0 && text[--at] === '\\') count++; return count % 2 === 1; }
export function citationAt(text: string, from = 0): CitationSpan | null {
  if (text[from] !== '[' || text[from + 1] === '[' || text[from - 1] === '[' || escaped(text, from)) return null;
  const end = text.indexOf(']', from + 1);
  if (end < 0 || end - from > 2048 || /[\r\n\[]/u.test(text.slice(from + 1, end))) return null;
  const raw = text.slice(from, end + 1), keys: string[] = [];
  for (const match of raw.matchAll(/(?:^|[\s;,(])-?@([\p{L}\p{N}_][\p{L}\p{N}_:.#$%&+?<>~/-]*)/gu)) keys.push(match[1].replace(/[.:?]+$/u, ''));
  // The opening bracket is also a citation boundary, unlike the middle of an email.
  const first = /^\[\s*-?@([\p{L}\p{N}_][\p{L}\p{N}_:.#$%&+?<>~/-]*)/u.exec(raw);
  if (first) keys.unshift(first[1].replace(/[.:?]+$/u, ''));
  return keys.length ? { from, to: end + 1, raw, keys: [...new Set(keys)] } : null;
}
function explicitLinks(text: string, excluded: { from: number; to: number }[]) {
  const links: { from: number; to: number }[] = [], stack: number[] = [];
  const ranges = [...excluded].sort((a,b) => a.from - b.from || b.to - a.to); let rangeIndex = 0;
  for (let at = 0; at < text.length; at++) {
    while (rangeIndex < ranges.length && ranges[rangeIndex].to <= at) rangeIndex++;
    const ignored = ranges[rangeIndex]?.from <= at ? ranges[rangeIndex] : undefined;
    if (ignored) { at = ignored.to - 1; continue; }
    if (escaped(text, at)) continue;
    if (text[at] === '[') stack.push(at);
    else if (text[at] === ']' && stack.length) {
      const from = stack.pop()!, opener = text[at + 1];
      if (opener !== '(' && opener !== '[') continue;
      const closer = opener === '(' ? ')' : ']'; let depth = 1, end = at + 2;
      for (; end < text.length && depth; end++) { if (escaped(text,end)) continue; if (text[end] === opener) depth++; if (text[end] === closer) depth--; }
      if (!depth) { links.push({ from, to: end }); at = end - 1; }
    }
  }
  return links;
}
let cachedText: string | undefined, cached: CitationSpan[] = [];
export function scanCitations(text: string): CitationSpan[] {
  if (text === cachedText) return cached;
  const source = markdownSource(text), excluded: { from: number; to: number }[] = [];
  featureParser.parse(source).iterate({ enter(node) {
    if (['FencedCode','CodeBlock','InlineCode','HTMLBlock','HTMLTag','NotationMathInline','NotationMathBlock','Image','LinkReference'].includes(node.name)) { excluded.push({ from: node.from, to: node.to }); return false; }
    if (node.name === 'Link') {
      const citation = citationAt(source, node.from);
      if (!citation || citation.to !== node.to || node.node.getChild('URL')) { excluded.push({ from: node.from, to: node.to }); return false; }
    }
  } });
  excluded.push(...explicitLinks(source,excluded));
  const spans: CitationSpan[] = [];
  for (let from = source.indexOf('['); from >= 0; from = source.indexOf('[', from + 1)) {
    if (excluded.some((range) => from >= range.from && from < range.to)) continue;
    const span = citationAt(source, from); if (span) { spans.push(span); from = span.to - 1; }
  }
  cachedText = text; return cached = spans;
}
export function orderedCitationGroups(source: string, actual?: string[]) {
  const accepted = actual ? new Set(actual) : null, groups = [...new Set(scanCitations(source).map((span) => span.raw).filter((raw) => !accepted || accepted.has(raw)))];
  for (const raw of actual ?? []) if (!groups.includes(raw)) groups.push(raw);
  return groups;
}
