import { featureParser, markdownSource } from './markdown-features';
import { scanBlockReferences } from './block-references';
import { scanFrontmatter } from './frontmatter';
import { wikiCompletionContext } from './wiki-syntax';
export { parseWikiLink, scanWikiLinks } from './wiki-syntax';
export type { WikiLinkSpan, WikiCompletion } from './wiki-syntax';

const excluded = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag', 'Link', 'NotationMathInline', 'NotationMathBlock', 'NotationFrontmatter']);

export function wikiCompletionAt(text: string, position: number) {
  const context = wikiCompletionContext(text, position);
  if (!context) return null;
  const frontmatter = scanFrontmatter(text);
  if (frontmatter?.closed && position < frontmatter.bodyStart) return null;
  const wikiStart = text.lastIndexOf('[[', position), wikiEnd = text.indexOf(']]', position);
  let node = featureParser.parse(markdownSource(text)).resolveInner(Math.max(0, position - 1), -1);
  for (;;) {
    // Lezer's shortcut-reference node is inside a complete [[wiki target]].
    // It must not suppress completion when editing that existing target.
    const innerWikiLink = node.name === 'Link' && wikiStart >= 0 && wikiEnd >= position && node.from > wikiStart && node.to < wikiEnd + 2;
    if (excluded.has(node.name) && !innerWikiLink) return null;
    if (!node.parent) return context;
    node = node.parent;
  }
}

function headingText(raw: string) {
  return raw.replace(/[ \t]+\^[A-Za-z0-9][A-Za-z0-9-]*[ \t]*$/u, '').replace(/^ {0,3}#{1,6}[ \t]+/u, '').replace(/[ \t]+#+[ \t]*$/u, '')
    .replace(/\r?\n[ \t]*(?:=+|-+)[ \t]*$/u, '').replace(/!?(?:\[([^\]]+)\])\([^)]*\)/gu, '$1')
    .replace(/[*_`]/gu, '').replace(/\\([\p{P}\p{S}])/gu, '$1').trim();
}
function canonical(value: string) {
  try { value = decodeURIComponent(value); } catch { /* Keep literal malformed escapes. */ }
  return value.normalize('NFC').trim().toLocaleLowerCase();
}

export function scanWikiHeadings(text: string): { text: string; line: number; level: number }[] {
  const headings: { text: string; line: number; level: number }[] = [];
  featureParser.parse(markdownSource(text)).iterate({ enter(node) {
    if (excluded.has(node.name)) return false;
    if (!/^(?:ATXHeading[1-6]|SetextHeading[12])$/u.test(node.name)) return;
    headings.push({ text: headingText(text.slice(node.from, node.to)), line: text.slice(0, node.from).split('\n').length, level: Number(node.name.slice(-1)) });
  } });
  return headings;
}

export function findWikiHeadingLine(text: string, heading: string): number | null {
  if (heading.startsWith('^')) { const blocks = scanBlockReferences(text).filter(block => block.id === heading.slice(1)); return blocks.length === 1 ? blocks[0].line : null; }
  const wanted = canonical(heading);
  for (const candidate of scanWikiHeadings(text)) {
    const label = canonical(candidate.text);
    const slug = label.replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/gu, '-');
    if (label === wanted || slug === wanted) return candidate.line;
  }
  return null;
}
