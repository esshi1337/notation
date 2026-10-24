<script lang="ts">
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { onDestroy, untrack } from 'svelte';
  import { layoutGraph, type LayoutPoint } from './graph-layout';
  type Node = { id: string; path: string; name: string; title: string; tags: string[] };
  type Edge = { source: string; target: string; kind: string };
  type Graph = { nodes: Node[]; edges: Edge[]; unresolved: {source:string;target:string;status:string}[]; totals:{nodes:number;edges:number;unresolved:number}; truncated:{nodes:boolean;edges:boolean;unresolved:boolean} };
  let { currentPath, open, close }: { currentPath: string|null; open: (path:string)=>void; close:()=>void } = $props();
  let graph = $state<Graph|null>(null), error = $state(''), busy = $state(false), filter = $state(''), tag = $state(''), local = $state(false), depth = $state(1);
  let hovered = $state(''), focused = $state('');
  let serial = 0;
  let viewport = $state<HTMLDivElement>();
  let viewWidth = $state(0), viewHeight = $state(0);
  let camera = $state({ x: 0, y: 0, scale: 1 });
  let cameraMode = $state<'readable' | 'fit' | 'custom'>('readable');
  let framedSignature = '';
  let measuredWidth = 0, measuredHeight = 0;
  let drag: { pointerId: number; startX: number; startY: number; originX: number; originY: number } | null = null;

  const nodes = $derived((graph?.nodes ?? []).filter(node => (!filter || [node.title,node.path].join(' ').toLowerCase().includes(filter.toLowerCase())) && (!tag || node.tags.some(value => value.replace(/^#/u,'').toLowerCase() === tag.replace(/^#/u,'').toLowerCase()))));
  const ids = $derived(new Set(nodes.map(node=>node.id)));
  const edges = $derived((graph?.edges ?? []).filter(edge=>ids.has(edge.source)&&ids.has(edge.target)));
  const layout = $derived(layoutGraph(nodes, edges));
  const selected = $derived(hovered || focused);

  function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
  function centerAt(scale: number) {
    const width = viewWidth || viewport?.clientWidth || 420;
    const height = viewHeight || viewport?.clientHeight || 320;
    if (!layout.width || !layout.height) { camera = { x: 0, y: 0, scale: 1 }; return; }
    const current = layout.points.find(point => point.node.path === currentPath);
    const fits = layout.width * scale <= width - 36 && layout.height * scale <= height - 36;
    const centerX = current && !fits ? current.x + current.width / 2 : layout.width / 2;
    const centerY = current && !fits ? current.y + current.height / 2 : layout.height / 2;
    camera = { scale, x: width / 2 - centerX * scale, y: height / 2 - centerY * scale };
  }
  function readableView() {
    const width = viewWidth || viewport?.clientWidth || 420;
    const height = viewHeight || viewport?.clientHeight || 320;
    if (!layout.width || !layout.height) { camera = { x: 0, y: 0, scale: 1 }; cameraMode = 'readable'; return; }
    const fitScale = Math.min((width - 36) / layout.width, (height - 36) / layout.height, 1);
    centerAt(clamp(fitScale, 0.85, 1));
    cameraMode = 'readable';
  }
  function actualSize() {
    centerAt(1);
    cameraMode = 'readable';
  }
  function fitGraph() {
    const width = viewWidth || viewport?.clientWidth || 420;
    const height = viewHeight || viewport?.clientHeight || 320;
    if (!layout.width || !layout.height) { camera = { x: 0, y: 0, scale: 1 }; cameraMode = 'fit'; return; }
    const scale = clamp(Math.min((width - 36) / layout.width, (height - 36) / layout.height), 0.05, 2);
    camera = { scale, x: (width - layout.width * scale) / 2, y: (height - layout.height * scale) / 2 };
    cameraMode = 'fit';
  }
  function zoomBy(factor: number, centerX?: number, centerY?: number) {
    const next = clamp(camera.scale * factor, 0.05, 4);
    if (Math.abs(next - camera.scale) < 0.0001) return;
    const x = centerX ?? (viewWidth || viewport?.clientWidth || 0) / 2;
    const y = centerY ?? (viewHeight || viewport?.clientHeight || 0) / 2;
    const ratio = next / camera.scale;
    camera = { scale: next, x: x - (x - camera.x) * ratio, y: y - (y - camera.y) * ratio };
    cameraMode = 'custom';
  }
  function reveal(point: LayoutPoint) {
    if (!viewWidth || !viewHeight || !layout.points.length) return;
    const scale = camera.scale;
    const padding = 16;
    const left = camera.x + point.x * scale;
    const top = camera.y + point.y * scale;
    const right = left + point.width * scale;
    const bottom = top + point.height * scale;
    let dx = 0;
    let dy = 0;
    if (left < padding) dx = padding - left;
    else if (right > viewWidth - padding) dx = viewWidth - padding - right;
    if (top < padding) dy = padding - top;
    else if (bottom > viewHeight - padding) dy = viewHeight - padding - bottom;
    if (!dx && !dy) return;
    camera = { ...camera, x: camera.x + dx, y: camera.y + dy };
    cameraMode = 'custom';
  }
  function onWheel(event: WheelEvent) {
    if (!layout.points.length) return;
    event.preventDefault();
    const box = viewport?.getBoundingClientRect();
    zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, box ? event.clientX - box.left : undefined, box ? event.clientY - box.top : undefined);
  }
  function startPan(event: PointerEvent) {
    if (event.button !== 0) return;
    if ((event.target as Element | null)?.closest?.('[data-graph-node]')) return;
    drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: camera.x, originY: camera.y };
    (event.currentTarget as Element | null)?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }
  function movePan(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    camera = { ...camera, x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY };
    cameraMode = 'custom';
  }
  function endPan(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    (event.currentTarget as Element | null)?.releasePointerCapture?.(event.pointerId);
  }
  function activate(point: LayoutPoint) { if (point.node.path) open(point.node.path); }
  async function refresh(){const ticket=++serial;busy=true;error='';try{if(!isTauri())throw new Error('The note graph requires a desktop workspace.');if(local&&!currentPath)throw new Error('Open a saved note to use its local graph.');const result=await invoke<Graph>('graph_workspace',{request:{focus:local?currentPath:undefined,depth,maxNodes:200,maxEdges:1000,includeUnresolved:true}});if(ticket===serial)graph=result;}catch(cause){if(ticket===serial)error=String(cause);}finally{if(ticket===serial)busy=false;}}
  $effect(()=>{const radius=local?depth:1,path=local?currentPath:null;const timer=setTimeout(()=>void refresh(),120);return()=>clearTimeout(timer);});
  $effect(() => {
    const element = viewport;
    if (!element) return;
    const measure = () => {
      const nextWidth = element.clientWidth;
      const nextHeight = element.clientHeight;
      if (measuredWidth && measuredHeight && (nextWidth !== measuredWidth || nextHeight !== measuredHeight)) {
        const current = untrack(() => camera);
        camera = { ...current, x: current.x + (nextWidth - measuredWidth) / 2, y: current.y + (nextHeight - measuredHeight) / 2 };
      }
      measuredWidth = nextWidth;
      measuredHeight = nextHeight;
      viewWidth = nextWidth;
      viewHeight = nextHeight;
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });
  $effect(() => {
    if (!graph || !viewWidth || !viewHeight) return;
    if (!layout.width || !layout.height || framedSignature === layout.signature) return;
    framedSignature = layout.signature;
    readableView();
  });
  $effect(() => {
    if (cameraMode !== 'fit' || !viewWidth || !viewHeight) return;
    fitGraph();
  });
  onDestroy(()=>serial++);
</script>
<section class="utility-panel graph-panel" aria-label="Note graph">
  <div class="scripts-heading"><strong>Graph</strong><button aria-label="Close graph" onclick={close}>×</button></div>
  <label>Filter notes<input aria-label="Graph filter" bind:value={filter} placeholder="Title or path" /></label>
  <label>Tag<input aria-label="Graph tag filter" bind:value={tag} placeholder="Any tag" /></label>
  <label class="graph-local"><input type="checkbox" aria-label="Local graph" bind:checked={local} disabled={!currentPath} /> Current note neighborhood</label>
  {#if local}<label>Depth<select aria-label="Graph depth" bind:value={depth}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>{/if}
  <div class="panel-actions graph-actions"><button onclick={()=>void refresh()} disabled={busy}>Refresh graph</button><button aria-label="Zoom out graph" title="Zoom out" onclick={()=>zoomBy(1/1.2)}>−</button><span class="graph-zoom" aria-label={'Graph zoom ' + Math.round(camera.scale*100) + '%'}>{Math.round(camera.scale*100)}%</span><button aria-label="Zoom in graph" title="Zoom in" onclick={()=>zoomBy(1.2)}>+</button><button aria-label="Actual size graph" title="Actual size (100%)" onclick={()=>actualSize()}>1:1</button><button aria-label="Fit graph" title="Fit graph to view" onclick={()=>fitGraph()}>Fit</button></div>
  {#if filter || tag}<button class="graph-clear" onclick={() => {filter='';tag='';}}>Clear graph filters</button>{/if}
  {#if error}<div role="alert" class="script-error">{error}</div>{/if}
  {#if busy}<p role="status">Loading graph…</p>{/if}
  {#if graph}
    <p class="panel-note" role="status">{nodes.length} notes · {edges.length} links · {graph.totals.unresolved} unresolved</p>
    {#if graph.truncated.nodes||graph.truncated.edges}<p class="panel-note">Graph limited to 200 notes and 1,000 links. Use a local graph to narrow it.</p>{/if}
    <div class="graph-viewport" bind:this={viewport} aria-busy={busy}>
      {#if layout.points.length}
        <svg class="graph-canvas" data-zoom={camera.scale.toFixed(3)} data-pan-x={Math.round(camera.x)} data-pan-y={Math.round(camera.y)} data-view={cameraMode} data-content-width={Math.round(layout.width)} data-content-height={Math.round(layout.height)} role="group" aria-label="Workspace note connections" onpointerdown={startPan} onpointermove={movePan} onpointerup={endPan} onpointercancel={endPan} onwheel={onWheel}>
          <g transform={'translate(' + camera.x + ' ' + camera.y + ') scale(' + camera.scale + ')'}>
            {#each layout.links as link, index (link.source + '>' + link.target + '>' + index)}
              <line class="graph-link" class:graph-link-active={selected === link.source || selected === link.target} x1={link.x1} y1={link.y1} x2={link.x2} y2={link.y2} />
            {/each}
            {#each layout.points as point (point.id)}
              <g class="note-node" class:current={point.node.path === currentPath} class:selected={selected === point.id} data-graph-node={point.id} data-node-path={point.node.path} role="button" tabindex="0" aria-label={'Open graph note: ' + (point.node.title || point.node.name || point.node.id) + (point.node.path ? '. ' + point.node.path : '')} aria-current={point.node.path === currentPath ? 'true' : undefined} onclick={(event) => { event.stopPropagation(); activate(point); }} onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); activate(point); } }} onfocus={() => { focused = point.id; reveal(point); }} onblur={() => { if (focused === point.id) focused = ''; }} onmouseenter={() => hovered = point.id} onmouseleave={() => { if (hovered === point.id) hovered = ''; }}>
                <title>{(point.node.title || point.node.name || point.node.id) + (point.node.path ? ' — ' + point.node.path : '')}</title>
                <rect class="note-card" x={point.x} y={point.y} width={point.width} height={point.height} rx="4" />
                <text class="note-label" x={point.x + 9} y={point.y + point.height / 2 + 4}>{point.label}</text>
              </g>
            {/each}
          </g>
        </svg>
      {:else}
        <p class="panel-note graph-empty">No notes to draw.</p>
      {/if}
    </div>
    {#if layout.points.length}<p class="graph-hint" aria-hidden="true">Drag to pan · Scroll to zoom · Tab to reveal, Enter to open</p>{/if}
    {#if !nodes.length}<p class="panel-note">No notes match these filters.</p>{/if}
    <details><summary>Notes ({nodes.length})</summary>{#each nodes as node}<button class="graph-note-row" onclick={()=>open(node.path)}>{node.title||node.name}<small>{node.path}</small></button>{/each}</details>
    {#if graph.unresolved.length}<details><summary>Unresolved links</summary>{#each graph.unresolved.slice(0,50) as link}<button class="graph-note-row" onclick={()=>open(link.source)}>{link.target}<small>{link.status}</small></button>{/each}</details>{/if}
  {/if}
</section>

<style>
  .graph-panel { min-width: 0; }
  .graph-panel .graph-local { flex-direction: row; align-items: center; margin: 0; gap: 7px; }
  .graph-local input { width: 12px; flex: 0 0 12px; padding: 0; }
  .graph-clear { align-self: flex-start; padding: 0; color: var(--muted); font-size: 10px; }
  .graph-actions { align-items: center; }
  .graph-zoom { min-width: 34px; text-align: center; color: var(--muted); font: 10px 'Geist Mono', monospace; }
  .graph-viewport { position: relative; height: clamp(220px, 46vh, 480px); min-height: 200px; max-height: 60vh; margin: 8px 0; padding: 0; overflow: hidden; border: 1px solid var(--border); background: var(--bg); cursor: grab; touch-action: none; user-select: none; }
  .graph-viewport:active { cursor: grabbing; }
  .graph-canvas { display: block; width: 100%; height: 100%; max-width: 100%; }
  .graph-link { stroke: var(--border); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .graph-link.graph-link-active { stroke: var(--muted); stroke-width: 1.5; }
  .note-node { cursor: pointer; outline: none; }
  .note-card { fill: var(--bg); stroke: var(--border); stroke-width: 1; }
  .note-node.current .note-card { stroke: var(--text); stroke-width: 2; }
  .note-node.selected .note-card { fill: var(--text); stroke: var(--text); }
  .note-label { fill: var(--text); font: 12px 'Geist', ui-sans-serif, sans-serif; pointer-events: none; }
  .note-node.selected .note-label { fill: var(--bg); }
  .note-node:focus-visible .note-card { stroke: var(--text); stroke-width: 2; }
  .graph-hint { margin: -4px 0 0; color: var(--muted); font-size: 9px; }
  .graph-empty { padding: 12px; }
  .graph-panel details { color: var(--muted); font-size: 10px; }
  .graph-panel summary { cursor: pointer; }
  .graph-note-row { display: block; width: 100%; padding: 6px; text-align: left; font-size: 12px; }
  .graph-note-row small { display: block; color: var(--muted); overflow-wrap: anywhere; font-size: 10px; }
</style>
