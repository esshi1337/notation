<script lang="ts">
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { onDestroy } from 'svelte';
  type Node = { id: string; path: string; name: string; title: string; tags: string[] };
  type Edge = { source: string; target: string; kind: string };
  type Graph = { nodes: Node[]; edges: Edge[]; unresolved: {source:string;target:string;status:string}[]; totals:{nodes:number;edges:number;unresolved:number}; truncated:{nodes:boolean;edges:boolean;unresolved:boolean} };
  let { currentPath, open, close }: { currentPath: string|null; open: (path:string)=>void; close:()=>void } = $props();
  let graph = $state<Graph|null>(null), error = $state(''), busy = $state(false), filter = $state(''), tag = $state(''), local = $state(false), depth = $state(1), zoom = $state(1), selected = $state('');
  let serial = 0;
  let viewport = $state<HTMLDivElement>();
  function resetView() { zoom = 1; viewport?.scrollTo({left:0,top:0}); }
  const nodes = $derived((graph?.nodes ?? []).filter(node => (!filter || [node.title,node.path].join(' ').toLowerCase().includes(filter.toLowerCase())) && (!tag || node.tags.some(value => value.replace(/^#/u,'').toLowerCase() === tag.replace(/^#/u,'').toLowerCase()))));
  const ids = $derived(new Set(nodes.map(node=>node.id)));
  const edges = $derived((graph?.edges ?? []).filter(edge=>ids.has(edge.source)&&ids.has(edge.target)));
  function layout(items:Node[], connections:Edge[]) {
    const points = items.map((node,i)=>({node,x:400+260*Math.cos(i*2*Math.PI/Math.max(1,items.length)),y:300+220*Math.sin(i*2*Math.PI/Math.max(1,items.length))}));
    const byId = new Map(points.map(point=>[point.node.id,point]));
    for(let step=0;step<80;step++) {
      const forces = points.map(()=>({x:0,y:0}));
      for(let i=0;i<points.length;i++) for(let j=i+1;j<points.length;j++) {
        const dx=points[i].x-points[j].x,dy=points[i].y-points[j].y,d=Math.max(36,dx*dx+dy*dy),f=220/d;
        forces[i].x+=dx*f;forces[i].y+=dy*f;forces[j].x-=dx*f;forces[j].y-=dy*f;
      }
      const indexes=new Map(points.map((point,i)=>[point.node.id,i]));
      for(const edge of connections){const a=indexes.get(edge.source),b=indexes.get(edge.target);if(a===undefined||b===undefined||a===b)continue;const dx=points[b].x-points[a].x,dy=points[b].y-points[a].y;forces[a].x+=dx*.015;forces[a].y+=dy*.015;forces[b].x-=dx*.015;forces[b].y-=dy*.015;}
      points.forEach((point,i)=>{point.x=Math.max(60,Math.min(740,point.x+Math.max(-8,Math.min(8,forces[i].x+(400-point.x)*.004))));point.y=Math.max(40,Math.min(560,point.y+Math.max(-8,Math.min(8,forces[i].y+(300-point.y)*.004))));});
    }
    return {points,byId};
  }
  const positions = $derived(layout(nodes,edges));
  async function refresh(){const ticket=++serial;busy=true;error='';try{if(!isTauri())throw new Error('The note graph requires a desktop workspace.');if(local&&!currentPath)throw new Error('Open a saved note to use its local graph.');const result=await invoke<Graph>('graph_workspace',{request:{focus:local?currentPath:undefined,depth,maxNodes:200,maxEdges:1000,includeUnresolved:true}});if(ticket===serial)graph=result;}catch(cause){if(ticket===serial)error=String(cause);}finally{if(ticket===serial)busy=false;}}
  $effect(()=>{const focus=local,path=currentPath,radius=depth;const timer=setTimeout(()=>void refresh(),120);return()=>clearTimeout(timer);});
  onDestroy(()=>serial++);
</script>
<section class="utility-panel graph-panel" aria-label="Note graph">
  <div class="scripts-heading"><strong>Graph</strong><button aria-label="Close graph" onclick={close}>×</button></div>
  <label>Filter notes<input aria-label="Graph filter" bind:value={filter} placeholder="Title or path" /></label>
  <label>Tag<input aria-label="Graph tag filter" bind:value={tag} placeholder="Any tag" /></label>
  <label class="graph-local"><input type="checkbox" aria-label="Local graph" bind:checked={local} disabled={!currentPath} /> Current note neighborhood</label>
  {#if local}<label>Depth<select aria-label="Graph depth" bind:value={depth}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>{/if}
  <div class="panel-actions"><button onclick={()=>void refresh()} disabled={busy}>Refresh graph</button><button aria-label="Zoom out graph" onclick={()=>zoom=Math.max(.5,zoom-.25)}>−</button><button aria-label="Zoom in graph" onclick={()=>zoom=Math.min(3,zoom+.25)}>+</button><button onclick={()=>resetView()}>Reset view</button></div>
  {#if filter || tag}<button class="graph-clear" onclick={() => {filter='';tag='';}}>Clear graph filters</button>{/if}
  {#if error}<div role="alert" class="script-error">{error}</div>{/if}
  {#if busy}<p role="status">Loading graph…</p>{/if}
  {#if graph}
    <p class="panel-note" role="status">{nodes.length} notes · {edges.length} links · {graph.totals.unresolved} unresolved</p>
    {#if graph.truncated.nodes||graph.truncated.edges}<p class="panel-note">Graph limited to 200 notes and 1,000 links. Use a local graph to narrow it.</p>{/if}
    <div class="graph-viewport" bind:this={viewport}><svg style={'width:' + (zoom * 100) + '%;'} viewBox="0 0 800 600" role="group" aria-label="Workspace note connections"><g>
      {#each edges as edge}{@const a=positions.byId.get(edge.source)}{@const b=positions.byId.get(edge.target)}{#if a&&b}<line x1={a.x} y1={a.y} x2={b.x} y2={b.y} class:graph-edge-active={selected===edge.source||selected===edge.target} />{/if}{/each}
      {#each positions.points as point}<g role="button" tabindex="0" aria-label={'Open graph note: '+point.node.title} onclick={()=>open(point.node.path)} onkeydown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open(point.node.path);}}} onfocus={()=>selected=point.node.id} onblur={()=>selected=''} onmouseenter={()=>selected=point.node.id} onmouseleave={()=>selected=''}><title>{point.node.path}</title><circle cx={point.x} cy={point.y} r={point.node.path===currentPath?7:5}/><text x={point.x+10} y={point.y+4}>{(point.node.title||point.node.name).slice(0,30)}</text></g>{/each}
    </g></svg></div>
    {#if !nodes.length}<p class="panel-note">No notes match these filters.</p>{/if}
    <details><summary>Notes ({nodes.length})</summary>{#each nodes as node}<button class="graph-note-row" onclick={()=>open(node.path)}>{node.title||node.name}<small>{node.path}</small></button>{/each}</details>
    {#if graph.unresolved.length}<details><summary>Unresolved links</summary>{#each graph.unresolved.slice(0,50) as link}<button class="graph-note-row" onclick={()=>open(link.source)}>{link.target}<small>{link.status}</small></button>{/each}</details>{/if}
  {/if}
</section>

<style>
  .graph-panel .graph-local { flex-direction: row; align-items: center; margin: 0; }
  .graph-local input { width: 12px; flex: 0 0 12px; padding: 0; }
  .graph-clear { align-self: flex-start; padding: 0; color: var(--muted); font-size: 10px; }
</style>
