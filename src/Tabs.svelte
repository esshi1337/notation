<script lang="ts">
  import { tabDirty } from './documents';
  import type { DocumentTab } from './documents';
  import Icon from './Icon.svelte';
  import type { IconTheme } from './icons';

  let { documents, activeId, select, close, create, rename, theme }: { documents: DocumentTab[]; activeId: string; select: (id: string) => void; close: (id: string) => void; create: () => void; rename?: (id: string) => void; theme: IconTheme } = $props();
  let host: HTMLDivElement;
  const tabElement = (id: string) => Array.from(host?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? []).find((element) => element.dataset.tabId === id);
  $effect(() => { const selected = activeId; queueMicrotask(() => tabElement(selected)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })); });
  function navigate(event: KeyboardEvent, index: number) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const id = documents[(index + (event.key === 'ArrowRight' ? 1 : documents.length - 1)) % documents.length].id;
    select(id); queueMicrotask(() => tabElement(id)?.focus());
  }
</script>

<div class="document-tabs-wrap">
  <div class="document-tabs" role="tablist" aria-label="Documents" bind:this={host}>
    {#each documents as document, index (document.id)}
      <div class="document-tab" class:active={document.id === activeId}>
        <button role="tab" data-tab-id={document.id} aria-selected={document.id === activeId} aria-label={document.name} tabindex={document.id === activeId ? 0 : -1} onclick={() => select(document.id)} ondblclick={() => rename?.(document.id)} onkeydown={(event) => navigate(event, index)} title={document.path || document.name}>
          <Icon name="file" size={14} {theme} />
          {#if tabDirty(document)}<span class="tab-dirty" aria-label={'Unsaved changes: ' + document.name}>•</span>{/if}
          <span class="tab-label">{document.name}</span>
        </button>
        <button class="tab-close" aria-label={'Close tab: ' + document.name} onclick={() => close(document.id)}><Icon name="close" size={12} {theme} /></button>
      </div>
    {/each}
  </div>
  <button class="new-tab-button" aria-label="New document" title="New document" onclick={create}><Icon name="plus" size={18} {theme} /></button>
</div>
