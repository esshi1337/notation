import { featureParser, markdownSource } from './markdown-features';
import { scanFrontmatter } from './frontmatter';

export type BlockReference = { id: string; from: number; to: number; markerFrom: number; markerTo: number; line: number };
export type ReferenceContent = { text: string; from: number; to: number; line: number };

export function scanBlockReferences(text: string, allowFrontmatter = true): BlockReference[] {
  const source = markdownSource(text, allowFrontmatter), tree = featureParser.parse(source);
  const result: BlockReference[] = [];
  const excluded: { from: number; to: number }[] = [];
  const blocks: { from: number; to: number; name: string }[] = [];
  tree.iterate({ enter(node) {
    if (['FencedCode', 'CodeBlock', 'HTMLBlock', 'NotationMathBlock'].includes(node.name)) {
      excluded.push({ from: node.from, to: node.to }); blocks.push({ from: node.from, to: node.to, name: node.name }); return false;
    }
    if (['InlineCode', 'HTMLTag', 'NotationMathInline'].includes(node.name)) { excluded.push({ from: node.from, to: node.to }); return false; }
    if (node.name === 'Paragraph' || /Heading/u.test(node.name) || ['ListItem', 'Blockquote'].includes(node.name)) blocks.push({ from: node.from, to: node.to, name: node.name });
  } });
  for (const match of source.matchAll(/(?:^|[ \t])\^([A-Za-z0-9][A-Za-z0-9-]*)[ \t]*(?=\r?$)/gmu)) {
    const markerFrom = match.index + match[0].indexOf('^'), markerTo = markerFrom + match[1].length + 1;
    if (excluded.some(range => markerFrom >= range.from && markerFrom < range.to)) continue;
    const lineStart = text.lastIndexOf('\n', markerFrom - 1) + 1;
    const ownLine = !text.slice(lineStart, markerFrom).trim();
    let candidates = blocks.filter(block => block.from <= markerFrom && block.to >= markerTo && !(ownLine && block.from === markerFrom));
    if (ownLine && !candidates.length) {
      candidates = blocks.filter(block => block.to <= lineStart && !text.slice(block.to, lineStart).trim()).sort((a, b) => b.to - a.to || a.from - b.from);
    } else candidates.sort((a, b) => (a.to - a.from) - (b.to - b.from));
    const block = candidates[0];
    if (!block) continue;
    result.push({ id: match[1], from: block.from, to: Math.max(block.to, markerTo), markerFrom, markerTo, line: text.slice(0, block.from).split('\n').length });
  }
  return result;
}

export function referenceContent(text: string, heading: string | null): ReferenceContent {
  if (!heading) { const frontmatter = scanFrontmatter(text); const start = frontmatter?.closed ? frontmatter.bodyStart : 0; return { text: text.slice(start), from: start, to: text.length, line: text.slice(0, start).split('\n').length }; }
  if (heading.startsWith('^')) {
    const matches = scanBlockReferences(text).filter(block => block.id === heading.slice(1));
    if (matches.length !== 1) throw new Error(matches.length ? 'This block ID is duplicated. Give each block a unique ID.' : 'Block not found: ' + heading);
    const block = matches[0];
    return { text: text.slice(block.from, block.markerFrom) + text.slice(block.markerTo, block.to), from: block.from, to: block.to, line: block.line };
  }
  let wanted = heading; try { wanted = decodeURIComponent(wanted); } catch { /* literal */ }
  const normalize = (value: string) => value.normalize('NFC').trim().toLocaleLowerCase();
  wanted = normalize(wanted);
  const headings: { from: number; to: number; level: number; label: string }[] = [];
  featureParser.parse(markdownSource(text)).iterate({ enter(node) {
    if (['FencedCode', 'CodeBlock', 'HTMLBlock', 'NotationMathBlock'].includes(node.name)) return false;
    if (!/^(?:ATXHeading[1-6]|SetextHeading[12])$/u.test(node.name)) return;
    const label = normalize(text.slice(node.from, node.to).replace(/^ {0,3}#{1,6}[ \t]+/u, '').replace(/[ \t]+#+[ \t]*$/u, '').replace(/\r?\n[ \t]*(?:=+|-+)[ \t]*$/u, '').replace(/[ \t]+\^[A-Za-z0-9][A-Za-z0-9-]*[ \t]*$/u, '').replace(/[*_`]/gu, ''));
    headings.push({ from: node.from, to: node.to, level: Number(node.name.slice(-1)), label });
  } });
  const index = headings.findIndex(item => item.label === wanted || item.label.replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/gu, '-') === wanted);
  if (index < 0) throw new Error('Heading not found: ' + heading);
  const start = headings[index], end = headings.slice(index + 1).find(item => item.level <= start.level)?.from ?? text.length;
  return { text: text.slice(start.from, end), from: start.from, to: end, line: text.slice(0, start.from).split('\n').length };
}
