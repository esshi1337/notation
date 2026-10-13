import { Facet, StateEffect, StateField } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';

type Eol = '\n' | '\r\n';
const initialEol = Facet.define<Eol, Eol>({ combine: (values) => values[0] ?? '\n' });
const setEol = StateEffect.define<Eol>();
const eolField = StateField.define<Eol>({
  create: (state) => state.facet(initialEol),
  update(value, transaction) { for (const effect of transaction.effects) if (effect.is(setEol)) value = effect.value; return value; },
});
export function sourceFormat(text: string) {
  return [
    initialEol.of(text.includes('\r\n') ? '\r\n' : '\n'), eolField,
    invertedEffects.of((transaction) => transaction.effects.some((effect) => effect.is(setEol)) ? [setEol.of(transaction.startState.field(eolField))] : []),
  ];
}
export function sourceText(state: EditorState, from = 0, to = state.doc.length): string { return state.doc.sliceString(from, to, state.field(eolField)); }
export function sourceEolEffect(state: EditorState, text: string) { return setEol.of(text.includes('\n') ? text.includes('\r\n') ? '\r\n' : '\n' : state.field(eolField)); }
export function rawToEditor(text: string, position: number) { return text.slice(0, Math.max(0, Math.min(text.length, position))).replace(/\r\n?/gu, '\n').length; }
export function editorToRaw(state: EditorState, position: number) { return sourceText(state, 0, position).length; }
