<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconTheme } from './icons';
  import { pop } from './motion';

  // While a switch is in progress the button is aria-disabled rather than
  // disabled, so it keeps keyboard focus (WebKit blurs a disabled button).
  // A themed replacement for the native workspace <select>: a combobox button
  // with a listbox popup. Focus stays on the button; the highlighted option is
  // exposed through aria-activedescendant.
  type Workspace = { id: string; name: string };
  let { workspaces, value, onchange, theme, disabled = false }: { workspaces: readonly Workspace[]; value: string; onchange: (id: string) => void; theme: IconTheme; disabled?: boolean } = $props();

  const instanceId = $props.id();
  const listId = `${instanceId}-list`;
  const optionId = (index: number) => `${instanceId}-option-${index}`;
  let host: HTMLDivElement, trigger: HTMLButtonElement;
  let list = $state<HTMLDivElement>();
  let open = $state(false);
  let activeIndex = $state(-1);
  let typed = '';
  let typedTimer: ReturnType<typeof setTimeout> | undefined;
  let selectedIndex = $derived(workspaces.findIndex((workspace) => workspace.id === value));
  let selected = $derived(workspaces[selectedIndex]);

  function reveal() { queueMicrotask(() => list?.querySelector<HTMLElement>('.workspace-option.active')?.scrollIntoView({ block: 'nearest' })); }
  function show(index = Math.max(0, selectedIndex)) { if (disabled || !workspaces.length) return; activeIndex = index; open = true; reveal(); }
  function hide(focus = false) { if (!open) return; open = false; typed = ''; clearTimeout(typedTimer); if (focus) trigger.focus(); }
  function choose(index: number) {
    const workspace = workspaces[index];
    hide(true);
    if (workspace && workspace.id !== value) onchange(workspace.id);
  }
  function move(index: number) { activeIndex = (index + workspaces.length) % workspaces.length; reveal(); }
  function typeahead(key: string) {
    clearTimeout(typedTimer);
    typed += key.toLowerCase();
    typedTimer = setTimeout(() => { typed = ''; }, 600);
    // A repeated single letter cycles through names that start with it.
    const cycling = [...typed].every((letter) => letter === typed[0]);
    const term = cycling ? typed[0] : typed;
    const start = open ? activeIndex + (cycling ? 1 : 0) : 0;
    for (let offset = 0; offset < workspaces.length; offset++) {
      const index = (start + offset) % workspaces.length;
      if (workspaces[index].name.toLowerCase().startsWith(term)) { if (open) move(index); else show(index); return; }
    }
  }
  function keydown(event: KeyboardEvent) {
    if (disabled || event.ctrlKey || event.metaKey || event.altKey) return;
    const { key } = event;
    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') { event.preventDefault(); show(); }
      else if (key.length === 1 && key !== ' ') { event.preventDefault(); typeahead(key); }
      return;
    }
    if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(true); }
    else if (key === 'Tab') hide();
    else if (key === 'ArrowDown') { event.preventDefault(); move(activeIndex + 1); }
    else if (key === 'ArrowUp') { event.preventDefault(); move(activeIndex - 1); }
    else if (key === 'Home') { event.preventDefault(); move(0); }
    else if (key === 'End') { event.preventDefault(); move(workspaces.length - 1); }
    else if (key === 'Enter' || (key === ' ' && !typed)) { event.preventDefault(); choose(activeIndex); }
    else if (key.length === 1) { event.preventDefault(); typeahead(key); }
  }
  onMount(() => {
    const outside = (event: PointerEvent) => { if (open && !host.contains(event.target as Node)) hide(); };
    document.addEventListener('pointerdown', outside, true);
    return () => { document.removeEventListener('pointerdown', outside, true); clearTimeout(typedTimer); };
  });
  $effect(() => { if (disabled && open) hide(); });
</script>

<div class="workspace-switcher-host" bind:this={host}>
  <button type="button" class="workspace-switcher" bind:this={trigger} role="combobox" aria-label="Active workspace" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined} data-value={value} title={selected?.name} aria-disabled={disabled || undefined} onclick={() => open ? hide() : show()} onkeydown={keydown}>
    <span class="workspace-switcher-label">{selected?.name ?? 'Choose workspace'}</span>
  </button>
  {#if open}
    <div class="workspace-list" id={listId} role="listbox" aria-label="Workspaces" bind:this={list} in:pop out:pop={{ exit: true }}>
      {#each workspaces as workspace, index (workspace.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events (The combobox button handles keys; options follow aria-activedescendant.) -->
        <div class="workspace-option" class:active={index === activeIndex} id={optionId(index)} role="option" tabindex="-1" aria-selected={workspace.id === value} data-value={workspace.id} onpointermove={() => activeIndex = index} onpointerdown={(event) => event.preventDefault()} onclick={() => choose(index)}>
          <span class="workspace-option-label">{workspace.name}</span>
          {#if workspace.id === value}<Icon name="check" size={12} {theme} />{/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
