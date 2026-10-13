<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { CommandId } from './shortcuts';
  import type { CommandItem } from './ui-commands';
  let { commands, execute, close }: { commands: CommandItem[]; execute: (id: CommandId) => void; close: () => void } = $props();
  let query = $state(''), selected = $state(0);
  let dialog: HTMLDialogElement, search: HTMLInputElement, results: HTMLDivElement;
  let previous: HTMLElement | null = null;
  let matches = $derived(commands.filter((command) => query.toLowerCase().trim().split(/\s+/u).every((word) => (command.label + ' ' + command.group).toLowerCase().includes(word))));
  $effect(() => { const changed = query; selected = 0; });
  $effect(() => { const current = selected; queueMicrotask(() => results?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })); });
  function choose(command: CommandItem | undefined) {
    if (!command || command.disabled) return;
    dialog.close(); close(); execute(command.id);
  }
  function keyboard(event: KeyboardEvent) {
    if (event.target === search && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      if (matches.length) selected = (selected + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
    } else if (event.key === 'Enter' && event.target === search) { event.preventDefault(); choose(matches[selected]); }
    else if (event.key === 'Tab') {
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button, input')).filter((element) => element.tabIndex >= 0 && !element.hasAttribute('disabled'));
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    }
  }
  onMount(() => { previous = document.activeElement as HTMLElement; dialog.showModal(); search.focus(); });
  onDestroy(() => { if (dialog?.open) dialog.close(); if (previous?.isConnected) previous.focus(); });
</script>

<dialog class="command-palette" aria-label="Commands" bind:this={dialog} onkeydown={keyboard} oncancel={(event) => { event.preventDefault(); close(); }}>
  <span id="command-enabled" hidden>Enabled</span>
  <div class="palette-heading"><span>Commands</span><button aria-label="Close commands" onclick={close}>Esc</button></div>
  <input bind:this={search} class="command-search" aria-label="Search commands" placeholder="Type a command…" bind:value={query} autocomplete="off" spellcheck="false" aria-controls="command-results" aria-activedescendant={matches[selected] ? 'command-' + matches[selected].id : undefined} />
  <div id="command-results" class="command-results" role="listbox" aria-label="Commands" bind:this={results}>
    {#each matches as command, index (command.id)}
      {#if index === 0 || matches[index - 1].group !== command.group}<div class="command-group">{command.group}</div>{/if}
      <button id={'command-' + command.id} role="option" aria-label={command.label} aria-describedby={command.checked ? 'command-enabled' : undefined} aria-selected={index === selected} disabled={command.disabled} tabindex="-1" onclick={() => choose(command)} onpointermove={() => selected = index}><span>{#if command.checked}<span aria-hidden="true">✓ </span>{/if}{command.label}</span><kbd aria-hidden="true">{command.shortcut}</kbd></button>
    {/each}
    {#if !matches.length}<p class="command-empty">No matching commands.</p>{/if}
  </div>
</dialog>
