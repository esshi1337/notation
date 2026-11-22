<script lang="ts">
  import { getContext, tick, untrack } from 'svelte';
  import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/svelte';
  import CanvasCard from './CanvasCard.svelte';
  import { canvasNodeTitle, type CanvasNode } from './canvas';
  import { BOARD, type CanvasBoard } from './canvas-board';
  import { canvasColor, MAX_SIZE, MIN_HEIGHT, MIN_WIDTH } from './canvas-flow';
  import { motionMs } from './motion';

  let { id, data, selected = false }: NodeProps = $props();
  const board = getContext<CanvasBoard>(BOARD);
  const SIDES = [['top', Position.Top], ['right', Position.Right], ['bottom', Position.Bottom], ['left', Position.Left]] as const;
  let node = $derived(data.node as CanvasNode), title = $derived(canvasNodeTitle(node));
  let group = $derived(node.type === 'group'), color = $derived(canvasColor(node.color));
  let editing = $derived(board.editing === id);
  // Far out, a card is its title on its colour; the real content stays rendered but hidden.
  let placeholder = $derived(board.far && !editing && !group);
  let heading = $derived(node.type === 'text' ? node.label ?? '' : title);
  let draft = $state(''), field = $state<HTMLTextAreaElement | HTMLInputElement>();

  $effect(() => {
    if (!editing) return;
    untrack(() => { draft = (group ? node.label : node.text) ?? ''; });
    void tick().then(() => { field?.focus(); field?.select(); });
  });
  function editorKey(event: KeyboardEvent) {
    // Every app shortcut (Save, close tab, switch tab, quit) starts with Ctrl or Cmd going
    // down, so writing the draft at that moment means none of them can leave it behind.
    if (event.key === 'Control' || event.key === 'Meta') { board.saveDraft(id, draft); return; }
    // Escape and Ctrl/Cmd+Enter leave the editor; leaving always commits.
    if (event.key === 'Escape' || event.key === 'Enter' && (event.ctrlKey || event.metaKey || group)) { event.preventDefault(); event.stopPropagation(); board.commitEdit(id, draft); }
  }
  // Clicking away commits and closes the editor. Switching to another window only
  // writes the draft, so the editor is still open on the way back.
  function editorBlur() { if (document.hasFocus()) board.commitEdit(id, draft); else board.saveDraft(id, draft); }
  const interactive = (target: EventTarget | null) => target instanceof Element && !!target.closest('a,button,input,textarea,select,summary,[contenteditable=true]');
  // Svelte Flow starts a card drag from mousedown/touchstart on its wrapper;
  // links and controls inside a card keep their own press.
  function press(event: Event) { if (interactive(event.target)) event.stopPropagation(); }
  function doubleClick(event: MouseEvent) { if (!interactive(event.target)) { event.stopPropagation(); board.edit(id); } }
  function appear(element: HTMLElement) {
    const duration = motionMs('base');
    if (board.fresh(id) && duration > 0) element.animate([{ opacity: 0, transform: 'scale(.92)', transformOrigin: 'center' }, { opacity: 1, transform: 'none', transformOrigin: 'center' }], { duration, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  }
  function fileMarkdown(card: CanvasNode) {
    const file = card.file || '';
    if (/\.(?:png|jpe?g|gif|webp|avif|svg|bmp)$/iu.test(file)) return '![](' + encodeURI(file).replace(/[()]/gu, (value) => '%' + value.charCodeAt(0).toString(16)) + ')';
    if (/\.(?:md|markdown)$/iu.test(file) && !file.includes(']]')) return '![[' + file + (card.subpath || '') + ']]';
    return file || 'Choose a note in the card details.';
  }
</script>

<NodeResizer minWidth={MIN_WIDTH} minHeight={MIN_HEIGHT} maxWidth={MAX_SIZE} maxHeight={MAX_SIZE} isVisible={selected && !editing && !board.far && board.selectionSize === 1} lineClass="canvas-resize-line" handleClass="canvas-resize-handle" onResizeStart={() => board.resizeStart(id)} onResizeEnd={(_event, params) => board.resizeEnd(id, params)} />
<!-- svelte-ignore a11y_no_static_element_interactions (The Svelte Flow wrapper is the focusable, labelled card; this is its surface.) -->
<div class="canvas-node" class:canvas-group={group} class:selected class:editing class:colored={!!color} style={color ? '--canvas-color:' + color : undefined} use:appear onmousedown={press} ontouchstart={press} ondblclick={doubleClick}>
  {#if placeholder}<div class="canvas-placeholder" aria-hidden="true"><span>{title}</span></div>{/if}
  <div class="canvas-node-body" class:paused={placeholder}>
    {#if editing && group}
      <div class="canvas-node-heading"><input class="canvas-inline-label nodrag nopan" aria-label="Group label" bind:this={field} bind:value={draft} onkeydown={editorKey} onblur={editorBlur} /></div>
    {:else if heading}
      <div class="canvas-node-heading"><span class="canvas-node-title">{heading}</span></div>
    {/if}
    <button type="button" class="canvas-node-more nodrag" aria-label={'Edit card: ' + title} title="Card details" onclick={() => board.details(id)}>⋯</button>
    {#if node.type === 'text'}
      {#if editing}
        <textarea class="canvas-inline-editor nodrag nopan nowheel" aria-label={'Card text: ' + title} spellcheck="true" bind:this={field} bind:value={draft} onkeydown={editorKey} onblur={editorBlur}></textarea>
      {:else}
        <CanvasCard markdown={node.text || ''} sourcePath={board.path} render={board.render} paused={placeholder} />
      {/if}
    {:else if node.type === 'file'}
      <div class="canvas-file">
        {#if node.file?.trim()}<button type="button" class="nodrag" onclick={() => board.openFile(node)} aria-label={'Open card file: ' + node.file}>Open original</button>{:else}<button type="button" class="nodrag" onclick={() => board.linkNote(node)}>Choose note</button>{/if}
        <CanvasCard markdown={fileMarkdown(node)} sourcePath="" render={board.render} paused={placeholder} />
      </div>
    {:else if node.type === 'link'}
      <button type="button" class="canvas-link nodrag" onclick={() => board.openLink(node.url || '')}>{node.url}</button>
    {/if}
  </div>
</div>
{#each SIDES as [side, position] (side)}<Handle type="source" {position} id={side} class="canvas-handle" />{/each}
