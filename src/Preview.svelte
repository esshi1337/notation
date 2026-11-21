<script lang="ts">
  import { onDestroy } from 'svelte';
  import { renderMarkdown } from './render-markdown';
  import type { CellSession } from './cells';
  import { renderContent, clearRenderedContent } from './render-content';
  import type { EmbedDocument } from './render-content';
  import type { TaskToggle } from './markdown-features';
  import { reducedFormatting } from './reduced-formatting';
  import { buildAnchors, lineForOffset, offsetForLine, sourceHeadingLines } from './scroll-anchor';
  import { motionMs } from './motion';
  import { resolveMathMode } from './math-syntax';
  import type { MathMode } from './math-syntax';

  let { mathMode = 'auto', documentId, content, standalone, theme, folds, onToggleTask, onEditSource, onOpenWiki, onEditProperties, sourcePath, loadEmbed, onOpenPath, cells }: { mathMode?: MathMode; documentId: number; content: string; standalone: boolean; theme: 'dark' | 'light'; folds: Map<string, boolean>; onToggleTask: (request: TaskToggle) => boolean; onEditSource: (from: number) => void; onOpenWiki?: (target: string, sourcePath?: string) => void; onEditProperties?: () => void; sourcePath?: string; loadEmbed?: (target: string, sourcePath?: string) => Promise<EmbedDocument>; onOpenPath?: (path: string) => void; cells?: CellSession } = $props();
  let container: HTMLDivElement;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout>;
  let queue: Promise<void> = Promise.resolve();
  let rendering = $state(false);
  let scroller: HTMLDivElement;
  let pendingLine: number | null = null;

  // Source-line anchors for the rendered document: its top-level headings,
  // as offsets within the scrolled content.
  function anchors() {
    const headings = [...container.querySelectorAll<HTMLElement>(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6')];
    const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
    return buildAnchors(content.split('\n').length, scroller.scrollHeight, standalone ? [] : sourceHeadingLines(content), headings.map((heading) => heading.getBoundingClientRect().top - origin));
  }
  /** One-based source line at the top of the viewport; null while hidden or rendering. */
  export function topLine(): number | null {
    if (!scroller?.clientHeight || !container || rendering) return null;
    return lineForOffset(anchors(), scroller.scrollTop);
  }
  /** Put a source line at the top of the viewport, once the render settles. */
  export function scrollToLine(line: number) {
    pendingLine = line;
    if (!rendering) applyPendingLine();
  }
  function applyPendingLine() {
    if (pendingLine === null || !scroller?.clientHeight || !container) return;
    const line = pendingLine;
    pendingLine = null;
    scroller.scrollTop = offsetForLine(anchors(), line);
  }

  async function renderPreview(text: string, raw: boolean, palette: 'dark' | 'light', ticket: number, identity: number, math: MathMode) {
    if (!container || ticket !== generation) return;
    const reduced = !raw && reducedFormatting(text).reduced;
    if (reduced) {
      // Rendering the full document would duplicate the expensive parse the
      // editor is already avoiding. Show the exact source instead, so no text
      // is hidden or rewritten, and say why the preview is plain.
      clearRenderedContent(container);
      container.textContent = '';
      const notice = document.createElement('p');
      notice.className = 'preview-reduced-notice';
      notice.setAttribute('role', 'status');
      notice.textContent = 'Reduced formatting — text unchanged. This document is large or punctuation-heavy, so the preview shows its Markdown source.';
      const source = document.createElement('pre');
      source.className = 'preview-reduced-source';
      source.textContent = text;
      container.append(notice, source);
      rendering = false;
      applyPendingLine();
      return;
    }
    const result = raw ? {
      html: '<div class="diagram" data-diagram="0"><span class="diagram-loading">Rendering diagram…</span></div>',
      tasks: [], maths: [], diagrams: [text], callouts: [], links: [], frontmatter: null,
    } : renderMarkdown(text);
    if (ticket !== generation) return;
    const before = blockKeys(identity);
    await renderContent(container, result, {
      theme: palette, folds, current: () => ticket === generation, mathMode: resolveMathMode(text, math),
      toggle: (task) => onToggleTask({ task, snapshot: text }), edit: onEditSource, openWiki: onOpenWiki, editProperties: onEditProperties, sourcePath, loadEmbed, cells, openPath: onOpenPath, embedTrail: sourcePath ? [sourcePath + "#"] : [],
    });
    if (ticket === generation) { rendering = false; applyPendingLine(); fadeChangedBlocks(before, identity); }
  }

  // After an edit only the blocks whose content changed fade back in, so the
  // debounced re-render does not read as a flicker. Skipped entirely with
  // reduced motion, on document switches and for large changes.
  const BLOCK_LIMIT = 600, CHANGE_LIMIT = 6;
  let renderedIdentity: number | null = null;
  const blockKey = (block: Element) => block.tagName + '\u0000' + block.textContent;
  function blockKeys(identity: number): Set<string> | null {
    if (!motionMs('fast') || renderedIdentity !== identity || container.childElementCount > BLOCK_LIMIT) return null;
    return new Set(Array.from(container.children, blockKey));
  }
  function fadeChangedBlocks(before: Set<string> | null, identity: number) {
    renderedIdentity = identity;
    const duration = motionMs('fast');
    if (!before || !duration) return;
    const changed = Array.from(container.children).filter((block) => !before.has(blockKey(block)));
    if (!changed.length || changed.length > CHANGE_LIMIT) return;
    for (const block of changed) block.animate([{ opacity: .6 }, { opacity: 1 }], { duration, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  }

  $effect(() => {
    const identity = documentId;
    const text = content;
    const raw = standalone;
    const palette = theme;
    const math = mathMode;
    const ticket = ++generation;
    rendering = true;
    // Pending previews contain offsets from the previous document. Keep them
    // noninteractive until the debounced render installs current source spans.
    for (const input of container?.querySelectorAll<HTMLInputElement>('input.task-checkbox') ?? []) input.disabled = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      queue = queue.catch(() => {}).then(() => renderPreview(text, raw, palette, ticket, identity, math)).catch((error: unknown) => {
        if (ticket !== generation || !container) return;
        container.textContent = `Preview error: ${error instanceof Error ? error.message : String(error)}`;
        rendering = false;
        // Never apply an anchor from before the failure to a later render.
        pendingLine = null;
      });
    }, 180);
  });

  onDestroy(() => { clearTimeout(timer); generation++; if(container)clearRenderedContent(container); });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable preview needs keyboard access.) -->
<div class="preview-scroll" role="region" aria-label="Document preview" aria-busy={rendering} tabindex="0" bind:this={scroller}>
  <div class="markdown-body" bind:this={container}></div>
</div>
