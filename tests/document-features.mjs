import assert from 'node:assert/strict';
import { EditorState, Transaction } from '@codemirror/state';
import { history, isolateHistory, undo } from '@codemirror/commands';
import { parseFrontmatter, scanFrontmatter, updateFrontmatter, parsePropertyInput, propertyFields } from '../src/frontmatter.ts';
import { compareRevisions } from '../src/revision-diff.ts';
import { sourceFormat, sourceText, sourceEolEffect, rawToEditor, editorToRaw } from '../src/source-format.ts';
let passed = 0;
function test(name, run) { run(); passed++; console.log('✓ ' + name); }

test('frontmatter boundaries support BOM, CRLF, both closers and exact body offsets', () => {
  for (const close of ['---', '...']) {
    const text = '\uFEFF---\r\ntitle: Note\r\n' + close + '\r\n\r\n# Body\r\n';
    const scan = scanFrontmatter(text);
    assert.equal(scan.closed, true); assert.equal(scan.from, 0);
    assert.equal(text.slice(scan.bodyStart), '\r\n# Body\r\n');
    assert.deepEqual(parseFrontmatter(text).values, { title: 'Note' });
  }
  assert.equal(scanFrontmatter('Text\n---\nkey: value\n---'), null);
});
test('invalid and unmapped YAML stays an explicit error, including unclosed frontmatter', () => {
  for (const text of ['---\nkey: [broken\n---\nBody', '---\n- sequence\n---\nBody', '---\nscalar\n---\nBody', '---\nkey: value\nBody']) {
    assert.ok(parseFrontmatter(text).error);
    assert.throws(() => updateFrontmatter(text, { kind: 'add', key: 'new', value: true }));
  }
  assert.equal(parseFrontmatter('---\nkey: value\nBody').closed, false);
});
test('oversized and deeply nested YAML becomes a repairable error before conversion', () => {
  const large = '---\nkey: ' + 'x'.repeat(256 * 1024) + '\n---\n# Body';
  assert.match(parseFrontmatter(large).error, /256 KiB/u);
  const nested = '---\nkey: ' + '['.repeat(70) + '0' + ']'.repeat(70) + '\n---\n# Body';
  assert.match(parseFrontmatter(nested).error, /nesting|deep/u);
  assert.throws(() => parsePropertyInput('list', '['.repeat(70) + '0' + ']'.repeat(70)), /nesting|deep/u);
  assert.throws(() => updateFrontmatter('Body', { kind: 'add', key: 'huge', value: 'x'.repeat(256 * 1024) }), /256 KiB/u);
});
test('property edits retain comments, unknown keys, anchors, delimiters and exact CRLF body', () => {
  const text = '\uFEFF---\r\n# Heading comment\r\ntitle: "Old" # beside\r\nunknown: &data {nested: true}\r\nreference: *data\r\n...\r\n\r\n# Body\r\n- [ ] Task\r\n';
  const result = updateFrontmatter(text, { kind: 'set', key: 'title', value: 'New' });
  assert.ok(result.startsWith('\uFEFF---\r\n')); assert.ok(result.includes('\r\n...\r\n'));
  assert.ok(result.includes('# Heading comment')); assert.ok(result.includes('# beside'));
  assert.deepEqual(parseFrontmatter(result).values.unknown, { nested: true });
  assert.deepEqual(parseFrontmatter(result).values.reference, { nested: true });
  assert.equal(result.slice(parseFrontmatter(result).bodyStart), text.slice(parseFrontmatter(text).bodyStart));
});
test('typed properties round trip without automatic fields and reject duplicate keys/invalid input', () => {
  let text = '# Body\n';
  for (const [key, type, input, expected] of [['title','text','0123','0123'],['count','number','42',42],['done','boolean','true',true],['date','date','2026-10-12','2026-10-12'],['tags','list','[one, two]',['one','two']],['extra','yaml','{nested: false}',{nested:false}]]) {
    text = updateFrontmatter(text, { kind: 'add', key, value: parsePropertyInput(type, input) });
    assert.deepEqual(parseFrontmatter(text).values[key], expected);
  }
  assert.equal(Object.keys(parseFrontmatter(text).values).length, 6);
  assert.equal(propertyFields(text).find((field) => field.key === 'tags').type, 'list');
  assert.throws(() => updateFrontmatter(text, { kind: 'add', key: 'count', value: 3 }));
  assert.throws(() => parsePropertyInput('date', '2026-02-30'));
  assert.throws(() => parsePropertyInput('number', 'Infinity'));
  assert.throws(() => parsePropertyInput('list', 'not a list'));
  text = updateFrontmatter(text, { kind: 'delete', key: 'extra' });
  assert.equal('extra' in parseFrontmatter(text).values, false); assert.ok(text.endsWith('# Body\n'));
});
test('raw and editor positions map consistently around CRLF and Unicode', () => {
  const text = 'α\r\n😀\r\nEnd'; const state = EditorState.create({ doc: text, extensions: sourceFormat(text) });
  assert.equal(sourceText(state), text);
  for (const position of [0, 1, 3, 5, 7, text.length]) assert.equal(editorToRaw(state, rawToEditor(text, position)), position);
  assert.equal(sourceText(state, rawToEditor(text, 3), rawToEditor(text, 5)), '😀');
});
test('whole document transactions and undo restore exact source and original EOL style', () => {
  const original = '---\r\ntitle: Old\r\n---\r\nBody\r\n';
  let state = EditorState.create({ doc: original, extensions: [history(), sourceFormat(original)] });
  const edited = updateFrontmatter(original, { kind: 'set', key: 'title', value: 'New' });
  const apply = (text) => state = state.update({ changes: { from: 0, to: state.doc.length, insert: text }, effects: sourceEolEffect(state, text), annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.properties')] }).state;
  apply(edited); assert.equal(sourceText(state), edited);
  apply('Different\nLF\n'); assert.equal(sourceText(state), 'Different\nLF\n');
  const target = { get state() { return state; }, dispatch(transaction) { state = transaction.state; } };
  assert.equal(undo(target), true); assert.equal(sourceText(state), edited);
  assert.equal(undo(target), true); assert.equal(sourceText(state), original);
});
test('unified comparison reports direction, context and unchanged revisions without mutation', () => {
  const before = 'a\nb\n', after = 'a\nc\nd\n';
  const result = compareRevisions(before, after, 'Saved revision', 'Current draft', 0);
  assert.equal(result.added, 2); assert.equal(result.removed, 1);
  assert.ok(result.text.startsWith('--- Saved revision\n+++ Current draft\n'));
  assert.ok(result.text.includes('-b\n+c\n+d\n')); assert.ok(!result.text.includes('\n a\n'));
  assert.equal(compareRevisions(before, before).unchanged, true);
  assert.equal(before, 'a\nb\n'); assert.equal(after, 'a\nc\nd\n');
});
console.log(passed + ' document feature scenarios passed.');
