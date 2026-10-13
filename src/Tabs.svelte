<script lang="ts">
  import { tabDirty } from './documents';
  import type { DocumentTab } from './documents';
  let { documents, activeId, select, close, rename }: { documents: DocumentTab[]; activeId: string; select: (id: string) => void; close: (id: string) => void; rename?: (id: string) => void } = $props();
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

<div class="document-tabs" role="tablist" aria-label="Documents" bind:this={host}>
  {#each documents as document, index (document.id)}
    <div class="document-tab" class:active={document.id === activeId}>
      <button role="tab" data-tab-id={document.id} aria-selected={document.id === activeId} aria-label={document.name} tabindex={document.id === activeId ? 0 : -1} onclick={() => select(document.id)} ondblclick={() => rename?.(document.id)} onkeydown={(event) => navigate(event, index)} title={document.path || document.name}>{#if tabDirty(document)}<span class="tab-dirty" aria-label={'Unsaved changes: ' + document.name}>•</span>{/if}{document.name}</button>
      <button class="tab-close" aria-label={'Close tab: ' + document.name} onclick={() => close(document.id)}>×</button>
    </div>
  {/each}
</div>
