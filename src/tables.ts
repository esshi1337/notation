import { scanFrontmatter } from './frontmatter';
import { featureParser, markdownSource } from './markdown-features';

export type Alignment = 'default' | 'left' | 'center' | 'right';
export type TableCell = { value: string; raw?: string };
export type MarkdownTable = { from: number; to: number; rows: TableCell[][]; alignments: Alignment[]; eol: string; error?: string };
const MAX_BYTES = 4 * 1024 * 1024, MAX_ROWS = 1000, MAX_COLUMNS = 100, MAX_CELLS = 10000;
function limits(rows: TableCell[][] | string[][]) {
  if (!rows.length || !rows[0]?.length) throw new Error('A table needs at least one header cell.');
  const width = Math.max(...rows.map((row) => row.length));
  if (rows.length > MAX_ROWS || width > MAX_COLUMNS || rows.length * width > MAX_CELLS) throw new Error('Table editor supports up to 1,000 rows, 100 columns, and 10,000 cells. No data was imported or removed.');
}
function entities(text: string) { return text.replace(/&(amp|lt|gt|quot|#39);/gu, (_match, key: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[key]!); }
function decodeCell(raw: string) {
  return entities(raw.trim().replace(/<br\s*\/?[ \t]*>/giu, '\n').replace(/\\([\\|])/gu, '$1'));
}
function escaped(text: string, at: number) { let n = 0; while (at > 0 && text[--at] === '\\') n++; return n % 2 === 1; }
function matchingTicks(text: string, from: number, size: number) {
  for (let at = from; at < text.length;) {
    if (text[at] !== '`') { at++; continue; }
    let end = at; while (text[end] === '`') end++;
    if (end - at === size) return true;
    at = end;
  }
  return false;
}
export function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !escaped(text, text.length - 1)) text = text.slice(0, -1);
  const cells: string[] = []; let value = '', ticks = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '`' && (ticks || !escaped(text, at))) {
      let end = at; while (text[end] === '`') end++;
      const size = end - at;
      if (ticks === size) ticks = 0;
      else if (!ticks && matchingTicks(text, end, size)) ticks = size;
      value += text.slice(at, end); at = end - 1;
    } else if (char === '|' && !ticks && !escaped(text, at)) { cells.push(value.trim()); value = ''; }
    else value += char;
  }
  cells.push(value.trim()); return cells;
}
function delimiter(line: string): Alignment[] | null {
  const cells = splitTableRow(line);
  if (!cells.length || !cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) return null;
  return cells.map((cell) => cell.startsWith(':') ? cell.endsWith(':') ? 'center' : 'left' : cell.endsWith(':') ? 'right' : 'default');
}
export function markdownTables(text: string): MarkdownTable[] {
  const excluded: { from: number; to: number }[] = [], nested: { from: number; to: number }[] = [];
  const frontmatter = scanFrontmatter(text);
  if (frontmatter?.closed) excluded.push({ from: 0, to: frontmatter.bodyStart });
  featureParser.parse(markdownSource(text)).iterate({ enter(node) {
    if (['FencedCode', 'CodeBlock', 'HTMLBlock', 'NotationMathBlock'].includes(node.name)) { excluded.push({ from: node.from, to: node.to }); return false; }
    if (node.name === 'Blockquote' || node.name === 'ListItem') nested.push({ from: node.from, to: node.to });
  } });
  const lines: { text: string; from: number; to: number }[] = [];
  let from = 0;
  for (const line of text.split('\n')) { const raw = line.endsWith('\r') ? line.slice(0, -1) : line; lines.push({ text: raw, from, to: from + raw.length }); from += line.length + 1; }
  const tables: MarkdownTable[] = [], eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (let index = 0; index + 1 < lines.length; index++) {
    const head = lines[index], separators = lines[index + 1];
    if (excluded.some((range) => head.from >= range.from && head.from < range.to)) continue;
    if (!head.text.includes('|') || !/^ {0,3}\S/u.test(head.text)) continue;
    const alignments = delimiter(separators.text);
    if (!alignments) continue;
    const header = splitTableRow(head.text);
    if (header.length !== alignments.length) continue;
    const rows: TableCell[][] = [header.map((raw) => ({ raw, value: decodeCell(raw) }))];
    let end = index + 1, error: string | undefined;
    while (end + 1 < lines.length && lines[end + 1].text.trim() && lines[end + 1].text.includes('|')) {
      const line = lines[end + 1];
      if (excluded.some((range) => line.from >= range.from && line.from < range.to) || /^ {0,3}(?:>|#{1,6}\s|[-*+]\s)/u.test(line.text)) break;
      const raw = splitTableRow(line.text);
      if (raw.length > header.length) error = 'This table has extra cells beyond its header. Edit the source to align the columns before using the table editor.';
      rows.push(raw.map((value) => ({ raw: value, value: decodeCell(value) }))); end++;
    }
    if (nested.some((range) => head.from >= range.from && head.from < range.to)) error = 'Tables inside lists or quotes remain editable in source. Move the table outside its container to use the table editor.';
    try { limits(rows); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    for (const row of rows) while (row.length < header.length) row.push({ value: '' });
    tables.push({ from: head.from, to: lines[end].to, rows, alignments, eol, error }); index = end;
  }
  return tables;
}
function escapePipes(value: string) { return value.replace(/\|/gu, (_pipe, at: number) => escaped(value, at) ? '|' : '\\|'); }
function encodeCell(cell: TableCell) {
  if (cell.raw !== undefined && decodeCell(cell.raw) === cell.value) return escapePipes(cell.raw.trim());
  return escapePipes(cell.value.replace(/&/gu, '&amp;').replace(/\\/gu, '\\\\').replace(/\r\n?/gu, '\n').replace(/<br\s*\/?[ \t]*>/giu, (value) => '&lt;' + value.slice(1, -1) + '&gt;').replace(/\n/gu, '<br>'));
}
export function serializeTable(table: Pick<MarkdownTable, 'rows' | 'alignments' | 'eol'>): string {
  limits(table.rows);
  const width = table.rows[0].length;
  if (table.rows.some((row) => row.length !== width)) throw new Error('All table rows must have the same number of columns.');
  const line = (row: TableCell[]) => '| ' + row.map(encodeCell).join(' | ') + ' |';
  const separators = table.alignments.slice(0, width).map((alignment) => alignment === 'center' ? ':---:' : alignment === 'left' ? ':---' : alignment === 'right' ? '---:' : '---');
  while (separators.length < width) separators.push('---');
  const result = [line(table.rows[0]), '| ' + separators.join(' | ') + ' |', ...table.rows.slice(1).map(line)].join(table.eol);
  if (new TextEncoder().encode(result).length > MAX_BYTES) throw new Error('The table exceeds the 4 MiB document limit.');
  return result;
}
export function replaceTable(text: string, table: MarkdownTable): string {
  if (table.error) throw new Error(table.error);
  return text.slice(0, table.from) + serializeTable(table) + text.slice(table.to);
}
export function sortTableRows(table: MarkdownTable, column: number, direction: 'ascending' | 'descending'): TableCell[][] {
  if (column < 0 || column >= table.rows[0].length) throw new Error('Choose an existing column.');
  const sorted = table.rows.slice(1).map((row, index) => ({ row, index })).sort((a, b) => {
    const order = a.row[column].value.localeCompare(b.row[column].value, undefined, { numeric: true, sensitivity: 'base' });
    return order ? direction === 'ascending' ? order : -order : a.index - b.index;
  });
  return [table.rows[0], ...sorted.map((entry) => entry.row)];
}

export function parseCSV(text: string): string[][] {
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('CSV exceeds the 4 MiB import limit.');
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  const rows: string[][] = []; let row: string[] = [], value = '', quoted = false, closed = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (char === '"') { if (text[at + 1] === '"') { value += '"'; at++; } else { quoted = false; closed = true; } }
      else value += char;
    } else if (char === '"' && !value && !closed) quoted = true;
    else if (char === ',') { row.push(value); if (row.length >= MAX_COLUMNS) throw new Error('CSV contains more than 100 columns. No columns were discarded.'); value = ''; closed = false; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[at + 1] === '\n') at++;
      row.push(value); rows.push(row); row = []; value = ''; closed = false;
      if (rows.length > MAX_ROWS) throw new Error('CSV contains more than 1,000 rows. No rows were discarded.');
    } else {
      if (closed || char === '"') throw new Error('Malformed CSV: unexpected text or quote after a quoted field.');
      value += char;
    }
  }
  if (quoted) throw new Error('Malformed CSV: a quoted field is not closed.');
  if (value || row.length || closed || !rows.length) { row.push(value); rows.push(row); }
  limits(rows); const width = Math.max(...rows.map((line) => line.length));
  for (const line of rows) while (line.length < width) line.push('');
  return rows;
}
export function exportCSV(rows: TableCell[][]): string {
  limits(rows);
  return rows.map((row) => row.map((cell) => /[",\r\n]/u.test(cell.value) ? '"' + cell.value.replace(/"/gu, '""') + '"' : cell.value).join(',')).join('\r\n') + '\r\n';
}
export function tableFromCSV(text: string, eol = '\n'): MarkdownTable {
  const rows = parseCSV(text).map((row) => row.map((value) => {
    const normalized = value.replace(/\r\n?/gu, '\n');
    const raw = normalized.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|').replace(/\n/gu, '<br>');
    return { value: normalized, raw };
  }));
  return { from: 0, to: 0, rows, alignments: rows[0].map(() => 'default'), eol };
}
