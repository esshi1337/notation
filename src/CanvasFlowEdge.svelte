<script lang="ts">
  import { getContext, tick, untrack } from 'svelte';
  import { BaseEdge, EdgeLabel, EdgeReconnectAnchor, getBezierPath, type EdgeProps } from '@xyflow/svelte';
  import { BOARD, type CanvasBoard } from './canvas-board';

  let { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerStart, markerEnd, label, style, selected = false }: EdgeProps = $props();
  const board = getContext<CanvasBoard>(BOARD);
  let geometry = $derived(getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }));
  let editing = $derived(board.editingEdge === id);
  let draft = $state(''), field = $state<HTMLInputElement>();
  // While an end is being dragged the connection line stands in for this edge.
  let movingSource = $state(false), movingTarget = $state(false);
  $effect(() => {
    if (!editing) return;
    untrack(() => { draft = label ?? ''; });
    void tick().then(() => { field?.focus(); field?.select(); });
  });
  function key(event: KeyboardEvent) {
    if (event.key === 'Escape' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); board.commitEdgeLabel(id, draft); }
  }
</script>

{#if !movingSource && !movingTarget}<BaseEdge {id} path={geometry[0]} {markerStart} {markerEnd} {style} />{/if}
{#if editing}
  <EdgeLabel x={geometry[1]} y={geometry[2]} class="canvas-edge-label editing"><input class="canvas-edge-input nodrag nopan" aria-label="Edit connection label" size={Math.max(6, draft.length + 1)} bind:this={field} bind:value={draft} onkeydown={key} onblur={() => board.commitEdgeLabel(id, draft)} /></EdgeLabel>
{:else if label}
  <EdgeLabel x={geometry[1]} y={geometry[2]} class="canvas-edge-label" selectEdgeOnClick data-edge-id={id}>{label}</EdgeLabel>
{/if}
<!-- A selected connection shows a grip at each end: drag it to another card or side. -->
{#if selected && !editing && !board.far}
  <EdgeReconnectAnchor type="source" bind:reconnecting={movingSource} position={{ x: sourceX, y: sourceY }} size={22} class="canvas-edge-end" title="Drag to move this end"><span></span></EdgeReconnectAnchor>
  <EdgeReconnectAnchor type="target" bind:reconnecting={movingTarget} position={{ x: targetX, y: targetY }} size={22} class="canvas-edge-end" title="Drag to move this end"><span></span></EdgeReconnectAnchor>
{/if}
