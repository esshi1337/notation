<script lang="ts">
  import { iconSource } from './icons';
  import type { IconName, IconTheme } from './icons';

  let { name, size = 18, theme }: { name: IconName; size?: number; theme: IconTheme } = $props();
  let source = $derived(iconSource(name, size, theme));
  let height = $derived(name === 'mark' ? size * 15.27 / 18 : size);
  // Preserve the exported geometry while allowing inverted controls and
  // forced-colors mode to supply a contrasting foreground.
  let tinted = $derived(name === 'checkbox-check' || (name === 'save' && theme === 'light'));
</script>

<svg class="identity-icon" data-icon={name} data-icon-theme={theme} data-icon-source={source} width={size} height={height} viewBox={`0 0 ${size} ${height}`} style={tinted ? `mask: url('${source}') center / contain no-repeat` : undefined} aria-hidden="true" focusable="false">
  {#if tinted}<rect width={size} height={height} fill="currentColor" />{:else}<image href={source} width={size} height={height} preserveAspectRatio="xMidYMid meet" />{/if}
</svg>
