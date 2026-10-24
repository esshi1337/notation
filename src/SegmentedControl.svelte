<script lang="ts">
  import { tick } from 'svelte';

  type SegmentOption = { value: string; label: string; disabled?: boolean };
  let { label, options, value, onchange, disabled = false }: {
    label: string;
    options: readonly SegmentOption[];
    value: string;
    onchange: (value: string) => void;
    disabled?: boolean;
  } = $props();

  const instanceId = $props.id();
  const labelId = `${instanceId}-label`;
  let root: HTMLDivElement;
  let selectedIndex = $derived(options.findIndex((option) => option.value === value));
  let tabStopIndex = $derived(selectedIndex >= 0 && !options[selectedIndex]?.disabled
    ? selectedIndex
    : options.findIndex((option) => !option.disabled));

  function activate(index: number) {
    if (disabled || options[index]?.disabled) return;
    onchange(options[index].value);
  }

  async function move(index: number, focus = true) {
    activate(index);
    if (focus) {
      await tick();
      root.querySelector<HTMLButtonElement>(`[data-segment-index="${index}"]`)?.focus();
    }
  }

  function keydown(event: KeyboardEvent, index: number) {
    if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home' || event.key === 'End') {
      const candidates = options.map((option, optionIndex) => ({ option, optionIndex })).filter(({ option }) => !option.disabled);
      const target = event.key === 'Home' ? candidates[0] : candidates[candidates.length - 1];
      if (target) void move(target.optionIndex);
      return;
    }
    const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
    let next = index;
    for (let visited = 0; visited < options.length; visited++) {
      next = (next + direction + options.length) % options.length;
      if (!options[next]?.disabled) { void move(next); return; }
    }
  }
</script>

<div class="settings-field settings-segmented-field" bind:this={root}>
  <span class="settings-field-label" id={labelId}>{label}</span>
  <div class="segmented-control" role="radiogroup" aria-labelledby={labelId} aria-disabled={disabled || undefined}>
    {#each options as option, index}
      <button
        type="button"
        role="radio"
        aria-checked={value === option.value}
        tabindex={index === tabStopIndex ? 0 : -1}
        disabled={disabled || option.disabled}
        data-segment-index={index}
        onclick={() => activate(index)}
        onkeydown={(event) => keydown(event, index)}
      >{option.label}</button>
    {/each}
  </div>
</div>
