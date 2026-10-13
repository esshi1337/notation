import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server = await createServer({ cacheDir: 'node_modules/.vite-tables-folding', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, logLevel: 'error' });
let passed = 0;
function test(name, run) { run(); passed++; console.log('✓ ' + name); }
try {
  const { markdownTables, splitTableRow, serializeTable, replaceTable, parseCSV, exportCSV, tableFromCSV, sortTableRows } = await server.ssrLoadModule('/src/tables.ts');
  const { markdownFolds, markdownFolding, performFold } = await server.ssrLoadModule('/src/folding.ts');
  const { EditorState, Compartment } = await import('@codemirror/state');
  const { foldedRanges } = await import('@codemirror/language');
  test('table row scanner preserves escaped pipes and matching code spans', () => {
    assert.deepEqual(splitTableRow('| a\\|b | `c|d` | ``e`|f`` |'), ['a\\|b', '`c|d`', '``e`|f``']);
    assert.deepEqual(splitTableRow('A | B'), ['A', 'B']);
    assert.deepEqual(splitTableRow('| one | `unmatched | last |'), ['one', '`unmatched', 'last']);
  });
  test('table parsing skips code, metadata and math and maps exact CRLF source spans', () => {
    const text = '---\r\nproperty: |\r\n  | fake | table |\r\n  | --- | --- |\r\n---\r\n```md\r\n| no | table |\r\n| --- | --- |\r\n```\r\n$$\r\n| no | math |\r\n| --- | --- |\r\n$$\r\n\r\n| A | B |\r\n| :--- | ---: |\r\n| x\\|y | `a|b` |\r\n\r\nAfter.\r\n';
    const tables = markdownTables(text); assert.equal(tables.length, 1);
    assert.deepEqual(tables[0].alignments, ['left', 'right']);
    assert.equal(tables[0].rows[1][0].value, 'x|y'); assert.equal(tables[0].rows[1][1].value, '`a|b`');
    const updated = replaceTable(text, { ...tables[0], rows: tables[0].rows.map((row) => row.map((cell) => ({ ...cell, value: cell.value === 'A' ? 'Changed' : cell.value }))) });
    assert.equal(updated.slice(0, tables[0].from), text.slice(0, tables[0].from));
    assert.ok(updated.endsWith('\r\n\r\nAfter.\r\n')); assert.ok(updated.includes('`a\\|b`'));
  });
  test('ragged extra columns and container tables fail visibly without truncating', () => {
    const ragged = markdownTables('| A | B |\n| --- | --- |\n| one | two | extra |')[0];
    assert.ok(ragged.error); assert.equal(ragged.rows[1][2].value, 'extra');
    assert.throws(() => replaceTable('original', ragged));
    const nested = markdownTables('- Item\n\n  | A | B |\n  | --- | --- |\n  | x | y |')[0];
    assert.ok(nested.error);
  });
  test('CSV supports commas, quotes, empty fields, BOM and multiline records', () => {
    const rows = parseCSV('\uFEFFName,Text,Empty\r\n"A, B","first\nsecond",\r\n"He said ""hi""",last,\r\n');
    assert.deepEqual(rows, [['Name','Text','Empty'],['A, B','first\nsecond',''],['He said "hi"','last','']]);
    const model = tableFromCSV('A,B\r\n"<br> & <tag>","one\r\ntwo"\r\n');
    const reparsed = markdownTables(serializeTable(model))[0];
    assert.deepEqual(reparsed.rows.map((row) => row.map((cell) => cell.value)), [['A','B'],['<br> & <tag>','one\ntwo']]);
    assert.deepEqual(parseCSV(exportCSV(reparsed.rows)), [['A','B'],['<br> & <tag>','one\ntwo']]);
  });
  test('malformed CSV and oversized grids reject rather than discarding data', () => {
    assert.throws(() => parseCSV('A\n"not closed'), /not closed/u);
    assert.throws(() => parseCSV('A\n"closed"suffix'), /Malformed/u);
    assert.throws(() => parseCSV('A\n' + 'row\n'.repeat(1001)), /1,000/u);
  });
  test('sorts are stable and numeric, leave headers fixed and preserve cell source', () => {
    const table = tableFromCSV('Name,Number\nfirst,10\nsecond,2\nthird,2');
    const rows = sortTableRows(table, 1, 'ascending');
    assert.deepEqual(rows.map((row) => row[0].value), ['Name','second','third','first']);
    assert.equal(rows[1][0].raw, table.rows[2][0].raw);
    assert.deepEqual(table.rows.map((row) => row[0].value), ['Name','first','second','third']);
  });
  test('fold ranges cover heading sections, fences, quotes and nested list items without source edits', () => {
    const text = '# Parent\nBody\n\n## Child\nNested body\n\n# Next\n```js\nconst x = 1;\n```\n\n> quote\n> body\n\n- First\n  - Nested\n    detail\n- Second\n';
    const folds = markdownFolds(text);
    assert.equal(folds.find((range) => range.kind === 'heading' && range.header === 0).to, text.indexOf('# Next') - 2);
    for (const kind of ['FencedCode','Blockquote','ListItem']) assert.ok(folds.some((range) => range.kind === kind));
    assert.ok(folds.some((range) => range.kind === 'ListItem' && text.slice(range.header, range.from).includes('Nested')));
    assert.equal(markdownFolds('---\ntitle: fake\n---\n# Real\nbody').filter((range) => range.kind === 'heading').length, 1);
  });
  test('fold state survives presentation reconfiguration and folding never changes canonical text', () => {
    const text = '# Heading\nBody\n\n# Another\nOther body';
    const presentation = new Compartment();
    let state = EditorState.create({ doc: text, extensions: [markdownFolding, presentation.of([])] });
    const target = { get state() { return state; }, dispatch(spec) { state = state.update(spec).state; }, lineBlockAt(at) { return state.doc.lineAt(at); } };
    assert.equal(performFold(target, 'Fold block'), true); assert.equal(foldedRanges(state).size, 1);
    state = state.update({ effects: presentation.reconfigure([]) }).state;
    assert.equal(foldedRanges(state).size, 1); assert.equal(state.doc.toString(), text);
    assert.equal(performFold(target, 'Unfold all'), true); assert.equal(foldedRanges(state).size, 0);
    assert.equal(performFold(target, 'Fold all'), true); assert.equal(foldedRanges(state).size, 2); assert.equal(state.doc.toString(), text);
  });
  console.log(passed + ' table and folding scenarios passed.');
} finally { await server.close(); }
