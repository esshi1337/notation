<script lang="ts">
  import type { CommandId } from './shortcuts';
  import type { CommandItem } from './ui-commands';

  let { items, execute }: { items: CommandItem[]; execute: (id: CommandId) => void } = $props();
  const icons: Partial<Record<CommandId, string>> = {
    'panel.explorer': 'M3 5h6l2 2h10v13H3z M3 5V3h6l2 2',
    'panel.workspace': 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    'panel.graph': 'M8 6h8 M6 8v8 M8 18h8 M18 8v8 M8 8l8 8 M4 4h4v4H4z M16 4h4v4h-4z M4 16h4v4H4z M16 16h4v4h-4z',
    'panel.git': 'M6 7v10 M8 17c8 0 10-4 10-10 M4 3h4v4H4z M4 17h4v4H4z M16 3h4v4h-4z',
    'panel.history': 'M3 11a9 9 0 1 1 2 7 M3 4v7h7 M12 7v6l4 2',
    'panel.properties': 'M4 5h16 M4 12h16 M4 19h16 M8 3v4 M16 10v4 M10 17v4',
    'panel.templates': 'M7 3h14v15 M3 7h14v14H3z M6 11h8 M6 15h5',
    'panel.table': 'M3 4h18v16H3z M3 9h18 M3 14h18 M9 4v16 M15 4v16',
    'panel.scripts': 'M3 4h18v16H3z M6 9l3 3-3 3 M12 15h5',
    'panel.export': 'M12 15V3 M8 7l4-4 4 4 M4 12v9h16v-9',
    'app.settings': 'M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2 M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  };
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
      <button class="sidebar-button" aria-label={item.label + ' panel'} aria-pressed={item.checked === true} disabled={item.disabled} title={item.label + (item.shortcut ? ' · ' + item.shortcut : '')} onclick={() => execute(item.id)} onkeydown={navigate}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d={icons[item.id]} /></svg>
      </button>
    {/each}
  </div>
  <div class="sidebar-footer">
    <button class="sidebar-button" aria-label="Open settings" title="Settings" onclick={() => execute('app.settings')} onkeydown={navigate}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d={icons['app.settings']} /></svg>
    </button>
  </div>
</nav>
