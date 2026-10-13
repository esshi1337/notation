import { codeFolding, foldAll, foldEffect, foldService, foldedRanges, unfoldAll, unfoldEffect } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { featureParser, markdownSource } from './markdown-features';

export type FoldAction = 'Fold block' | 'Unfold block' | 'Fold all' | 'Unfold all';
export type MarkdownFold = { from: number; to: number; header: number; kind: string };
let cachedText: string | undefined, cached: MarkdownFold[] = [];
export function markdownFolds(text: string): MarkdownFold[] {
  if (text === cachedText) return cached;
  const lineStart = (at: number) => text.lastIndexOf('\n', at - 1) + 1;
  const lineEnd = (at: number) => { const end = text.indexOf('\n', at); return end < 0 ? text.length : end; };
  const ranges: MarkdownFold[] = [];
  const add = (header: number, to: number, kind: string, from = lineEnd(header)) => {
    while (to > from && /[\r\n]/u.test(text[to - 1])) to--;
    if (to > from && text.slice(from, to).includes('\n')) ranges.push({ from, to, header: lineStart(header), kind });
  };
  featureParser.parse(markdownSource(text)).iterate({ enter(ref) {
    const node = ref.node, name = node.name;
    if (/^(?:ATXHeading[1-6]|SetextHeading[12])$/u.test(name)) {
      const level = Number(name.slice(-1)); let end = node.parent?.to ?? text.length;
      for (let next = node.nextSibling; next; next = next.nextSibling) if (/^(?:ATXHeading[1-6]|SetextHeading[12])$/u.test(next.name) && Number(next.name.slice(-1)) <= level) { end = lineStart(next.from); break; }
      add(node.from, end, 'heading');
    } else if (name === 'FencedCode' || name === 'CodeBlock' || name === 'Blockquote' || name === 'ListItem' || name === 'BulletList' || name === 'OrderedList' || name === 'NotationMathBlock') add(node.from, node.to, name);
    if (name === 'FencedCode' || name === 'CodeBlock' || name === 'NotationMathBlock') return false;
  } });
  // A list and its first item may share a header. Prefer the individual item
  // there so a nested subtree can collapse without hiding unrelated siblings.
  ranges.sort((a, b) => a.header - b.header || a.to - b.to || (a.kind === 'ListItem' ? -1 : b.kind === 'ListItem' ? 1 : 0));
  cachedText = text;
  return cached = ranges.filter((range, index) => !ranges.slice(0, index).some((other) => other.from === range.from && other.to === range.to));
}
function rangesFor(state: EditorState) { return markdownFolds(state.doc.toString()); }
export const markdownFolding: Extension = [
  EditorView.theme({ '.cm-foldPlaceholder': { backgroundColor: 'var(--code)', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: '2px', padding: '0 5px', font: 'inherit', lineHeight: '1.2', cursor: 'pointer' }, '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer', padding: '0 4px' } }),
  codeFolding({ placeholderDOM(_view, onclick) {
    const button = document.createElement('button'); button.className = 'cm-foldPlaceholder'; button.textContent = '…'; button.setAttribute('aria-label', 'Unfold block'); button.title = 'Unfold block'; button.addEventListener('click', onclick); return button;
  } }),
  foldService.of((state, start) => rangesFor(state).find((range) => range.header === start) ?? null),
];
export function performFold(view: EditorView, action: FoldAction): boolean {
  if (action === 'Unfold all') return unfoldAll(view);
  if (action === 'Fold all') return foldAll(view);
  const at = view.state.selection.main.head, line = view.state.doc.lineAt(at);
  if (action === 'Unfold block') {
    const candidates: { from: number; to: number }[] = [];
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => { if (from >= line.from && from <= line.to || from <= at && at <= to) candidates.push({ from, to }); });
    const range = candidates.sort((a, b) => a.to - a.from - (b.to - b.from))[0];
    if (!range) return false;
    view.dispatch({ effects: unfoldEffect.of(range) }); return true;
  }
  const ranges = rangesFor(view.state).filter((range) => range.header <= at && at <= range.to);
  const range = ranges.filter((item) => item.header === line.from)[0] ?? ranges.sort((a, b) => a.to - a.from - (b.to - b.from))[0];
  if (!range) return false;
  view.dispatch({ effects: foldEffect.of(range), selection: { anchor: Math.min(at, range.from) } }); return true;
}
