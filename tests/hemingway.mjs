import assert from 'node:assert/strict';
import { EditorState, Compartment } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';
import { hemingwayAllows, hemingwayProtection, compositionBoundary, hemingwayComposition, hemingwayCommandBlocked } from '../src/hemingway.ts';
import { createTab, serializeTab, restoreTabs } from '../src/documents.ts';
let passed = 0;
function test(name, run) { run(); passed++; console.log('✓ ' + name); }
const locked = (doc = 'Existing', selection) => EditorState.create({ doc, selection, extensions: hemingwayProtection });
const change = (state, changes, userEvent = 'input.type') => state.update({ changes, userEvent }).state;
test('insertion and selection navigation work while deletions and replacements are rejected atomically', () => {
  let state = locked();
  state = change(state, { from: 3, insert: ' NEW ' });
  assert.equal(state.doc.toString(), 'Exi NEW sting');
  const source = state.doc.toString();
  for (const changes of [{ from: 0, to: 1 }, { from: 0, to: 3, insert: 'Other' }, [{ from: 0, insert: 'Prefix' }, { from: 3, to: 4 }]]) {
    state = change(state, changes); assert.equal(state.doc.toString(), source);
  }
  state = state.update({ selection: { anchor: 2, head: 6 } }).state;
  assert.equal(state.selection.main.from, 2); assert.equal(state.selection.main.to, 6);
});
test('undo and redo events cannot mutate even when their operation would only insert', () => {
  for (const userEvent of ['undo', 'redo']) assert.equal(change(locked(), { from: 0, insert: 'Old' }, userEvent).doc.toString(), 'Existing');
});
test('IME revises only newly inserted preedit, including final composition flush', () => {
  let state = locked('AB', { anchor: 1 });
  state = state.update({ effects: compositionBoundary.of('start') }).state;
  state = change(state, { from: 1, insert: 'ni' }, 'input.type.compose.start');
  assert.deepEqual(state.field(hemingwayComposition), { active: true, valid: true, from: 1, to: 3 });
  state = change(state, { from: 1, to: 3, insert: '你' }, 'input.type.compose');
  assert.equal(state.doc.toString(), 'A你B');
  state = change(state, { from: 0, to: 2, insert: 'lost' }, 'input.type.compose');
  assert.equal(state.doc.toString(), 'A你B');
  state = state.update({ effects: compositionBoundary.of('end') }).state;
  assert.equal(change(state, { from: 1, to: 2, insert: 'changed' }, 'input.type.compose').doc.toString(), 'A你B');
});
test('IME begun over an existing selection cannot replace original source', () => {
  let state = locked('Original', { anchor: 0, head: 4 });
  state = state.update({ effects: compositionBoundary.of('start') }).state;
  assert.equal(state.field(hemingwayComposition).valid, false);
  assert.equal(change(state, { from: 0, to: 4, insert: 'New' }, 'input.type.compose').doc.toString(), 'Original');
});
test('turning protection off preserves undo history and exposes normal editing again', () => {
  const protection = new Compartment();
  let state = EditorState.create({ doc: 'A', extensions: [history(), protection.of([])] });
  state = change(state, { from: 1, insert: 'B' });
  state = state.update({ effects: protection.reconfigure(hemingwayProtection) }).state;
  let protectedMode = true;
  // Mirrors Editor's final dispatch guard: CM history uses filter:false.
  const target = { get state() { return state; }, dispatch(transaction) { if (!protectedMode || hemingwayAllows(transaction)) state = transaction.state; } };
  undo(target); assert.equal(state.doc.toString(), 'AB');
  state = state.update({ effects: protection.reconfigure([]) }).state;
  protectedMode = false;
  state = change(state, { from: 2, insert: 'C' });
  assert.equal(undo(target), true); assert.equal(state.doc.toString(), 'A');
  assert.equal(redo(target), true); assert.equal(state.doc.toString(), 'ABC');
});
test('per-tab mode round trips and old drafts default to normal editing', () => {
  const tab = createTab({ name: 'Note.md', content: 'Literal', hemingway: true });
  const recovered = restoreTabs({ activeTabId: tab.id, tabs: [serializeTab(tab)], updatedAt: Date.now() }, null, '');
  assert.equal(recovered.tabs[0].hemingway, true);
  assert.equal(createTab({ name: 'Legacy.md', content: 'Old' }).hemingway, false);
});
test('destructive commands are disabled while navigation, find and saving remain accessible', () => {
  for (const id of ['edit.undo', 'edit.redo', 'edit.replace', 'block.delete', 'insert.math', 'fold.all', 'panel.properties', 'view.live']) assert.equal(hemingwayCommandBlocked(id), true);
  for (const id of ['app.commands', 'view.hemingway', 'edit.find', 'file.save', 'file.open', 'panel.scripts']) assert.equal(hemingwayCommandBlocked(id), false);
});
console.log(passed + ' Hemingway scenarios passed.');
