<script lang="ts">
  import { onMount } from 'svelte';
  import { clearRenderedContent } from './render-content';
  // `paused` keeps what is already rendered but starts no new render: a board
  // zoomed far out shows placeholders, and must not render every card it passes.
  let { markdown, sourcePath, render, paused = false }: { markdown: string; sourcePath?: string; render?: (host: HTMLElement, markdown: string, sourcePath?: string, current?: () => boolean) => Promise<void>; paused?: boolean } = $props();
  let host: HTMLDivElement;
  let visible = $state(false), error = $state('');
  let generation = 0, rendered: { text: string; path: string | undefined; renderer: typeof render } | null = null;
  onMount(() => { const observer = new IntersectionObserver((entries) => visible = entries.some((entry) => entry.isIntersecting)); observer.observe(host); return () => { observer.disconnect(); generation++; clearRenderedContent(host); }; });
  $effect(() => {
    const text = markdown, path = sourcePath, renderer = render, shown = visible && !paused;
    if (!host || !shown) return;
    // Coming back into view, or back from a placeholder, with nothing changed costs nothing.
    if (rendered && rendered.text === text && rendered.path === path && rendered.renderer === renderer) return;
    const ticket = ++generation;
    error = '';
    rendered = { text, path, renderer };
    if (!renderer) { host.textContent = text; return; }
    void renderer(host, text, path, () => generation === ticket && host.isConnected).catch((cause) => { if (generation === ticket) { error = String(cause); rendered = null; } });
  });
</script>
<div class="canvas-card-render" bind:this={host}></div>
{#if error}<div role="alert" class="canvas-card-error">{error}</div>{/if}
<style>.canvas-card-render{padding:10px;overflow:auto;height:100%;font-size:12px;line-height:1.5;white-space:pre-wrap}.canvas-card-render :global(p){margin:.4em 0}.canvas-card-render :global(img),.canvas-card-render :global(svg){max-width:100%}.canvas-card-render :global(pre){font-size:11px}.canvas-card-error{font-size:12px;padding:8px;color:var(--error)}</style>
