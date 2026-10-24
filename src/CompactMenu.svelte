<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { CommandId } from './shortcuts';
  import type { CommandItem } from './ui-commands';
  import Icon from './Icon.svelte';
  import { commandIcon } from './icons';
  import type { IconTheme } from './icons';

  let { label, text, items, execute, open = $bindable(false), radio = false, theme }: { label: string; text: string; items: CommandItem[]; execute: (id: CommandId) => void; open?: boolean; radio?: boolean; theme: IconTheme } = $props();
  let host: HTMLDivElement, trigger: HTMLButtonElement;
  let branded = $derived(label === 'App menu');
  $effect(() => { const showing = open; if (showing) queueMicrotask(() => host?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus()); });
  function choose(item: CommandItem) { if (item.disabled) return; open = false; trigger.focus(); execute(item.id); }
  function keyboard(event: KeyboardEvent) {
    const controls = Array.from(host.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)'));
    const at = controls.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = at < 0 ? (event.key === 'ArrowDown' ? 0 : controls.length - 1) : (at + (event.key === 'ArrowDown' ? 1 : controls.length - 1)) % controls.length;
      controls[next]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); controls[event.key === 'Home' ? 0 : controls.length - 1]?.focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); open = false; trigger.focus(); }
    else if (event.key === 'Tab') { open = false; trigger.focus(); }
  }
  function outside(event: PointerEvent) { if (open && !host.contains(event.target as Node)) open = false; }
  onMount(() => document.addEventListener('pointerdown', outside, true));
  onDestroy(() => document.removeEventListener('pointerdown', outside, true));
</script>
<div class="compact-menu-host" bind:this={host}>
  <button class="compact-menu-trigger" class:brand-trigger={branded} bind:this={trigger} aria-label={label} aria-haspopup="menu" aria-expanded={open} onclick={() => open = !open}>
    {#if branded}<Icon name="mark" size={18} {theme} />{:else}<span class="compact-menu-label">{text}</span><Icon name="chevron" size={14} {theme} />{/if}
  </button>
  {#if open}<div class="compact-menu" class:app-menu={branded} role="menu" aria-label={label} tabindex="-1" onkeydown={keyboard}>
    {#if branded}<div class="compact-menu-brand"><Icon name="mark" size={18} {theme} /><strong>Notation</strong></div>{/if}
    {#each items as item, index (item.id)}
      {#if index === 0 || items[index - 1].group !== item.group}<div class="menu-group">{item.group}</div>{/if}
      <button role={radio ? 'menuitemradio' : item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-label={item.label} aria-checked={radio || item.checked !== undefined ? !!item.checked : undefined} disabled={item.disabled} onclick={() => choose(item)}>
        <span class="menu-item-label">{#if branded}<Icon name={commandIcon(item.id)} size={18} {theme} />{/if}<span>{item.label}</span></span>
        <span class="menu-item-meta">{#if item.checked}<Icon name="check" size={12} {theme} />{/if}<kbd aria-hidden="true">{item.shortcut}</kbd></span>
      </button>
    {/each}
  </div>{/if}
</div>
