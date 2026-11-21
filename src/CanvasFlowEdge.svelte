<script lang="ts">
  import { getContext, tick, untrack } from 'svelte';
  import { BaseEdge, EdgeLabel, getBezierPath, type EdgeProps } from '@xyflow/svelte';
  import { BOARD, type CanvasBoard } from './canvas-board';

  let { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerStart, markerEnd, label, style }: EdgeProps = $props();
  const board = getContext<CanvasBoard>(BOARD);
  let geometry = $derived(getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }));
  let editing = $derived(board.editingEdge === id);
  let draft = $state(''), field = $state<HTMLInputElement>();
  $effect(() => {
    if (!editing) return;
    untrack(() => { draft = label ?? ''; });
    void tick().then(() => { field?.focus(); field?.select(); });
  });
  function key(event: KeyboardEvent) {
    if (event.key === 'Escape' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); board.commitEdgeLabel(id, draft); }
  }
</script>

<BaseEdge {id} path={geometry[0]} {markerStart} {markerEnd} {style} />
{#if editing}
  <EdgeLabel x={geometry[1]} y={geometry[2]} class="canvas-edge-label editing"><input class="canvas-edge-input nodrag nopan" aria-label="Edit connection label" size={Math.max(6, draft.length + 1)} bind:this={field} bind:value={draft} onkeydown={key} onblur={() => board.commitEdgeLabel(id, draft)} /></EdgeLabel>
{:else if label}
  <EdgeLabel x={geometry[1]} y={geometry[2]} class="canvas-edge-label" selectEdgeOnClick data-edge-id={id}>{label}</EdgeLabel>
{/if}
