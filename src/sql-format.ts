// SQL blocks: the fence syntax, result cells, and text exports. No DOM, no
// backend and no imports here, so the Node feature tests can load it.

export type SqlKindName = 'sqlite' | 'postgres' | 'mysql';
/**
 * One result value. Plain JSON where JSON can carry it; otherwise a tagged
 * text: `number` (too big or exact for a double), `date`, `time`,
 * `datetime`, `json`, `bytes` (`v` is a hex preview, `n` the length),
 * `text` (cut to the cell limit, `n` the full length), `other`.
 */
export type SqlCell = null | boolean | number | string | { t: string; v: string; n?: number };
export type SqlColumn = { name: string; typeName: string };
export type SqlResult = {
  connection: string; kind: SqlKindName; columns: SqlColumn[]; rows: SqlCell[][]; rowCount: number; rowLimit: number;
  truncated: 'rows' | 'size' | null; durationMs: number; finishedAt: number;
};
export type SqlBlock = { connection: string; sql: string; from: number; to: number; /** Not inside a list, quote or callout. */ top: boolean };

const INFO = /^sql\s+connection:([A-Za-z][A-Za-z0-9_-]{0,63})$/iu;
/** The connection a fence's info string names, or null for any other fence (plain ```sql included). */
export function sqlConnection(info: string | null | undefined): string | null {
  return INFO.exec((info ?? '').trim())?.[1] ?? null;
}

export type SqlCellKind = 'null' | 'number' | 'boolean' | 'text' | 'date' | 'json' | 'bytes' | 'other';
export function cellKind(cell: SqlCell): SqlCellKind {
  if (cell === null) return 'null';
  if (typeof cell === 'number') return 'number';
  if (typeof cell === 'boolean') return 'boolean';
  if (typeof cell === 'string') return 'text';
  if (cell.t === 'number') return 'number';
  if (cell.t === 'date' || cell.t === 'time' || cell.t === 'datetime') return 'date';
  if (cell.t === 'json') return 'json';
  if (cell.t === 'bytes') return 'bytes';
  return cell.t === 'text' ? 'text' : 'other';
}
/** Whether the cell holds less than the database value (a cut text, a bytes preview). */
export function cellCut(cell: SqlCell): boolean {
  return !!cell && typeof cell === 'object' && (cell.t === 'text' || (cell.t === 'bytes' && (cell.n ?? 0) * 2 > cell.v.length));
}
/** The text shown for a cell. Always text: callers set it with textContent. A cut value says how long the full one is. */
export function cellText(cell: SqlCell): string {
  if (cell === null) return 'NULL';
  if (typeof cell !== 'object') return String(cell);
  const size = cell.n === undefined ? '' : ` (${cell.n.toLocaleString('en-US')} bytes)`;
  if (cell.t === 'bytes') return cellCut(cell) ? `0x${cell.v}…${size}` : `0x${cell.v}`;
  return cell.t === 'text' ? `${cell.v}…${size}` : cell.v;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** Ascending order; NULL sorts last. */
export function compareCells(left: SqlCell, right: SqlCell): number {
  if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
  if (cellKind(left) === 'number' && cellKind(right) === 'number') {
    const a = Number(typeof left === 'object' ? left.v : left), b = Number(typeof right === 'object' ? right.v : right);
    if (!Number.isNaN(a) && !Number.isNaN(b) && a !== b) return a < b ? -1 : 1;
    if (a === b && typeof left === 'object' && typeof right === 'object' && /^-?\d+$/u.test(left.v) && /^-?\d+$/u.test(right.v)) { const x = BigInt(left.v), y = BigInt(right.v); return x < y ? -1 : x > y ? 1 : 0; }
    if (!Number.isNaN(a) && !Number.isNaN(b)) return 0;
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  return collator.compare(cellText(left), cellText(right));
}
/** Row indexes in display order; the sort is stable and never reorders `rows` itself. */
export function sortedRows(result: SqlResult, sort: { column: number; descending: boolean } | null): number[] {
  const order = result.rows.map((_, index) => index);
  if (!sort) return order;
  return order.sort((a, b) => {
    const left = result.rows[a][sort.column], right = result.rows[b][sort.column];
    if (left === null || right === null) return compareCells(left, right) || a - b;
    return (sort.descending ? -1 : 1) * compareCells(left, right) || a - b;
  });
}

/** Frontmatter values for the `:name` placeholders a query mentions. Only scalars are passed on; the backend binds them and reports anything missing. */
export function sqlParameters(sql: string, variables: Record<string, unknown>): Record<string, null | boolean | number | string | unknown[]> {
  const parameters: Record<string, null | boolean | number | string | unknown[]> = {};
  for (const match of sql.matchAll(/(?<!:):([A-Za-z_][A-Za-z0-9_]*)/gu)) {
    const name = match[1];
    if (!Object.hasOwn(variables, name) || Object.hasOwn(parameters, name)) continue;
    const value = variables[name];
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) parameters[name] = value;
    // A date property reads as a Date; a list or map is passed so the backend can say why it cannot be bound.
    else if (value instanceof Date) parameters[name] = value.toISOString().replace(/T00:00:00\.000Z$/u, '');
    else parameters[name] = [];
  }
  return parameters;
}

function csvValue(cell: SqlCell): string {
  if (cell === null) return '';
  let text = typeof cell === 'object' && cell.t === 'text' ? cell.v : cellText(cell);
  // A spreadsheet treats a leading = + - @ as a formula. Text from a
  // database is data: mark it as text. Numbers are left as numbers.
  if (cellKind(cell) !== 'number' && /^[=+\-@\t\r]/u.test(text)) text = "'" + text;
  return /[",\r\n]/u.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}
/** RFC 4180 CSV with a header row. NULL is an empty field. */
export function toCsv(result: SqlResult): string {
  const header = result.columns.map((column) => csvValue(column.name)).join(',');
  return [header, ...result.rows.map((row) => row.map(csvValue).join(','))].join('\r\n') + '\r\n';
}

export const MARKDOWN_TABLE_ROWS = 500;
/** Markdown cannot start markup, a link, an image, HTML, math or a property reference from a database value. */
function markdownValue(text: string): string {
  return text.replace(/\r\n?|\n/gu, ' ').replace(/[\\`*_[\]<>$~&{}#!|@^=]/gu, '\\$&').trim() || ' ';
}
/** A GitHub-style table of the result; numeric columns are right-aligned. */
export function toMarkdownTable(result: SqlResult): string {
  const rows = result.rows.slice(0, MARKDOWN_TABLE_ROWS);
  const numeric = result.columns.map((_, index) => rows.some((row) => row[index] !== null) && rows.every((row) => row[index] === null || cellKind(row[index]) === 'number'));
  const line = (cells: string[]) => '| ' + cells.join(' | ') + ' |';
  const lines = [
    line(result.columns.map((column) => markdownValue(column.name))),
    line(numeric.map((right) => right ? '---:' : '---')),
    ...rows.map((row) => line(row.map((cell) => cell === null ? ' ' : markdownValue(cellText(cell))))),
  ];
  if (result.rows.length > rows.length) lines.push('', `_First ${rows.length} of ${result.rows.length} rows._`);
  return lines.join('\n');
}

export function formatDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
}
export function formatRows(count: number): string { return `${count.toLocaleString('en-US')} row${count === 1 ? '' : 's'}`; }
/** Why a result is shorter than the query's, or '' when it is complete. */
export function truncationNotice(result: SqlResult): string {
  if (result.truncated === 'rows') return `Showing the first ${formatRows(result.rowCount)}: the connection's row limit. The query returned more.`;
  if (result.truncated === 'size') return `Showing the first ${formatRows(result.rowCount)}: the result reached the 8 MiB size limit.`;
  return '';
}
