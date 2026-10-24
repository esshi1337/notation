<script lang="ts">
  import type { CellSession } from './cells';
  import { onMount, untrack } from 'svelte';
  import { type CodeLanguage, intelligenceLanguage } from './code-languages';
  import type { Extension } from '@codemirror/state';
  import { loadLanguageIntelligence } from './intelligence-loader';
  import type { IntelligenceState } from './language-intelligence';
  import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
  import { Compartment, EditorState, Transaction } from '@codemirror/state';
  import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
  import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, undo, redo, toggleComment } from '@codemirror/commands';
  import { foldEffect, foldedRanges, unfoldEffect, foldGutter, HighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput, indentUnit, foldCode, unfoldCode, foldAll, unfoldAll } from '@codemirror/language';
  import { tags } from '@lezer/highlight';
  import { markdown } from '@codemirror/lang-markdown';
  import { search, searchKeymap, highlightSelectionMatches, openSearchPanel, gotoLine } from '@codemirror/search';
  import { livePreview, livePreviewFocus, revealDocumentSource, wikiNavigation } from './live-preview';
  import { mathMarkdown } from './markdown-features';
  import type { TaskToggle } from './markdown-features';
  import { toggleTask } from './tasks';
  import { performBlockAction, slashCommands, insertEditorTemplate } from './editor-commands';
  import type { BlockAction } from './editor-commands';
  import type { DocumentSelection } from './documents';
  import { wikiCompletion } from './wiki-completion';
  import type { WikiCompletion } from './wiki-links';
  import type { WikiCandidate } from './wiki-navigation';
  import { markdownFolding, performFold } from './folding';
  import type { FoldAction } from './folding';
  import { hemingwayAllows, hemingwayProtection } from './hemingway';
  import { editorToRaw, rawToEditor, sourceEolEffect, sourceFormat, sourceText } from './source-format';

  let { codeLanguage = 'markdown', intelligenceEnabled = false, tabSize = 2, indentWithTabs = false, onIntelligence, value, wrap, live, standalone, theme, folds, initialSelection, active = true, showLineNumbers = true, appearance = '', hemingway = false, cells, sourcePath, loadEmbed, onOpenPath, onOpenWiki, onEditProperties, wikiCandidates, onSelection, onChange }: { codeLanguage?: CodeLanguage; intelligenceEnabled?: boolean; tabSize?: number; indentWithTabs?: boolean; onIntelligence?: (state: IntelligenceState) => void; value: string; wrap: boolean; live: boolean; standalone: boolean; theme: 'dark' | 'light'; folds: Map<string, boolean>; initialSelection?: DocumentSelection; active?: boolean; showLineNumbers?: boolean; appearance?: string; hemingway?: boolean; cells?: CellSession; sourcePath?: string; loadEmbed?: (target: string, sourcePath?: string) => Promise<{ path: string; content: string; label: string; key: string }>; onOpenPath?: (path: string) => void; onOpenWiki?: (target: string, sourcePath?: string) => void; onEditProperties?: () => void; wikiCandidates?: (context: WikiCompletion) => Promise<WikiCandidate[]>; onSelection?: (selection: DocumentSelection) => void; onChange: (value: string) => void } = $props();
  let host: HTMLDivElement;
  let view: EditorView | undefined;
  let initialized = $state(false);
  let codeSyntax = $state.raw<Extension>([]);
  $effect(() => {
    const id = codeLanguage;
    let cancelled = false;
    codeSyntax = [];
    if (id !== 'markdown' && id !== 'plaintext') void import('./code-syntax').then(module => { if (!cancelled) codeSyntax = module.languageExtensions(id); });
    return () => { cancelled = true; };
  });
  const intelligence = new Compartment();
  const indentation = new Compartment();
  const wrapping = new Compartment();
  const presentation = new Compartment();
  const commands = new Compartment();
  const language = new Compartment();
  const protection = new Compartment();
  let protectedMode = false;
  let savedFolds: {from:number;to:number}[] = [];
  export function toggle(request: TaskToggle) {
    if (!view || hemingway) return false;
    const raw = sourceText(view.state);
    if (request.snapshot !== undefined && request.snapshot !== raw) return false;
    return toggleTask(view, {
      task: { ...request.task, from: rawToEditor(raw, request.task.from), to: rawToEditor(raw, request.task.to) },
      snapshot: request.snapshot?.replace(/\r\n?/gu, '\n'),
    });
  }
  export function restoreSelection(selection: DocumentSelection) {
    if (!view) return;
    const raw = sourceText(view.state);
    const clamp = (position: number) => rawToEditor(raw, Math.max(0, Math.min(raw.length, position)));
    view.dispatch({ selection: { anchor: clamp(selection.anchor), head: clamp(selection.head) }, scrollIntoView: true });
  }
  export function focus() { view?.focus(); }
  export function getView() { return view ?? null; }
  export function comment() { if (view && !hemingway && codeLanguage !== 'markdown') toggleComment(view); }
  export async function codeAction(action: 'definition' | 'references') { const current = view; if (current && intelligenceEnabled) { const module = await loadLanguageIntelligence(); if (view === current && intelligenceEnabled) return module.intelligenceCommand(current, action); } }
  export async function format() { const current = view; if (current && !hemingway && intelligenceEnabled) { const module = await loadLanguageIntelligence(); if (view === current && !hemingway && intelligenceEnabled) return module.formatCode(current, tabSize, !indentWithTabs); } }
  export async function renameSymbol(name: string) { const current = view; if (current && !hemingway && intelligenceEnabled) { const module = await loadLanguageIntelligence(); if (view === current && !hemingway && intelligenceEnabled) return module.renameCode(current, name); } }
  export function symbolName() { if (!view) return ''; const word = view.state.wordAt(view.state.selection.main.head); return word ? view.state.sliceDoc(word.from, word.to) : ''; }

  export function fold(action: FoldAction) { if (!view || standalone || hemingway) return false; const changed = codeLanguage === 'markdown' ? performFold(view, action) : ({ 'Fold block': foldCode, 'Unfold block': unfoldCode, 'Fold all': foldAll, 'Unfold all': unfoldAll }[action])(view); view.focus(); return changed; }
  export function undoEdit() { if (!view || hemingway) return false; view.focus(); return undo(view); }
  export function redoEdit() { if (!view || hemingway) return false; view.focus(); return redo(view); }
  export function replace() { if (view && !hemingway) { view.focus(); openSearchPanel(view); host.querySelector<HTMLInputElement>('.cm-search input[name=replace]')?.focus(); } }
  export function goToLine() { if (view) { view.focus(); gotoLine(view); } }
  export function find() { if (view) { view.focus(); openSearchPanel(view); } }
  export function reveal(from: number) { if (view) revealDocumentSource(view, rawToEditor(sourceText(view.state), from)); }
  export function revealLine(number: number) { if (view) revealDocumentSource(view, view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, number))).from); }
  export function insert(key: string) { return view && codeLanguage === 'markdown' && !standalone && !hemingway ? insertEditorTemplate(view,key) : false; }
  export function act(action: BlockAction) { return view && codeLanguage === 'markdown' && !standalone && !hemingway ? performBlockAction(view, action) : false; }
  export function snapshot() {
    const range = view?.state.selection.main;
    return { text: view ? sourceText(view.state) : value, selection: range ? sourceText(view!.state, range.from, range.to) : '', from: range ? editorToRaw(view!.state, range.from) : 0, to: range ? editorToRaw(view!.state, range.to) : 0 };
  }
  export function apply(text: string, expected: string, event = 'input.script') {
    if (!view || hemingway || sourceText(view.state) !== expected) return false;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, effects: sourceEolEffect(view.state, text), annotations: [isolateHistory.of('full'), Transaction.userEvent.of(event)] });
    return sourceText(view.state) === text;
  }
  export function selected() {
    const range = view?.state.selection.main;
    return { anchor: range ? editorToRaw(view!.state, range.anchor) : 0, head: range ? editorToRaw(view!.state, range.head) : 0 };
  }
  const highlighting = HighlightStyle.define([
    { tag: tags.heading, fontWeight: '600', color: 'var(--text)' },
    { tag: tags.strong, fontWeight: '600' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.link, textDecoration: 'underline', textUnderlineOffset: '3px' },
    { tag: [tags.url, tags.meta, tags.comment, tags.processingInstruction], color: 'var(--muted)' },
    { tag: tags.monospace, color: 'var(--text)' },
    { tag: [tags.keyword, tags.operatorKeyword], color: 'var(--code-keyword)', fontWeight: '600' },
    { tag: tags.string, color: 'var(--code-string)' },
    { tag: [tags.number, tags.bool, tags.null], color: 'var(--code-number)' },
  ]);

  function syntax() {
    if (hemingway) return [];
    return codeLanguage === 'markdown'
      ? [markdown({ extensions: [mathMarkdown] }), markdownFolding, syntaxHighlighting(highlighting), highlightActiveLine(), wikiCompletion(context => standalone || !wikiCandidates ? Promise.resolve([]) : wikiCandidates(context))]
      : [codeSyntax, syntaxHighlighting(highlighting), highlightActiveLine(), bracketMatching(), closeBrackets(), indentOnInput(), keymap.of(closeBracketsKeymap)];
  }
  onMount(() => {
    view = new EditorView({
      parent: host,
      dispatchTransactions(transactions, editorView) {
        // History intentionally bypasses transaction filters. Check the final
        // dispatch too, without consuming history or updating a rejected edit.
        if (hemingway && transactions.some(transaction => !hemingwayAllows(transaction))) return;
        if (transactions.some(transaction => transaction.docChanged && transaction.newDoc.length > 1024 * 1024 && new TextEncoder().encode(transaction.newDoc.toString()).length > 4 * 1024 * 1024)) {
          onIntelligence?.({state:'error',message:'Edit rejected: documents are limited to 4 MiB.'});
          return;
        }
        editorView.update(transactions);
      },
      state: EditorState.create({
        doc: value,
        selection: initialSelection ? { anchor: rawToEditor(value, initialSelection.anchor), head: rawToEditor(value, initialSelection.head) } : undefined,
        extensions: [
          sourceFormat(value),
          history(), drawSelection(), intelligence.of([]), indentation.of([EditorState.tabSize.of(tabSize), indentUnit.of(indentWithTabs ? "\t" : " ".repeat(tabSize))]),
          protection.of(hemingway ? hemingwayProtection : []),
          language.of(syntax()),
          search({ top: true }), highlightSelectionMatches(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          wrapping.of(wrap ? EditorView.lineWrapping : []),
          livePreviewFocus,
          presentation.of(hemingway ? [] : live ? livePreview(theme, standalone, folds, { openWiki: onOpenWiki, editProperties: onEditProperties, sourcePath, loadEmbed, openPath: onOpenPath, cells }) : [showLineNumbers ? lineNumbers() : [], standalone ? [] : foldGutter()]),
          commands.of(hemingway || standalone || codeLanguage !== 'markdown' ? [] : [slashCommands, wikiNavigation({ openWiki: onOpenWiki, editProperties: onEditProperties, sourcePath, loadEmbed, openPath: onOpenPath, cells })]),
          EditorView.contentAttributes.of({
            'aria-label': 'Document source', 'aria-multiline': 'true', spellcheck: 'false',
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              if (protectedMode) savedFolds = savedFolds.map(range => ({from:update.changes.mapPos(range.from,-1),to:update.changes.mapPos(range.to,1)}));
              onChange(sourceText(update.state));
            }
            if (update.docChanged || update.selectionSet) onSelection?.({ anchor: editorToRaw(update.state, update.state.selection.main.anchor), head: editorToRaw(update.state, update.state.selection.main.head) });
          }),
        ],
      }),
    });
    protectedMode = hemingway; initialized = true;
    return () => { initialized = false; view?.destroy(); view = undefined; };
  });

  $effect(() => {
    const locked = hemingway;
    if (!view) return;
    const effects = [protection.reconfigure(locked ? hemingwayProtection : []), language.reconfigure(syntax())];
    if (locked && !protectedMode) {
      savedFolds = []; foldedRanges(view.state).between(0,view.state.doc.length,(from,to) => { savedFolds.push({from,to}); });
      effects.push(...savedFolds.map(range => unfoldEffect.of(range)));
    } else if (!locked && protectedMode) {
      effects.push(...savedFolds.filter(range => range.from < range.to && range.to <= view!.state.doc.length).map(range => foldEffect.of(range)));
      savedFolds = [];
    }
    protectedMode = locked;
    view.dispatch({effects});
  });

  $effect(() => { const visible = active; const changed = appearance; if (view && visible) view.requestMeasure(); });

  $effect(() => {
    const next = value;
    if (view && !hemingway && sourceText(view.state) !== next) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next }, effects: sourceEolEffect(view.state, next) });
    }
  });

  $effect(() => {
    const locked = hemingway;
    const enabled = live;
    const palette = theme;
    const raw = standalone;
    const folded = folds;
    const numbers = showLineNumbers;
    if (view) view.dispatch({ effects: presentation.reconfigure(locked ? [] : enabled ? livePreview(palette, raw, folded, { openWiki: onOpenWiki, editProperties: onEditProperties, sourcePath, loadEmbed, openPath: onOpenPath, cells }) : [numbers ? lineNumbers() : [], raw ? [] : foldGutter()]) });
  });

  $effect(() => { const raw = standalone || codeLanguage !== 'markdown', locked = hemingway; if (view) view.dispatch({ effects: commands.reconfigure(locked || raw ? [] : [slashCommands, wikiNavigation({ openWiki: onOpenWiki, editProperties: onEditProperties, sourcePath, loadEmbed, openPath: onOpenPath, cells })]) }); });

  $effect(() => {
    const shouldWrap = wrap;
    if (view) view.dispatch({ effects: wrapping.reconfigure(shouldWrap ? EditorView.lineWrapping : []) });
  });
  $effect(() => { if (initialized && view) view.dispatch({ effects: indentation.reconfigure([EditorState.tabSize.of(tabSize), indentUnit.of(indentWithTabs ? "\t" : " ".repeat(tabSize))]) }); });
  $effect(() => {
    const ready = initialized, path = sourcePath, id = codeLanguage, enabled = intelligenceEnabled && !hemingway;
    const report = untrack(() => onIntelligence);
    if (!ready || !view) return;
    if (!enabled || !path?.startsWith('/') || !intelligenceLanguage(id)) { report?.({ state: 'off', message: !enabled ? 'Language intelligence off' : !path?.startsWith('/') ? 'Save this file to enable language intelligence' : 'Syntax highlighting' }); return; }
    let cancelled = false, release: (() => void) | undefined;
    void loadLanguageIntelligence().then(module => cancelled ? null : module.attachIntelligence(path, id, value => { if (!cancelled) report?.(value); })).then(connection => {
      if (!connection) return;
      if (cancelled || !view) { connection.release(); return; }
      release = connection.release; view.dispatch({ effects: intelligence.reconfigure(connection.extension) });
    }).catch(cause => { if (!cancelled) report?.({ state: 'error', message: String(cause) }); });
    return () => { cancelled = true; if (view) view.dispatch({ effects: intelligence.reconfigure([]) }); release?.(); };
  });
</script>

<div class="editor-host" bind:this={host}></div>
