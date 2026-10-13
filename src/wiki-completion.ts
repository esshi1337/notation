import { autocompletion, completionKeymap, pickedCompletion } from '@codemirror/autocomplete';
import type { Completion, CompletionContext } from '@codemirror/autocomplete';
import { Transaction } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { wikiCompletionAt } from './wiki-links';
import type { WikiCompletion } from './wiki-links';
import type { WikiCandidate } from './wiki-navigation';

export function wikiCompletion(candidates: (context: WikiCompletion) => Promise<WikiCandidate[]>) {
  async function source(context: CompletionContext) {
    const text = context.state.doc.toString(), span = wikiCompletionAt(text, context.pos);
    if (!span) return null;
    let notes: WikiCandidate[];
    try { notes = await candidates(span); } catch { return null; }
    if (context.aborted) return null;
    const options: Completion[] = [];
    const add = (label: string, insertion: string, detail: string) => options.push({
      label, detail, type: span.kind === 'heading' ? 'property' : 'text',
      apply(view, completion) {
        const now = wikiCompletionAt(view.state.doc.toString(), view.state.selection.main.head);
        if (!now || now.kind !== span.kind || now.from !== span.from || now.note !== span.note || now.query !== span.query) return;
        const after = view.state.doc.sliceString(now.to, now.to + 2);
        const suffix = after.startsWith('#') || after.startsWith('|') || after.startsWith(']]') ? '' : ']]';
        view.dispatch({ changes: { from: now.from, to: now.to, insert: insertion + suffix }, selection: { anchor: now.from + insertion.length + suffix.length }, annotations: [pickedCompletion.of(completion), isolateHistory.of('full'), Transaction.userEvent.of('input.complete')] });
      },
    });
    for (const note of notes) {
      if (span.kind === 'heading') for (const heading of note.headings) { if (heading.text.toLowerCase().includes(span.query.toLowerCase())) add(heading.text, heading.text, note.relativePath); }
      else add(note.title || note.name, note.link, note.relativePath);
    }
    return options.length ? { from: span.from, to: span.to, options, filter: false } : null;
  }
  return [autocompletion({ override: [source], defaultKeymap: false, activateOnTyping: true }), keymap.of(completionKeymap)];
}
