import { EditorState, Prec, StateEffect, StateField, Transaction } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';

export const HEMINGWAY_MESSAGE = 'Hemingway mode blocks document replacements. Turn it off through Commands to edit or restore existing text.';
export const compositionBoundary = StateEffect.define<'start' | 'end'>();
type Composition = { active: boolean; valid: boolean; from: number; to: number };
export const hemingwayComposition = StateField.define<Composition>({
  create: () => ({ active: false, valid: false, from: 0, to: 0 }),
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(compositionBoundary)) {
      if (effect.value === 'end') return { ...value, active: false, valid: false };
      const selection = transaction.newSelection.main;
      return { active: true, valid: selection.empty, from: selection.head, to: selection.head };
    }
    if (value.active && transaction.docChanged) return { ...value, from: transaction.changes.mapPos(value.from, -1), to: transaction.changes.mapPos(value.to, 1) };
    return value;
  },
});
export function hemingwayAllows(transaction: Transaction): boolean {
  if (!transaction.docChanged) return true;
  if (transaction.isUserEvent('undo') || transaction.isUserEvent('redo')) return false;
  const composition = transaction.startState.field(hemingwayComposition, false);
  const preedit = composition?.active && composition.valid && transaction.isUserEvent('input.type.compose');
  let allowed = true;
  transaction.changes.iterChangedRanges((from, to) => {
    // IMEs may revise only their newly inserted, still-uncommitted preedit.
    // The range starts empty, so no existing document byte can enter it.
    if (to > from && !(preedit && from >= composition.from && to <= composition.to)) allowed = false;
  });
  return allowed;
}
const compositionTimers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>();
function clearCompositionTimer(view: EditorView) { const timer = compositionTimers.get(view); if (timer) clearTimeout(timer); compositionTimers.delete(view); }
export function hemingwayCommandBlocked(id: string) { return id.startsWith('block.') || id.startsWith('fold.') || id.startsWith('insert.') || ['edit.undo','edit.redo','edit.replace','panel.properties','panel.table','panel.templates','panel.export','view.source','view.split','view.preview','view.live'].includes(id); }
export const hemingwayProtection: Extension = [
  ViewPlugin.define(view => ({ destroy() { clearCompositionTimer(view); } })),
  hemingwayComposition,
  EditorState.transactionFilter.of(transaction => hemingwayAllows(transaction) ? transaction : []),
  Prec.highest(keymap.of(['Mod-z','Mod-Shift-z','Mod-y'].map(key => ({ key, run: () => true })))),
  Prec.highest(EditorView.domEventHandlers({
    beforeinput(event) {
      if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return false;
      event.preventDefault(); return true;
    },
    cut(event) { event.preventDefault(); return true; },
    dragstart(event) { event.preventDefault(); return true; },
    drop(event) { event.preventDefault(); return true; },
    compositionstart(_event, view) { clearCompositionTimer(view); view.dispatch({ effects: compositionBoundary.of('start') }); return false; },
    compositionend(_event, view) {
      // CodeMirror also accepts the final IME mutation shortly after the native
      // end event. Keep exactly this preedit range through that final flush.
      clearCompositionTimer(view); compositionTimers.set(view,setTimeout(() => { compositionTimers.delete(view); if (view.state.field(hemingwayComposition, false)) view.dispatch({ effects: compositionBoundary.of('end') }); }, 50));
      return false;
    },
    blur(_event, view) { clearCompositionTimer(view); view.dispatch({ effects: compositionBoundary.of('end') }); return false; },
  })),
  EditorView.editorAttributes.of({ class: 'cm-hemingway', 'data-hemingway': 'true' }),
  EditorView.theme({
    '.cm-search input[name=replace], .cm-search button[name=replace], .cm-search button[name=replaceAll], .cm-search br': { display: 'none' },
  }),
];
