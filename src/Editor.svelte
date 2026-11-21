<script module lang="ts">
  // Intelligence commands can finish after a tab switch, and cross-file rename
  // collects every target view before applying its edits. Hold views only for
  // the duration of those operations. Opt-in intelligence also keeps inactive
  // views connected so servers can see unsaved buffers across files.
  let intelligenceDepth = 0;
  const residencyChecks = new Set<() => void>();
  function holdIntelligenceViews() {
    intelligenceDepth++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (--intelligenceDepth === 0) for (const check of residencyChecks) check();
    };
  }
</script>

<script lang="ts">
  import type { CellSession } from './cells';
  import { onMount, untrack } from 'svelte';
  import { type CodeLanguage, intelligenceLanguage } from './code-languages';
  import type { Extension, StateEffect, TransactionSpec } from '@codemirror/state';
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
  import { StateField } from '@codemirror/state';
  import { formattingStatus, reducedFormatting } from './reduced-formatting';
  import type { FormattingStatus } from './reduced-formatting';

  let { codeLanguage = 'markdown', intelligenceEnabled = false, tabSize = 2, indentWithTabs = false, onIntelligence, value, wrap, live, standalone, theme, folds, initialSelection, active = true, showLineNumbers = true, appearance = '', hemingway = false, cells, sourcePath, loadEmbed, onOpenPath, onOpenWiki, onEditProperties, wikiCandidates, onSelection, onFormatting, onChange }: { codeLanguage?: CodeLanguage; intelligenceEnabled?: boolean; tabSize?: number; indentWithTabs?: boolean; onIntelligence?: (state: IntelligenceState) => void; value: string; wrap: boolean; live: boolean; standalone: boolean; theme: 'dark' | 'light'; folds: Map<string, boolean>; initialSelection?: DocumentSelection; active?: boolean; showLineNumbers?: boolean; appearance?: string; hemingway?: boolean; cells?: CellSession; sourcePath?: string; loadEmbed?: (target: string, sourcePath?: string) => Promise<{ path: string; content: string; label: string; key: string }>; onOpenPath?: (path: string) => void; onOpenWiki?: (target: string, sourcePath?: string) => void; onEditProperties?: () => void; wikiCandidates?: (context: WikiCompletion) => Promise<WikiCandidate[]>; onSelection?: (selection: DocumentSelection) => void; onFormatting?: (status: FormattingStatus) => void; onChange: (value: string) => void } = $props();
  let host: HTMLDivElement;
  let view: EditorView | undefined;
  let retainedState: EditorState | undefined;
  let mounted = false;
  let initialized = $state(false);
  let pendingSelection = untrack(() => initialSelection ? { ...initialSelection } : undefined);
  let pendingScrollIntoView = false;
  let savedScroll: StateEffect<unknown> | undefined;
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
  let formattingReduced = $state(false);
  let formattingReason = $state<FormattingStatus['reason']>(null);

  const formattingState = StateField.define<FormattingStatus>({
    create: state => formattingStatus(state.doc),
    update: (status, tr) => tr.docChanged ? formattingStatus(tr.newDoc, status) : status,
  });
  function evaluateFormatting(state: EditorState) {
    const status = state.field(formattingState);
    formattingReduced = codeLanguage === 'markdown' && !hemingway && status.reduced;
    formattingReason = formattingReduced ? status.reason : null;
  }

  function currentState() { return view?.state ?? retainedState; }
  function rawPosition(text: string, position: number) {
    const clamped = Math.max(0, Math.min(text.length, Math.trunc(position)));
    return Number.isNaN(clamped) ? 0 : clamped;
  }
  function accepts(transactions: readonly Transaction[]) {
    // History intentionally bypasses transaction filters. Check the final
    // dispatch too, without consuming history or updating a rejected edit.
    if (hemingway && transactions.some(transaction => !hemingwayAllows(transaction))) return false;
    if (transactions.some(transaction => transaction.docChanged && transaction.newDoc.length > 1024 * 1024 && new TextEncoder().encode(transaction.newDoc.toString()).length > 4 * 1024 * 1024)) {
      onIntelligence?.({state:'error',message:'Edit rejected: documents are limited to 4 MiB.'});
      return false;
    }
    return true;
  }
  function dispatch(spec: TransactionSpec) {
    const current = currentState();
    if (!current) return false;
    if (view) { view.dispatch(spec); return true; }
    const transaction = current.update(spec);
    if (!accepts([transaction])) return false;
    retainedState = transaction.state;
    evaluateFormatting(retainedState);
    if (savedScroll && transaction.docChanged) savedScroll = savedScroll.map(transaction.changes);
    if (protectedMode && transaction.docChanged) savedFolds = savedFolds.map(range => ({from:transaction.changes.mapPos(range.from,-1),to:transaction.changes.mapPos(range.to,1)}));
    if (transaction.docChanged) onChange(sourceText(transaction.state));
    if (transaction.docChanged || transaction.selection) onSelection?.({ anchor: editorToRaw(transaction.state, transaction.state.selection.main.anchor), head: editorToRaw(transaction.state, transaction.state.selection.main.head) });
    return true;
  }

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
    const current = currentState();
    if (!current) {
      pendingSelection = { anchor: rawPosition(value, selection.anchor), head: rawPosition(value, selection.head) };
      pendingScrollIntoView = true;
      onSelection?.({ ...pendingSelection });
      return;
    }
    const raw = sourceText(current);
    const clamp = (position: number) => rawToEditor(raw, Math.max(0, Math.min(raw.length, position)));
    const restored = { anchor: clamp(selection.anchor), head: clamp(selection.head) };
    if (view) view.dispatch({ selection: restored, scrollIntoView: true });
    else if (dispatch({ selection: restored })) {
      savedScroll = EditorView.scrollIntoView(restored.head);
      pendingScrollIntoView = false;
    }
  }
  export function focus() { view?.focus(); }
  /** One-based source line at the top of the viewport; null while hidden. */
  export function topLine(): number | null {
    if (!view || !view.scrollDOM.clientHeight) return null;
    const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
    return view.state.doc.lineAt(view.lineBlockAtHeight(Math.max(0, top + 1)).from).number;
  }
  /** Put a source line at the top of the viewport. */
  export function scrollToLine(number: number) {
    if (!view) return;
    const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, Math.round(number))));
    savedScroll = undefined;
    // The first line is the document top, including any padding above it.
    if (line.number === 1) view.scrollDOM.scrollTop = 0;
    else view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 0 }) });
  }
  export function getView() { return view ?? null; }
  export function comment() { if (view && !hemingway && codeLanguage !== 'markdown') toggleComment(view); }
  export async function codeAction(action: 'definition' | 'references') { const current = view; if (current && intelligenceEnabled) { const module = await loadLanguageIntelligence(); if (view === current && intelligenceEnabled) return module.intelligenceCommand(current, action); } }
  export async function format() { const current = view; if (current && !hemingway && intelligenceEnabled) { const module = await loadLanguageIntelligence(); if (view === current && !hemingway && intelligenceEnabled) return module.formatCode(current, tabSize, !indentWithTabs); } }
  export async function renameSymbol(name: string) {
    const current = view;
    if (!current || hemingway || !intelligenceEnabled) return;
    const module = await loadLanguageIntelligence();
    if (view !== current || hemingway || !intelligenceEnabled) return;
    const release = holdIntelligenceViews();
    try { return await module.renameCode(current, name); }
    finally { release(); }
  }
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
    const current = currentState();
    if (!current) {
      const selection = pendingSelection ?? { anchor: 0, head: 0 };
      const from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head);
      return { text: value, selection: value.slice(from, to), from, to };
    }
    const range = current.selection.main;
    return { text: sourceText(current), selection: sourceText(current, range.from, range.to), from: editorToRaw(current, range.from), to: editorToRaw(current, range.to) };
  }
  export function apply(text: string, expected: string, event = 'input.script') {
    const current = currentState();
    if (hemingway || (current ? sourceText(current) : value) !== expected) return false;
    const target = current ?? createState();
    if (!dispatch({ changes: { from: 0, to: target.doc.length, insert: text }, effects: sourceEolEffect(target, text), annotations: [isolateHistory.of('full'), Transaction.userEvent.of(event)] })) return false;
    const updated = currentState();
    return !!updated && sourceText(updated) === text;
  }
  export function selected() {
    const current = currentState();
    if (!current) return pendingSelection ? { ...pendingSelection } : { anchor: 0, head: 0 };
    const range = current.selection.main;
    return { anchor: editorToRaw(current, range.anchor), head: editorToRaw(current, range.head) };
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

  function syntax(reduced = formattingReduced) {
    if (hemingway || (codeLanguage === 'markdown' && reduced)) return [];
    return codeLanguage === 'markdown'
      ? [markdown({ extensions: [mathMarkdown] }), markdownFolding, syntaxHighlighting(highlighting), highlightActiveLine(), wikiCompletion(context => standalone || !wikiCandidates ? Promise.resolve([]) : wikiCandidates(context))]
      : [codeSyntax, syntaxHighlighting(highlighting), highlightActiveLine(), bracketMatching(), closeBrackets(), indentOnInput(), keymap.of(closeBracketsKeymap)];
  }
  function presentationExtensions(reduced = formattingReduced) {
    if (hemingway) return [];
    // Reduced mode keeps plain source text and optional line numbers, without
    // rich widgets or folding. Text, undo and selection are untouched.
    if (reduced) return [showLineNumbers ? lineNumbers() : []];
    return live ? livePreview(theme, standalone, folds, { openWiki: onOpenWiki, editProperties: onEditProperties, sourcePath, loadEmbed, openPath: onOpenPath, cells })
      : [showLineNumbers ? lineNumbers() : [], standalone ? [] : foldGutter()];
  }
  function createState() {
    const text = value;
    const selection = pendingSelection;
    const status = codeLanguage === 'markdown' && !hemingway ? reducedFormatting(text) : { reduced: false, reason: null };
    formattingReduced = status.reduced;
    formattingReason = status.reason;
    retainedState = EditorState.create({
      doc: text,
      selection: selection ? { anchor: rawToEditor(text, selection.anchor), head: rawToEditor(text, selection.head) } : undefined,
      extensions: [
        sourceFormat(text),
        history(), drawSelection(), intelligence.of([]), indentation.of([EditorState.tabSize.of(tabSize), indentUnit.of(indentWithTabs ? "\t" : " ".repeat(tabSize))]),
        protection.of(hemingway ? hemingwayProtection : []),
        formattingState,
        // Extenders run before the new state/language parser is constructed.
        // Never read tr.state here: doing so would perform the work we avoid.
        EditorState.transactionExtender.of(tr => {
          if (!tr.docChanged || codeLanguage !== 'markdown' || hemingway) return null;
          const before = tr.startState.field(formattingState);
          const next = formattingStatus(tr.newDoc, before);
          if (before.reduced === next.reduced) return null;
          return { effects: [language.reconfigure(syntax(next.reduced)), presentation.reconfigure(presentationExtensions(next.reduced))] };
        }),
        language.of(syntax()),
        search({ top: true }), highlightSelectionMatches(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        wrapping.of(wrap ? EditorView.lineWrapping : []),
        livePreviewFocus,
        presentation.of(presentationExtensions()),
        commands.of(hemingway || standalone || codeLanguage !== 'markdown' ? [] : [slashCommands, wikiNavigation({ openWiki: onOpenWiki, editProperties: onEditProperties, sourcePath, loadEmbed, openPath: onOpenPath, cells })]),
        EditorView.contentAttributes.of({
          'aria-label': 'Document source', 'aria-multiline': 'true', spellcheck: 'false',
        }),
        // Capture while visible: Svelte may hide the parent before sleep(),
        // at which point the browser has already reset its scroll geometry.
        EditorView.domEventObservers({ scroll(_event, editorView) {
          if (editorView.scrollDOM.clientHeight) savedScroll = editorView.scrollSnapshot();
        } }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            if (savedScroll) savedScroll = savedScroll.map(update.changes);
            if (protectedMode) savedFolds = savedFolds.map(range => ({from:update.changes.mapPos(range.from,-1),to:update.changes.mapPos(range.to,1)}));
            evaluateFormatting(update.state);
            onChange(sourceText(update.state));
          }
          if (update.docChanged || update.selectionSet) onSelection?.({ anchor: editorToRaw(update.state, update.state.selection.main.anchor), head: editorToRaw(update.state, update.state.selection.main.head) });
        }),
      ],
    });
    pendingSelection = undefined;
    protectedMode = hemingway;
    return retainedState;
  }
  function wake() {
    if (view) return;
    const editorState = retainedState ?? createState();
    evaluateFormatting(editorState);
    const scrollTo = savedScroll ?? (pendingScrollIntoView ? EditorView.scrollIntoView(editorState.selection.main.head) : undefined);
    const current = new EditorView({
      parent: host,
      state: editorState,
      scrollTo,
      dispatchTransactions(transactions, editorView) {
        if (!accepts(transactions)) return;
        editorView.update(transactions);
        retainedState = editorView.state;
      },
    });
    view = current;
    retainedState = current.state;
    savedScroll = undefined;
    pendingScrollIntoView = false;
    initialized = true;
  }
  function sleep() {
    const current = view;
    if (!current) return;
    current.dispatch({ effects: intelligence.reconfigure([]) });
    savedScroll ??= current.scrollSnapshot();
    retainedState = current.state;
    view = undefined;
    initialized = false;
    current.destroy();
  }
  function syncResidency() {
    if (!mounted) return;
    if (active || intelligenceEnabled) wake();
    else if (!intelligenceDepth) sleep();
  }
  onMount(() => {
    mounted = true;
    residencyChecks.add(syncResidency);
    syncResidency();
    return () => {
      mounted = false;
      residencyChecks.delete(syncResidency);
      const current = view;
      view = undefined;
      initialized = false;
      current?.destroy();
      retainedState = undefined;
      savedScroll = undefined;
    };
  });

  $effect(() => { const visible = active, connected = intelligenceEnabled; if (visible || connected || view) syncResidency(); });

  $effect(() => {
    const locked = hemingway;
    const reduced = formattingReduced;
    const current = currentState();
    if (!current) return;
    evaluateFormatting(current);
    const nextSyntax = syntax(formattingReduced);
    void reduced;
    const effects = [protection.reconfigure(locked ? hemingwayProtection : []), language.reconfigure(nextSyntax)];
    if (locked && !protectedMode) {
      savedFolds = []; foldedRanges(current).between(0,current.doc.length,(from,to) => { savedFolds.push({from,to}); });
      effects.push(...savedFolds.map(range => unfoldEffect.of(range)));
    } else if (!locked && protectedMode) {
      effects.push(...savedFolds.filter(range => range.from < range.to && range.to <= current.doc.length).map(range => foldEffect.of(range)));
      savedFolds = [];
    }
    protectedMode = locked;
    dispatch({effects});
  });

  $effect(() => { const visible = active; const changed = appearance; if (view && visible) view.requestMeasure(); });

  $effect(() => {
    const next = value;
    const current = currentState();
    if (current && !hemingway && sourceText(current) !== next) {
      dispatch({ changes: { from: 0, to: current.doc.length, insert: next }, effects: sourceEolEffect(current, next) });
    }
  });

  $effect(() => {
    const locked = hemingway;
    const enabled = live;
    const palette = theme;
    const raw = standalone;
    const folded = folds;
    const numbers = showLineNumbers;
    const reduced = formattingReduced;
    if (!currentState()) return;
    void [locked, enabled, palette, raw, folded, numbers, reduced];
    dispatch({ effects: presentation.reconfigure(presentationExtensions()) });
  });

  $effect(() => {
    const reduced = formattingReduced, reason = formattingReason;
    untrack(() => onFormatting?.({ reduced, reason, size: currentState()?.doc.length ?? value.length }));
  });

  $effect(() => {
    const raw = standalone || codeLanguage !== 'markdown', locked = hemingway;
    if (!currentState()) return;
    dispatch({ effects: commands.reconfigure(locked || raw ? [] : [slashCommands, wikiNavigation({ openWiki: onOpenWiki, editProperties: onEditProperties, sourcePath, loadEmbed, openPath: onOpenPath, cells })]) });
  });

  $effect(() => {
    const shouldWrap = wrap;
    if (currentState()) dispatch({ effects: wrapping.reconfigure(shouldWrap ? EditorView.lineWrapping : []) });
  });
  $effect(() => { const ready = initialized, size = tabSize, tabs = indentWithTabs; if (ready && currentState()) dispatch({ effects: indentation.reconfigure([EditorState.tabSize.of(size), indentUnit.of(tabs ? "\t" : " ".repeat(size))]) }); });
  $effect(() => {
    const ready = initialized, path = sourcePath, id = codeLanguage, enabled = intelligenceEnabled && !hemingway;
    const report = untrack(() => onIntelligence);
    if (!ready || !view) return;
    const current = view;
    if (!enabled || !path?.startsWith('/') || !intelligenceLanguage(id)) { report?.({ state: 'off', message: !enabled ? 'Language intelligence off' : !path?.startsWith('/') ? 'Save this file to enable language intelligence' : 'Syntax highlighting' }); return; }
    let cancelled = false, release: (() => void) | undefined;
    void loadLanguageIntelligence().then(module => cancelled ? null : module.attachIntelligence(path, id, value => { if (!cancelled) report?.(value); })).then(connection => {
      if (!connection) return;
      if (cancelled || view !== current) { connection.release(); return; }
      release = connection.release; current.dispatch({ effects: intelligence.reconfigure(connection.extension) });
    }).catch(cause => { if (!cancelled) report?.({ state: 'error', message: String(cause) }); });
    return () => { cancelled = true; if (view === current) current.dispatch({ effects: intelligence.reconfigure([]) }); release?.(); };
  });
</script>

<div class="editor-host" bind:this={host}></div>
