<script lang="ts">
  import { onDestroy } from 'svelte';
  import { renderMarkdown } from './render-markdown';
  import type { CellSession } from './cells';
  import { renderContent, clearRenderedContent } from './render-content';
  import type { EmbedDocument } from './render-content';
  import type { TaskToggle } from './markdown-features';

  let { documentId, content, standalone, theme, folds, onToggleTask, onEditSource, onOpenWiki, onEditProperties, sourcePath, loadEmbed, onOpenPath, cells }: { documentId: number; content: string; standalone: boolean; theme: 'dark' | 'light'; folds: Map<string, boolean>; onToggleTask: (request: TaskToggle) => boolean; onEditSource: (from: number) => void; onOpenWiki?: (target: string, sourcePath?: string) => void; onEditProperties?: () => void; sourcePath?: string; loadEmbed?: (target: string, sourcePath?: string) => Promise<EmbedDocument>; onOpenPath?: (path: string) => void; cells?: CellSession } = $props();
  let container: HTMLDivElement;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout>;
  let queue: Promise<void> = Promise.resolve();
  let rendering = $state(false);

  async function renderPreview(text: string, raw: boolean, palette: 'dark' | 'light', ticket: number) {
    if (!container || ticket !== generation) return;
    const result = raw ? {
      html: '<div class="diagram" data-diagram="0"><span class="diagram-loading">Rendering diagram…</span></div>',
      tasks: [], maths: [], diagrams: [text], callouts: [], links: [], frontmatter: null,
    } : renderMarkdown(text);
    if (ticket !== generation) return;
    await renderContent(container, result, {
      theme: palette, folds, current: () => ticket === generation,
      toggle: (task) => onToggleTask({ task, snapshot: text }), edit: onEditSource, openWiki: onOpenWiki, editProperties: onEditProperties, sourcePath, loadEmbed, cells, openPath: onOpenPath, embedTrail: sourcePath ? [sourcePath + "#"] : [],
    });
    if (ticket === generation) rendering = false;
  }

  $effect(() => {
    const identity = documentId;
    const text = content;
    const raw = standalone;
    const palette = theme;
    const ticket = ++generation;
    rendering = true;
    // Pending previews contain offsets from the previous document. Keep them
    // noninteractive until the debounced render installs current source spans.
    for (const input of container?.querySelectorAll<HTMLInputElement>('input.task-checkbox') ?? []) input.disabled = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      queue = queue.catch(() => {}).then(() => renderPreview(text, raw, palette, ticket)).catch((error: unknown) => {
        if (ticket !== generation || !container) return;
        container.textContent = `Preview error: ${error instanceof Error ? error.message : String(error)}`;
        rendering = false;
      });
    }, 180);
  });

  onDestroy(() => { clearTimeout(timer); generation++; if(container)clearRenderedContent(container); });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable preview needs keyboard access.) -->
<div class="preview-scroll" role="region" aria-label="Document preview" aria-busy={rendering} tabindex="0">
  <div class="markdown-body" bind:this={container}></div>
</div>
