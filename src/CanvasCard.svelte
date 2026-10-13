<script lang="ts">
  import { onMount } from 'svelte';
  import { clearRenderedContent } from './render-content';
  let { markdown, sourcePath, render }: { markdown: string; sourcePath?: string; render?: (host: HTMLElement, markdown: string, sourcePath?: string, current?: () => boolean) => Promise<void> } = $props();
  let host: HTMLDivElement;
  let visible = $state(false), error = $state('');
  let generation = 0;
  onMount(() => { const observer = new IntersectionObserver((entries) => visible = entries.some((entry) => entry.isIntersecting)); observer.observe(host); return () => { observer.disconnect(); generation++; clearRenderedContent(host); }; });
  $effect(() => {
    const text = markdown, path = sourcePath, renderer = render, shown = visible, ticket = ++generation;
    if (!host || !shown) return;
    error = '';
    if (!renderer) { host.textContent = text; return; }
    void renderer(host, text, path, () => generation === ticket && host.isConnected).catch((cause) => { if (generation === ticket) error = String(cause); });
  });
</script>
<div class="canvas-card-render" bind:this={host}></div>
{#if error}<div role="alert" class="canvas-card-error">{error}</div>{/if}
<style>.canvas-card-render{padding:10px;overflow:auto;height:100%;font-size:12px;line-height:1.5;white-space:pre-wrap}.canvas-card-render :global(p){margin:.4em 0}.canvas-card-render :global(img),.canvas-card-render :global(svg){max-width:100%}.canvas-card-render :global(pre){font-size:10px}.canvas-card-error{font-size:11px;padding:8px;color:var(--error)}</style>
