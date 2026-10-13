export type WikiLinkSpan = {
  from: number; to: number; raw: string; target: string; label: string;
  note: string; heading: string | null; alias: string | null;
};
export type WikiCompletion = { from: number; to: number; query: string; target: string; kind: 'note' | 'heading'; note: string };
export type SourceRange = { from: number; to: number };

function escaped(text: string, at: number) {
  let count = 0;
  while (at > 0 && text[--at] === '\\') count++;
  return count % 2 === 1;
}

export function parseWikiLink(raw: string, from = 0): WikiLinkSpan | null {
  if (!raw.startsWith('[[') || !raw.endsWith(']]') || /[\r\n]/u.test(raw) || raw.length > 2048) return null;
  const target = raw.slice(2, -2).trim();
  if (!target || /[\[\]]/u.test(target)) return null;
  const pipe = target.indexOf('|');
  const destination = (pipe < 0 ? target : target.slice(0, pipe)).trim();
  const alias = pipe < 0 ? null : target.slice(pipe + 1).trim() || null;
  const hash = destination.indexOf('#');
  const note = (hash < 0 ? destination : destination.slice(0, hash)).trim();
  const heading = hash < 0 ? null : destination.slice(hash + 1).trim() || null;
  if (!note && !heading) return null;
  return { from, to: from + raw.length, raw, target, label: alias || destination, note, heading, alias };
}

export function scanWikiLinks(text: string, excluded: SourceRange[] = []): WikiLinkSpan[] {
  const links: WikiLinkSpan[] = [];
  let at = 0;
  while ((at = text.indexOf('[[', at)) >= 0) {
    const from = at; at += 2;
    if (escaped(text, from)) continue;
    const end = text.indexOf(']]', at);
    if (end < 0) break;
    const link = parseWikiLink(text.slice(from, end + 2), from);
    if (!link || excluded.some((range) => link.from < range.to && link.to > range.from)) continue;
    links.push(link); at = end + 2;
  }
  return links;
}

export function wikiCompletionContext(text: string, position: number): WikiCompletion | null {
  if (position < 0 || position > text.length) return null;
  const lineStart = text.lastIndexOf('\n', position - 1) + 1;
  const prefix = text.slice(lineStart, position);
  const open = prefix.lastIndexOf('[[');
  if (open < 0 || escaped(text, lineStart + open)) return null;
  const contentStart = lineStart + open + 2;
  const target = text.slice(contentStart, position);
  if (/[\]\[|\r\n]/u.test(target) || target.length > 2048) return null;
  const hash = target.indexOf('#');
  const kind = hash < 0 ? 'note' : 'heading';
  const from = kind === 'note' ? contentStart : contentStart + hash + 1;
  const note = (hash < 0 ? target : target.slice(0, hash)).trim();
  let to = position;
  while (to < text.length && !/[#|\]\r\n]/u.test(text[to])) to++;
  return { from, to, query: text.slice(from, position), target, kind, note };
}
