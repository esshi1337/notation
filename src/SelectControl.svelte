<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconTheme } from './icons';

  type SelectOption = { value: string; label: string; hint?: string; disabled?: boolean };
  let { label, options, value, onchange, theme, disabled = false, placeholder = 'Select…' }: {
    label: string;
    options: readonly SelectOption[];
    value: string;
    onchange: (value: string) => void;
    theme: IconTheme;
    disabled?: boolean;
    placeholder?: string;
  } = $props();

  const instanceId = $props.id();
  const labelId = `${instanceId}-label`;
  const listId = `${instanceId}-listbox`;
  let trigger: HTMLButtonElement;
  let list = $state<HTMLDivElement>();
  let open = $state(false);
  let activeIndex = $state(-1);
  let listStyle = $state('left:8px;top:8px;max-height:240px;visibility:hidden');
  let search = '';
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let selectedIndex = $derived(options.findIndex((option) => option.value === value));
  let selected = $derived(selectedIndex >= 0 ? options[selectedIndex] : undefined);
  let activeOption = $derived(options[activeIndex]);

  function optionId(index: number) { return `${instanceId}-option-${index}`; }
  function firstEnabled() { return options.findIndex((option) => !option.disabled); }
  function initialIndex() {
    return selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : firstEnabled();
  }
  function revealActive() {
    const option = list?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`);
    if (!option || !list) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }
  function placeList() {
    if (!open || !trigger || !list) return;
    const rect = trigger.getBoundingClientRect();
    const dialogRect = trigger.closest('dialog')?.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const viewportLeft = window.visualViewport?.offsetLeft ?? 0;
    const viewportTop = window.visualViewport?.offsetTop ?? 0;
    const topBound = Math.max(viewportTop + 8, dialogRect ? dialogRect.top + 8 : viewportTop + 8);
    const leftBound = Math.max(viewportLeft + 8, dialogRect ? dialogRect.left + 8 : viewportLeft + 8);
    const bottomBound = Math.min(viewportTop + viewportHeight - 8, dialogRect ? dialogRect.bottom - 8 : viewportTop + viewportHeight - 8);
    const rightBound = Math.min(viewportLeft + viewportWidth - 8, dialogRect ? dialogRect.right - 8 : viewportLeft + viewportWidth - 8);
    const availableWidth = Math.max(1, rightBound - leftBound);
    const width = Math.min(Math.max(120, rect.width), availableWidth);
    const left = Math.min(Math.max(rect.left, leftBound), Math.max(leftBound, rightBound - width));
    const desiredHeight = Math.min(Math.max(list.scrollHeight, 36), 240);
    const below = Math.max(0, bottomBound - rect.bottom - 4);
    const above = Math.max(0, rect.top - topBound - 4);
    const showAbove = below < Math.min(desiredHeight, 160) && above > below;
    const availableHeight = Math.max(1, Math.min(240, showAbove ? above : below));
    const height = Math.min(desiredHeight, availableHeight);
    const top = showAbove
      ? Math.max(topBound, rect.top - 4 - height)
      : Math.min(rect.bottom + 4, Math.max(topBound, bottomBound - height));
    listStyle = `left:${left}px;top:${top}px;width:${width}px;max-height:${availableHeight}px;visibility:visible;--pop-shift:${showAbove ? 4 : -4}px`;
  }
  function closeList(restoreFocus = false) {
    if (!open) return;
    open = false;
    listStyle = 'left:8px;top:8px;max-height:240px;visibility:hidden';
    search = '';
    if (searchTimer) clearTimeout(searchTimer);
    if (restoreFocus) {
      const target = trigger;
      queueMicrotask(() => { if (target?.isConnected) target.focus(); });
    }
  }
  function openList(index = initialIndex()) {
    if (disabled || !options.length) return;
    activeIndex = index;
    listStyle = 'left:8px;top:8px;max-height:240px;visibility:hidden';
    open = true;
    // Keys for the open list are handled on the button, so it must hold focus
    // even where a click does not focus buttons (macOS WebKit).
    if (document.activeElement !== trigger && !list?.contains(document.activeElement)) trigger?.focus({ preventScroll: true });
    void tick().then(() => { placeList(); revealActive(); });
  }
  function moveActive(direction: number) {
    if (!open) { openList(); return; }
    let next = activeIndex;
    for (let visited = 0; visited < options.length; visited++) {
      next = (next + direction + options.length) % options.length;
      if (!options[next]?.disabled) {
        activeIndex = next;
        revealActive();
        return;
      }
    }
  }
  function edgeActive(end: boolean) {
    if (!open) openList();
    const enabled = options.map((option, index) => ({ option, index })).filter(({ option }) => !option.disabled);
    const target = end ? enabled[enabled.length - 1] : enabled[0];
    if (!target) return;
    activeIndex = target.index;
    void tick().then(revealActive);
  }
  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onchange(option.value);
    closeList(true);
  }
  function typeahead(key: string) {
    if (!open) openList();
    const character = key.toLocaleLowerCase();
    search = search === character ? character : search + character;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { search = ''; }, 600);
    const start = activeIndex >= 0 ? activeIndex + (search.length === 1 ? 1 : 0) : 0;
    for (let offset = 0; offset < options.length; offset++) {
      const index = (start + offset) % options.length;
      const option = options[index];
      if (!option.disabled && option.label.toLocaleLowerCase().startsWith(search)) {
        activeIndex = index;
        void tick().then(revealActive);
        return;
      }
    }
  }
  function keydown(event: KeyboardEvent) {
    if (disabled) return;
    if (event.key === 'Tab') { closeList(); return; }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      closeList(true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      edgeActive(event.key === 'End');
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(activeIndex); else openList();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      typeahead(event.key);
    }
  }

  $effect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !trigger.contains(target) && !list?.contains(target)) closeList();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', placeList);
    window.visualViewport?.addEventListener('resize', placeList);
    document.addEventListener('scroll', placeList, true);
    placeList();
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', placeList);
      window.visualViewport?.removeEventListener('resize', placeList);
      document.removeEventListener('scroll', placeList, true);
    };
  });
  onDestroy(() => { if (searchTimer) clearTimeout(searchTimer); });
</script>

<div class="settings-field settings-select-field">
  <span class="settings-field-label" id={labelId}>{label}</span>
  <div class="select-control">
    <button
      bind:this={trigger}
      type="button"
      class="select-trigger"
      class:select-open={open}
      role="combobox"
      aria-label={label}
      aria-expanded={open}
      aria-controls={listId}
      aria-haspopup="listbox"
      aria-activedescendant={open && activeOption ? optionId(activeIndex) : undefined}
      aria-disabled={disabled || undefined}
      {disabled}
      onclick={() => open ? closeList(true) : openList()}
      onkeydown={keydown}
    >
      <span class="select-value" class:select-placeholder={!selected}>{selected?.label ?? placeholder}</span>
      {#if selected?.hint}<span class="select-value-hint">{selected.hint}</span>{/if}
      <span class="select-chevron" aria-hidden="true"><Icon name="chevron" size={14} {theme} /></span>
    </button>
    {#if open}
      <div bind:this={list} class="select-listbox" id={listId} role="listbox" aria-labelledby={labelId} style={listStyle}>
        {#each options as option, index}
          <div
            id={optionId(index)}
            class="select-option"
            class:select-active={index === activeIndex}
            class:select-selected={option.value === value}
            role="option"
            aria-selected={option.value === value}
            aria-disabled={option.disabled || undefined}
            data-option-index={index}
            tabindex="-1"
            onmousemove={() => { if (!option.disabled) activeIndex = index; }}
            onmousedown={(event) => event.preventDefault()}
            onclick={() => choose(index)}
            onkeydown={keydown}
          >
            <span class="select-option-label">{option.label}</span>
            {#if option.hint}<span class="select-option-hint">{option.hint}</span>{/if}
            {#if option.value === value}<span class="select-option-check" aria-hidden="true"><Icon name="check" size={12} {theme} /></span>{/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
