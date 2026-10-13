import { Transaction } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import type { TaskToggle } from './markdown-features';

export function toggleTask(view: EditorView, { task, snapshot }: TaskToggle): boolean {
  const document = view.state.doc;
  if (snapshot !== undefined && document.toString() !== snapshot) return false;
  if (task.from < 0 || task.to > document.length || document.sliceString(task.from, task.to) !== task.marker) return false;
  view.dispatch({
    changes: { from: task.from, to: task.to, insert: task.checked ? '[ ]' : '[x]' },
    annotations: [Transaction.userEvent.of('input.task'), isolateHistory.of('full')],
  });
  return true;
}
