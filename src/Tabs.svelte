<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { tabDirty } from './documents';
  import type { DocumentTab } from './documents';
  import Icon from './Icon.svelte';
  import type { IconTheme } from './icons';
  import { collapseX, motionMs, pop } from './motion';
  import { tabContexts } from './tab-labels';

  let { documents, activeId, select, close, create, rename, theme }: { documents: DocumentTab[]; activeId: string; select: (id: string) => void; close: (id: string) => void; create: () => void; rename?: (id: string) => void; theme: IconTheme } = $props();
  let host: HTMLDivElement;
  let contexts = $derived(tabContexts(documents));
  // Which sides have tabs scrolled out of view; drives the edge fades.
  let fade = $state<'none' | 'start' | 'end' | 'both'>('none');
  // The active background is one element that slides between tabs.
  let indicator = $state({ x: 0, width: 0 });
  let sliding = $state(false);
  // Tabs not fully visible in the strip; listed in the overflow menu.
  let hiddenIds = $state<string[]>([]);
  let overflowOpen = $state(false);
  let overflowHost = $state<HTMLDivElement>();
  let overflowTrigger = $state<HTMLButtonElement>();
  let hiddenTabs = $derived(documents.filter((document) => hiddenIds.includes(document.id)));
  let slideTimer: ReturnType<typeof setTimeout> | undefined;
  const tabElement = (id: string) => Array.from(host?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? []).find((element) => element.dataset.tabId === id);
  function measure() {
    if (!host) return;
    const max = host.scrollWidth - host.clientWidth;
    const start = host.scrollLeft > 1, end = host.scrollLeft < max - 1;
    fade = start && end ? 'both' : start ? 'start' : end ? 'end' : 'none';
    const hostBox = host.getBoundingClientRect();
    const hidden: string[] = [];
    for (const button of host.querySelectorAll<HTMLElement>('[data-tab-id]')) {
      const item = button.parentElement!;
      if (item.inert) continue;
      const box = item.getBoundingClientRect();
      if (box.left < hostBox.left - 1 || box.right > hostBox.right + 1) hidden.push(button.dataset.tabId!);
    }
    if (hidden.length !== hiddenIds.length || hidden.some((id, index) => id !== hiddenIds[index])) hiddenIds = hidden;
    const tab = tabElement(activeId)?.parentElement;
    const next = tab && !tab.inert ? { x: tab.offsetLeft, width: tab.offsetWidth } : { x: 0, width: 0 };
    if (next.x !== indicator.x || next.width !== indicator.width) indicator = next;
  }
  function revealTab(id: string) {
    const tab = tabElement(id)?.parentElement;
    if (!host || !tab) return;
    const hostBox = host.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    const max = Math.max(0, host.scrollWidth - host.clientWidth);
    let next = host.scrollLeft;
    if (tabBox.left < hostBox.left) next -= hostBox.left - tabBox.left;
    else if (tabBox.right > hostBox.right) next += tabBox.right - hostBox.right;
    host.scrollLeft = Math.min(max, Math.max(0, next));
  }
  function wheel(event: WheelEvent) {
    if (!host || !event.cancelable || event.defaultPrevented || event.ctrlKey || event.metaKey) return;
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const rawDelta = horizontal ? event.deltaX : event.deltaY;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientWidth : 1;
    const delta = rawDelta * scale;
    if (!delta) return;
    const max = Math.max(0, host.scrollWidth - host.clientWidth);
    const next = Math.min(max, Math.max(0, host.scrollLeft + delta));
    if (next === host.scrollLeft) return;
    event.preventDefault();
    host.scrollLeft = next;
  }
  $effect(() => { const selected = activeId; if (documents.length) queueMicrotask(() => revealTab(selected)); });
  // Slide only when the selection changes; resizes and tab open/close track at once.
  let lastActive: string | null = null;
  $effect(() => {
    const selected = activeId;
    if (lastActive !== null && lastActive !== selected) {
      const duration = motionMs('base');
      clearTimeout(slideTimer);
      sliding = duration > 0;
      if (duration > 0) slideTimer = setTimeout(() => { sliding = false; }, duration + 40);
    }
    lastActive = selected;
  });
  onMount(() => {
    // Tab boxes change while tabs open, close or the window resizes; one
    // observer keeps the fades and the indicator in step.
    const observer = new ResizeObserver(() => { revealTab(activeId); measure(); });
    const watch = () => { observer.disconnect(); observer.observe(host); for (const tab of host.querySelectorAll('.document-tab')) observer.observe(tab); };
    const mutations = new MutationObserver(() => { watch(); measure(); });
    mutations.observe(host, { childList: true });
    watch(); measure();
    const outside = (event: PointerEvent) => { if (overflowOpen && !overflowHost?.contains(event.target as Node)) overflowOpen = false; };
    document.addEventListener('pointerdown', outside, true);
    return () => { observer.disconnect(); mutations.disconnect(); clearTimeout(slideTimer); document.removeEventListener('pointerdown', outside, true); };
  });
  $effect(() => { activeId; documents.length; void tick().then(measure); });
  // A closing tab stays in the DOM, inert, while it shrinks out. Its state is
  // frozen, so drop what would make it look or read like the current tab.
  function leave(tab: HTMLElement) { tab.setAttribute('aria-hidden', 'true'); tab.classList.remove('active'); }
  // A tab that returns before it has finished leaving (a workspace switch can
  // do this) reuses the same element, so undo what leave() changed.
  function enter(tab: HTMLElement, id: string) { tab.removeAttribute('aria-hidden'); tab.classList.toggle('active', id === activeId); }
  $effect(() => { if (!hiddenTabs.length) overflowOpen = false; });
  function chooseHidden(id: string) {
    overflowOpen = false;
    select(id);
    queueMicrotask(() => { revealTab(id); tabElement(id)?.focus({ preventScroll: true }); });
  }
  function overflowKey(event: KeyboardEvent) {
    const items = Array.from(overflowHost?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      items[at < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); items[event.key === 'Home' ? 0 : items.length - 1]?.focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); overflowOpen = false; overflowTrigger?.focus(); }
    else if (event.key === 'Tab') overflowOpen = false;
  }
  // Keyboard activation lands on the first hidden tab; a pointer-opened menu
  // takes focus on its container, like the header menus.
  function toggleOverflow(event: MouseEvent) {
    overflowOpen = !overflowOpen;
    if (!overflowOpen) return;
    const keyboard = event.detail === 0;
    queueMicrotask(() => overflowHost?.querySelector<HTMLElement>(keyboard ? '[role="menuitem"]' : '.tab-overflow-menu')?.focus());
  }
  function navigate(event: KeyboardEvent, index: number) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const id = documents[(index + (event.key === 'ArrowRight' ? 1 : documents.length - 1)) % documents.length].id;
    select(id); queueMicrotask(() => { tabElement(id)?.focus({ preventScroll: true }); revealTab(id); });
  }
</script>

<div class="document-tabs-wrap">
  <div class="document-tabs" class:has-indicator={indicator.width > 0} data-fade={fade} role="tablist" aria-label="Documents" bind:this={host} onwheel={wheel} onscroll={measure}>
    {#each documents as document, index (document.id)}
      <div class="document-tab" class:active={document.id === activeId} in:collapseX={{ gap: 4 }} out:collapseX={{ gap: 4, exit: true }} onintrostart={(event) => enter(event.currentTarget, document.id)} onoutrostart={(event) => leave(event.currentTarget)}>
        <button role="tab" data-tab-id={document.id} aria-selected={document.id === activeId} aria-label={document.name} tabindex={document.id === activeId ? 0 : -1} onclick={() => select(document.id)} ondblclick={() => rename?.(document.id)} onkeydown={(event) => navigate(event, index)} title={document.path || document.name}>
          <Icon name="file" size={14} {theme} />
          {#if tabDirty(document)}<span class="tab-dirty" aria-label={'Unsaved changes: ' + document.name} in:pop={{ token: 'fast', y: 0, scale: .4, origin: 'center' }} out:pop={{ token: 'fast', y: 0, scale: .4, origin: 'center', exit: true }}>•</span>{/if}
          <span class="tab-label">{document.name}</span>
          {#if contexts.get(document.id)}<span class="tab-context" aria-hidden="true">{contexts.get(document.id)}</span>{/if}
        </button>
        <button class="tab-close" aria-label={'Close tab: ' + document.name} onclick={() => close(document.id)}><Icon name="close" size={12} {theme} /></button>
      </div>
    {/each}
    <div class="tab-indicator" class:sliding aria-hidden="true" style={`transform:translateX(${indicator.x}px);width:${indicator.width}px`}></div>
  </div>
  {#if hiddenTabs.length}
    <div class="tab-overflow" bind:this={overflowHost}>
      <button class="tab-overflow-button" bind:this={overflowTrigger} aria-label={`Show ${hiddenTabs.length} hidden ${hiddenTabs.length === 1 ? 'tab' : 'tabs'}`} title="Tabs out of view" aria-haspopup="menu" aria-expanded={overflowOpen} onclick={toggleOverflow}><span aria-hidden="true">+{hiddenTabs.length}</span><Icon name="chevron" size={14} {theme} /></button>
      {#if overflowOpen}
        <div class="tab-overflow-menu" role="menu" aria-label="Hidden tabs" tabindex="-1" onkeydown={overflowKey} in:pop={{ origin: 'top right' }} out:pop={{ origin: 'top right', exit: true }}>
          {#each hiddenTabs as document (document.id)}
            <button role="menuitem" aria-label={document.name} title={document.path || document.name} onclick={() => chooseHidden(document.id)}>
              <Icon name="file" size={14} {theme} />
              {#if tabDirty(document)}<span class="tab-dirty" aria-hidden="true">•</span>{/if}
              <span class="tab-label">{document.name}</span>
              {#if contexts.get(document.id)}<span class="tab-context" aria-hidden="true">{contexts.get(document.id)}</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
  <button class="new-tab-button" aria-label="New document" title="New document" onclick={create}><Icon name="plus" size={18} {theme} /></button>
</div>
