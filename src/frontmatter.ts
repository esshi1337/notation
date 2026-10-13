import { Document, isMap, isNode, isScalar, isSeq, parseDocument, stringify } from 'yaml';
import type { Node as YamlNode } from 'yaml';

export type Frontmatter = {
  from: 0; to: number; bodyStart: number; raw: string; closed: boolean;
  values: Record<string, unknown>; error?: string;
};
export type PropertyType = 'text' | 'number' | 'boolean' | 'date' | 'list' | 'yaml';
export type PropertyField = { key: string; type: PropertyType; input: string };
export type PropertyMutation = { kind: 'add' | 'set' | 'delete'; key: string; value?: unknown };
const options = { keepSourceTokens: true, prettyErrors: true, strict: true, uniqueKeys: true, logLevel: 'silent' as const };

const MAX_YAML_BYTES = 256 * 1024;
const MAX_YAML_DEPTH = 64;
function checkSize(raw: string) {
  if (new TextEncoder().encode(raw).length > MAX_YAML_BYTES) throw new Error('YAML frontmatter exceeds the 256 KiB limit. Edit the source to reduce it.');
}
function checkDepth(document: Document) {
  const pending: { node: unknown; depth: number }[] = [{ node: document.contents, depth: 0 }];
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (depth > MAX_YAML_DEPTH) throw new Error('YAML nesting exceeds the 64-level limit. Edit the source to simplify it.');
    if (isMap(node)) for (const pair of node.items) { pending.push({ node: pair.key, depth: depth + 1 }, { node: pair.value, depth: depth + 1 }); }
    else if (isSeq(node)) for (const item of node.items) pending.push({ node: item, depth: depth + 1 });
  }
}
function boundedDocument(raw: string) {
  checkSize(raw);
  try { const document = parseDocument(raw, options); checkDepth(document); return document; }
  catch (cause) { if (cause instanceof RangeError) throw new Error('YAML nesting is too deep to parse. Edit the source to simplify it.'); throw cause; }
}
function parseValues(raw: string) {
  try {
    const document = boundedDocument(raw);
    if (document.errors.length) return { values: {}, error: document.errors.map((item) => item.message).join('\n') };
    if (document.contents && !isMap(document.contents)) return { values: {}, error: 'YAML frontmatter must be a mapping of property names to values.' };
    const value = document.toJS({ maxAliasCount: 50 }) as unknown;
    return { values: value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} };
  } catch (error) { return { values: {}, error: error instanceof Error ? error.message : String(error) }; }
}

export function scanFrontmatter(text: string): Omit<Frontmatter, 'values'> | null {
  const firstBreak = text.indexOf('\n');
  const firstEnd = firstBreak < 0 ? text.length : firstBreak;
  if (!/^\uFEFF?---[ \t]*\r?$/u.test(text.slice(0, firstEnd))) return null;
  const start = firstBreak < 0 ? text.length : firstBreak + 1;
  let lineStart = start;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart), end = newline < 0 ? text.length : newline;
    const contentEnd = text[end - 1] === '\r' ? end - 1 : end;
    if (/^(?:---|\.\.\.)[ \t]*$/u.test(text.slice(lineStart, contentEnd))) {
      const raw = text.slice(start, lineStart);
      return { from: 0, to: contentEnd, bodyStart: newline < 0 ? text.length : newline + 1, raw, closed: true };
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return { from: 0, to: text.length, bodyStart: text.length, raw: text.slice(start), closed: false, error: 'Unclosed YAML frontmatter. Add a closing --- or ... line.' };
}

let cachedText: string | undefined, cachedFrontmatter: Frontmatter | null = null;
export function parseFrontmatter(text: string): Frontmatter | null {
  if (text === cachedText) return cachedFrontmatter;
  const scan = scanFrontmatter(text);
  cachedText = text;
  return cachedFrontmatter = scan ? { ...scan, ...(scan.closed ? parseValues(scan.raw) : { values: {} }) } : null;
}

function readDocument(text: string) {
  const scan = parseFrontmatter(text);
  if (scan?.error) throw new Error(scan.error);
  const document = scan ? boundedDocument(scan.raw) : new Document();
  if (document.contents && !isMap(document.contents)) throw new Error('Properties need a YAML mapping. Edit this frontmatter in source.');
  if (!document.contents) document.contents = document.createNode({});
  return { scan, document };
}

export function propertyFields(text: string): PropertyField[] {
  const { document } = readDocument(text);
  const values = document.toJS({ maxAliasCount: 50 }) as Record<string, unknown>;
  if (!isMap(document.contents)) return [];
  return document.contents.items.map((pair) => {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('Complex YAML keys remain editable in source.');
    const key = pair.key.value, value = values[key], node = pair.value;
    const type: PropertyType = typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : typeof value === 'string' ? /^\d{4}-\d{2}-\d{2}$/u.test(value) ? 'date' : 'text' : Array.isArray(value) ? 'list' : 'yaml';
    let input = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : stringify(value, { lineWidth: 0 }).trimEnd();
    if ((type === 'list' || type === 'yaml') && isNode(node)) {
      try { const valueDocument = new Document(); valueDocument.contents = node.clone() as YamlNode; input = valueDocument.toString({ lineWidth: 0 }).trimEnd(); } catch { /* Keep a safe resolved-value editor for external aliases. */ }
    }
    return { key, type, input };
  });
}

export function parsePropertyInput(type: PropertyType, input: string): unknown {
  if (type === 'text') return input;
  if (type === 'number') { const value = Number(input); if (!input.trim() || !Number.isFinite(value)) throw new Error('Enter a finite number.'); return value; }
  if (type === 'boolean') { if (input !== 'true' && input !== 'false') throw new Error('Choose true or false.'); return input === 'true'; }
  if (type === 'date') {
    const date = new Date(input + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(input) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input) throw new Error('Enter a valid date in YYYY-MM-DD format.');
    return input;
  }
  const document = boundedDocument(input);
  if (document.errors.length) throw new Error(document.errors[0].message);
  if (type === 'list' && !isSeq(document.contents)) throw new Error('Enter a YAML list, such as [work, personal] or one - item per line.');
  document.toJS({ maxAliasCount: 50 });
  return document.contents;
}

export function updateFrontmatter(text: string, mutation: PropertyMutation): string {
  const key = mutation.key.trim();
  if (!key) throw new Error('Enter a property name.');
  const { scan, document } = readDocument(text);
  if (mutation.kind === 'add' && document.has(key)) throw new Error('A property named ' + key + ' already exists.');
  if (mutation.kind === 'delete') document.delete(key);
  else {
    const previous = document.get(key, true);
    if (isScalar(previous) && !isNode(mutation.value) && (mutation.value === null || typeof mutation.value !== 'object')) previous.value = mutation.value;
    else {
      const next = isNode(mutation.value) ? mutation.value.clone() : document.createNode(mutation.value);
      if (isNode(previous) && isNode(next)) {
        next.comment = previous.comment; next.commentBefore = previous.commentBefore; next.spaceBefore = previous.spaceBefore;
        if ('anchor' in previous && 'anchor' in next) next.anchor = previous.anchor;
      }
      document.set(key, next);
    }
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  checkDepth(document);
  const yaml = document.toString({ lineWidth: 0 }).replace(/\r?\n/gu, eol);
  checkSize(yaml);
  if (!scan) {
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    return bom + '---' + eol + yaml + '---' + eol + text.slice(bom.length);
  }
  const openingEnd = text.indexOf('\n') + 1;
  const closingStart = text.lastIndexOf('\n', scan.to - 1) + 1;
  return text.slice(0, openingEnd) + yaml + text.slice(closingStart, scan.bodyStart) + text.slice(scan.bodyStart);
}
