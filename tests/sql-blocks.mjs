import assert from 'node:assert/strict';
import { sqlConnection, cellKind, cellText, cellCut, compareCells, sortedRows, sqlParameters, toCsv, toMarkdownTable, truncationNotice, formatDuration, MARKDOWN_TABLE_ROWS } from '../src/sql-format.ts';
let passed = 0;
function test(name, run) { run(); passed++; console.log('✓ ' + name); }
const result = (columns, rows, extra = {}) => ({ connection: 'analytics', kind: 'postgres', columns: columns.map(name => ({ name, typeName: '' })), rows, rowCount: rows.length, rowLimit: 1000, truncated: null, durationMs: 12, finishedAt: 0, ...extra });

test('only a sql fence that names a connection is a SQL block', () => {
  assert.equal(sqlConnection('sql connection:analytics'), 'analytics');
  assert.equal(sqlConnection('  SQL   connection:Warehouse_2  '), 'Warehouse_2');
  for (const info of ['sql', 'sql connection:', 'sql connection:1st', 'sql connection:a b', 'sql connection:a;drop', 'sql connection:a host=evil', 'sql password:x connection:a', 'postgres connection:a', '', undefined, 'sql connection:' + 'a'.repeat(65)]) assert.equal(sqlConnection(info), null, String(info));
});

test('cells keep their kind and are shown as text', () => {
  assert.deepEqual([null, 1, true, 'x', { t: 'number', v: '9007199254740993' }, { t: 'date', v: '2026-11-21' }, { t: 'json', v: '{}' }, { t: 'bytes', v: '00ff', n: 2 }, { t: 'text', v: 'abc', n: 9000 }, { t: 'other', v: '1 day' }].map(cellKind),
    ['null', 'number', 'boolean', 'text', 'number', 'date', 'json', 'bytes', 'text', 'other']);
  assert.equal(cellText(null), 'NULL');
  assert.equal(cellText(false), 'false');
  assert.equal(cellText({ t: 'bytes', v: '00ff', n: 2 }), '0x00ff');
  assert.equal(cellText({ t: 'bytes', v: '00ff', n: 300 }), '0x00ff… (300 bytes)');
  assert.equal(cellText({ t: 'text', v: 'abc', n: 9000 }), 'abc… (9,000 bytes)');
  assert.equal(cellText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  assert.equal(cellCut({ t: 'bytes', v: '00ff', n: 2 }), false);
  assert.equal(cellCut({ t: 'text', v: 'abc', n: 9000 }), true);
});

test('sorting is numeric for numbers, stable, and keeps NULL last in both directions', () => {
  const data = result(['n', 'name'], [[10, 'b'], [null, 'a'], [9, 'c'], [{ t: 'number', v: '9007199254740993' }, 'd'], [{ t: 'number', v: '9007199254740992' }, 'e'], [10, 'a']]);
  assert.deepEqual(sortedRows(data, null), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(sortedRows(data, { column: 0, descending: false }), [2, 0, 5, 4, 3, 1]);
  assert.deepEqual(sortedRows(data, { column: 0, descending: true }), [3, 4, 0, 5, 2, 1]);
  assert.deepEqual(sortedRows(data, { column: 1, descending: false }), [1, 5, 0, 2, 3, 4]);
  assert.deepEqual(data.rows[0], [10, 'b'], 'the result itself is not reordered');
  assert.ok(compareCells('item 2', 'item 10') < 0);
  assert.ok(compareCells({ t: 'number', v: '-0.5' }, 0) < 0);
});

test('parameters come from properties the query mentions, as scalars', () => {
  const variables = { id: 7, name: "x' or 1=1 --", active: true, empty: null, list: [1, 2], unused: 'secret', since: new Date('2026-01-02T00:00:00.000Z') };
  assert.deepEqual(sqlParameters('select :id, :name, :active, :empty, :missing, x::text, :list, :since, :id', variables),
    { id: 7, name: "x' or 1=1 --", active: true, empty: null, list: [], since: '2026-01-02' });
  assert.deepEqual(sqlParameters('select 1', variables), {});
});

test('CSV quotes, keeps NULL empty and neutralises spreadsheet formulas', () => {
  const data = result(['id', 'note, "x"'], [[1, 'plain'], [-2, 'a,b'], [3, 'say "hi"\nnow'], [4, null], [5, '=HYPERLINK("http://evil","x")'], [6, '+1'], [7, '@cmd'], [8, { t: 'number', v: '-12.50' }], [9, { t: 'bytes', v: '00ff', n: 2 }], [10, '-dash']]);
  assert.equal(toCsv(data), [
    'id,"note, ""x"""', '1,plain', '-2,"a,b"', '3,"say ""hi""\nnow"', '4,', `5,"'=HYPERLINK(""http://evil"",""x"")"`, "6,'+1", "7,'@cmd", '8,-12.50', '9,0x00ff', "10,'-dash", '',
  ].join('\r\n'));
});

test('a Markdown table cannot start markup, links, images, HTML or math from a value', () => {
  const data = result(['id', 'na|me'], [[1, '![x](http://evil/p.png)'], [2, '<script>alert(1)</script>'], [3, '[[Note]] and [a](b)'], [4, 'a | b\nc'], [5, '$x$ `code` *em* {{var}}'], [6, null], [7, '']]);
  const table = toMarkdownTable(data);
  assert.equal(table, [
    '| id | na\\|me |', '| ---: | --- |',
    '| 1 | \\!\\[x\\](http://evil/p.png) |', '| 2 | \\<script\\>alert(1)\\</script\\> |', '| 3 | \\[\\[Note\\]\\] and \\[a\\](b) |', '| 4 | a \\| b c |',
    '| 5 | \\$x\\$ \\`code\\` \\*em\\* \\{\\{var\\}\\} |', '| 6 |   |', '| 7 |   |',
  ].join('\n'));
  // Every row has the same number of unescaped column separators.
  for (const line of table.split('\n')) assert.equal(line.replace(/\\./gu, '').split('|').length, 4, line);
  const many = result(['n'], Array.from({ length: MARKDOWN_TABLE_ROWS + 5 }, (_, index) => [index]));
  assert.ok(toMarkdownTable(many).endsWith(`_First ${MARKDOWN_TABLE_ROWS} of ${MARKDOWN_TABLE_ROWS + 5} rows._`));
});

test('notices and durations read plainly', () => {
  assert.equal(truncationNotice(result(['n'], [[1]])), '');
  assert.match(truncationNotice(result(['n'], [[1]], { truncated: 'rows', rowCount: 1000 })), /^Showing the first 1,000 rows: the connection's row limit/u);
  assert.match(truncationNotice(result(['n'], [[1]], { truncated: 'size', rowCount: 1 })), /first 1 row: .*size limit/u);
  assert.equal(formatDuration(38), '38 ms');
  assert.equal(formatDuration(1234), '1.23 s');
  assert.equal(formatDuration(12_345), '12.3 s');
});
console.log(passed + ' SQL block tests passed');
