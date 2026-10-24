<script lang="ts">
  import type { CommandId } from './shortcuts';
  import type { CommandItem } from './ui-commands';
  import Icon from './Icon.svelte';
  import { commandIcon } from './icons';
  import type { IconTheme } from './icons';

  let { items, execute, theme }: { items: CommandItem[]; execute: (id: CommandId) => void; theme: IconTheme } = $props();
  let navigation: HTMLElement;
  function navigate(event: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...navigation.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
    buttons[next]?.focus();
  }
</script>

<nav class="app-navigation" aria-label="App sidebar" bind:this={navigation}>
  <div class="sidebar-tools">
    {#each items.filter(item => item.id !== 'app.settings') as item (item.id)}
      {#if item.id === 'panel.git'}<div class="sidebar-divider" aria-hidden="true"></div>{/if}
      <button class="sidebar-button" aria-label={item.label + ' panel'} aria-pressed={item.checked === true} disabled={item.disabled} title={item.label + (item.shortcut ? ' · ' + item.shortcut : '')} onclick={() => execute(item.id)} onkeydown={navigate}>
        <Icon name={commandIcon(item.id)} size={18} {theme} />
      </button>
    {/each}
  </div>
  <div class="sidebar-footer">
    <button class="sidebar-button" aria-label="Open settings" title="Settings" onclick={() => execute('app.settings')} onkeydown={navigate}>
      <Icon name="settings" size={18} {theme} />
    </button>
  </div>
</nav>
