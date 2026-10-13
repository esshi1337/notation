import { Prec, StateEffect, StateField, Transaction } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView, keymap, showTooltip } from '@codemirror/view';
import type { Tooltip } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';

import { insertionTemplates as templates } from './insertion-templates';

type SlashState = { from: number; to: number; query: string; selected: number; options: readonly (typeof templates[number])[] };
const chooseOption = StateEffect.define<number>();
const dismissSlash = StateEffect.define<null>();

function slashAt(state: EditorState): SlashState | null {
  if (!state.selection.main.empty) return null;
  const at = state.selection.main.head, line = state.doc.lineAt(at);
  const match = /^([ \t]*)\/([a-z]*)$/iu.exec(state.sliceDoc(line.from, at));
  if (!match || state.sliceDoc(at, line.to).trim()) return null;
  let node = (ensureSyntaxTree(state, at, 30) ?? syntaxTree(state)).resolveInner(at, -1);
  for (;;) {
    if (['FencedCode', 'CodeBlock', 'InlineCode', 'NotationMathInline', 'NotationMathBlock', 'URL', 'Link'].includes(node.name)) return null;
    if (!node.parent) break;
    node = node.parent;
  }
  const query = match[2].toLowerCase();
  const options = templates.filter((item) => item.key.includes(query) || ('alias' in item && item.alias.includes(query)) || item.label.toLowerCase().includes(query));
  return options.length ? { from: line.from + match[1].length, to: at, query, selected: 0, options } : null;
}

export function insertEditorTemplate(view: EditorView, key: string): boolean {
  const template = templates.find(item => item.key === key || 'alias' in item && item.alias === key);
  if (!template) return false;
  const range = view.state.selection.main;
  view.dispatch({ changes: { from: range.from, to: range.to, insert: template.text }, selection: { anchor: range.from + Math.min(template.text.length, template.caret) }, annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.insert')] });
  view.focus(); return true;
}
function insertSlash(view: EditorView, value: SlashState, index: number) {
  const option = value.options[index];
  if (!option) return;
  view.dispatch({
    changes: { from: value.from, to: value.to, insert: option.text },
    selection: { anchor: value.from + option.caret }, effects: dismissSlash.of(null),
    annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.slash')],
  });
  view.focus();
}

const slashField = StateField.define<SlashState | null>({
  create: slashAt,
  update(value, transaction) {
    if (transaction.effects.some((effect) => effect.is(dismissSlash))) return null;
    const picked = transaction.effects.find((effect) => effect.is(chooseOption));
    if (picked && value) return { ...value, selected: picked.value as number };
    if (!transaction.docChanged && !transaction.selection) return value;
    return slashAt(transaction.state);
  },
  provide: (field) => showTooltip.from(field, (value): Tooltip | null => value ? {
    pos: value.to, above: false,
    create(view) {
      const dom = document.createElement('div');
      dom.className = 'slash-menu'; dom.setAttribute('role', 'listbox'); dom.setAttribute('aria-label', 'Slash commands');
      value.options.forEach((option, index) => {
        const row = document.createElement('div');
        row.className = 'slash-option'; row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(index === value.selected));
        row.textContent = option.label;
        row.addEventListener('mousedown', (event) => { event.preventDefault(); insertSlash(view, value, index); });
        dom.append(row);
      });
      return { dom };
    },
  } : null),
});

export const slashCommands: Extension = [slashField, Prec.highest(keymap.of([
  { key: 'ArrowDown', run(view) { const value = view.state.field(slashField); if (!value) return false; view.dispatch({ effects: chooseOption.of((value.selected + 1) % value.options.length) }); return true; } },
  { key: 'ArrowUp', run(view) { const value = view.state.field(slashField); if (!value) return false; view.dispatch({ effects: chooseOption.of((value.selected + value.options.length - 1) % value.options.length) }); return true; } },
  { key: 'Enter', run(view) { const value = view.state.field(slashField); if (!value) return false; insertSlash(view, value, value.selected); return true; } },
  { key: 'Escape', run(view) { if (!view.state.field(slashField)) return false; view.dispatch({ effects: dismissSlash.of(null) }); return true; } },
]))];

export type BlockAction = 'Move up' | 'Move down' | 'Duplicate' | 'Delete' | 'Turn into heading' | 'Turn into paragraph' | 'Turn into task';
export const blockActions: BlockAction[] = ['Move up', 'Move down', 'Duplicate', 'Delete', 'Turn into heading', 'Turn into paragraph', 'Turn into task'];

function blocks(state: EditorState) {
  const list: { from: number; to: number; type: string }[] = [];
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) list.push({
    from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(node.to).to, type: node.name,
  });
  return list;
}

export function performBlockAction(view: EditorView, action: BlockAction): boolean {
  const state = view.state, list = blocks(state), at = state.selection.main.head;
  let index = list.findIndex((block) => at >= block.from && at <= block.to);
  if (index < 0) index = list.findIndex((block) => block.from > at);
  if (index < 0) index = list.length - 1;
  const block = list[index];
  if (!block) return false;
  const text = state.sliceDoc(block.from, block.to);
  let from = block.from, to = block.to, insert = text, anchor = block.from;
  if (action === 'Move up' || action === 'Move down') {
    const neighbor = list[index + (action === 'Move up' ? -1 : 1)];
    if (!neighbor) return false;
    const other = state.sliceDoc(neighbor.from, neighbor.to);
    if (action === 'Move up') {
      from = neighbor.from;
      const gap = state.sliceDoc(neighbor.to, block.from);
      insert = text + gap + other; anchor = from;
    } else {
      to = neighbor.to;
      const gap = state.sliceDoc(block.to, neighbor.from);
      insert = other + gap + text; anchor = from + other.length + gap.length;
    }
  } else if (action === 'Duplicate') {
    from = to; insert = '\n\n' + text; anchor = from + 2;
  } else if (action === 'Delete') {
    if (list[index + 1]) to = list[index + 1].from;
    else if (list[index - 1]) from = list[index - 1].to;
    else { from = 0; to = state.doc.length; }
    insert = ''; anchor = from;
  } else {
    if (!(block.type === 'Paragraph' || block.type.startsWith('ATXHeading')) || text.includes('\n')) return false;
    const plain = block.type.startsWith('ATXHeading') ? text.replace(/^#{1,6}[ \t]+/u, '').replace(/[ \t]+#+[ \t]*$/u, '') : text;
    insert = action === 'Turn into heading' ? `# ${plain}` : action === 'Turn into task' ? `- [ ] ${plain}` : plain;
  }
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: Math.min(anchor, state.doc.length - (to - from) + insert.length) }, annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.block')] });
  view.focus();
  return true;
}
