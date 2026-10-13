<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { CommandId } from './shortcuts';
  import type { CommandItem } from './ui-commands';
  let { label, text, items, execute, open = $bindable(false), radio = false }: { label: string; text: string; items: CommandItem[]; execute: (id: CommandId) => void; open?: boolean; radio?: boolean } = $props();
  let host: HTMLDivElement, trigger: HTMLButtonElement;
  $effect(() => { const showing = open; if (showing) queueMicrotask(() => host?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus()); });
  function choose(item: CommandItem) { if (item.disabled) return; open = false; trigger.focus(); execute(item.id); }
  function keyboard(event: KeyboardEvent) {
    const controls = Array.from(host.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)'));
    const at = controls.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); controls[(at + (event.key === 'ArrowDown' ? 1 : controls.length - 1)) % controls.length]?.focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); open = false; trigger.focus(); }
    else if (event.key === 'Tab') { open = false; trigger.focus(); }
  }
  function outside(event: PointerEvent) { if (open && !host.contains(event.target as Node)) open = false; }
  onMount(() => document.addEventListener('pointerdown', outside, true));
  onDestroy(() => document.removeEventListener('pointerdown', outside, true));
</script>
<div class="compact-menu-host" bind:this={host}>
  <button class="compact-menu-trigger" bind:this={trigger} aria-label={label} aria-haspopup="menu" aria-expanded={open} onclick={() => open = !open}>{text}</button>
  {#if open}<div class="compact-menu" role="menu" aria-label={label} tabindex="-1" onkeydown={keyboard}>
    {#each items as item, index (item.id)}
      {#if index === 0 || items[index - 1].group !== item.group}<div class="menu-group">{item.group}</div>{/if}
      <button role={radio ? 'menuitemradio' : item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-label={item.label} aria-checked={radio || item.checked !== undefined ? !!item.checked : undefined} disabled={item.disabled} onclick={() => choose(item)}><span>{item.checked ? '✓ ' : ''}{item.label}</span><kbd aria-hidden="true">{item.shortcut}</kbd></button>
    {/each}
  </div>{/if}
</div>
