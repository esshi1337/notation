<script lang="ts">
  // Svelte Flow exposes its viewport helpers only to components rendered
  // inside it; this hands them to the canvas that hosts the flow.
  import { useSvelteFlow } from '@xyflow/svelte';
  let { ready }: { ready: (api: ReturnType<typeof useSvelteFlow>) => void } = $props();
  // svelte-ignore state_referenced_locally
  ready(useSvelteFlow());
</script>
