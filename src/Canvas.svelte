<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import CanvasCard from './CanvasCard.svelte';
  import { canvasAnchor, canvasNodeTitle, mutateCanvas, parseCanvas, removeCanvasNode } from './canvas';
  import type { CanvasDocument, CanvasNode } from './canvas';
  type Snapshot = { text: string; documentId: number };
  type Drag = { id: string | null; x: number; y: number; panX: number; panY: number; snapshot: Snapshot };
  let { content, documentId, path, apply, openNote, renderCard, undo, redo }: { content: string; documentId: number; path?: string | null; apply: (next: string, snapshot: Snapshot) => boolean; openNote: (file: string, subpath?: string) => void; renderCard?: (host: HTMLElement, markdown: string, sourcePath?: string, current?: () => boolean) => Promise<void>; undo?: () => void; redo?: () => void } = $props();
  let parseError = $state(false);
  let canvas = $state<CanvasDocument>({ nodes: [], edges: [] }), error = $state(''), message = $state('');
  let selectedId = $state(''), selected = $derived(canvas.nodes.find((node) => node.id === selectedId));
  let zoom = $state(1), panX = $state(40), panY = $state(40), drag = $state<Drag | null>(null), dx = $state(0), dy = $state(0);
  let cardText = $state(''), cardFile = $state(''), cardLabel = $state(''), cardURL = $state(''), cardWidth = $state(280), cardHeight = $state(180);
  let formSnapshot: Snapshot | null = null, loadedId = -1;
  let fromCard = $state(''), toCard = $state(''), edgeLabel = $state(''), connectOpen = $state(false);
  let viewport: HTMLDivElement, addMenuHost: HTMLDivElement, addTrigger: HTMLButtonElement;
  let addOpen = $state(false);
  function showSelected() { const node = selected; if (!node || !viewport) return; if (node.x*zoom+panX < 0 || (node.x+node.width)*zoom+panX > viewport.clientWidth || node.y*zoom+panY < 0 || (node.y+node.height)*zoom+panY > viewport.clientHeight) { panX = viewport.clientWidth/2-(node.x+node.width/2)*zoom; panY = viewport.clientHeight/2-(node.y+node.height/2)*zoom; } }
  onMount(() => { const observer = new ResizeObserver(() => { if (!drag) showSelected(); }); observer.observe(viewport); const outside = (event:PointerEvent) => { if (addOpen && !addMenuHost.contains(event.target as Node)) addOpen = false; }; document.addEventListener('pointerdown',outside,true); return () => {observer.disconnect();document.removeEventListener('pointerdown',outside,true);}; });
  $effect(() => { if (addOpen) queueMicrotask(() => addMenuHost.querySelector<HTMLElement>('[role=menuitem]')?.focus()); });
  function menuKey(event:KeyboardEvent) { const items = [...addMenuHost.querySelectorAll<HTMLButtonElement>('[role=menuitem]')], at=items.indexOf(document.activeElement as HTMLButtonElement); if(event.key==='Escape'){event.preventDefault();addOpen=false;addTrigger.focus();} else if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();items[(at+(event.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();} else if(event.key==='Tab') addOpen=false; }
  $effect(() => {
    const text = content, identity = documentId;
    untrack(() => {
      try { canvas = parseCanvas(text); parseError = false; error = ''; if (identity !== loadedId) { loadedId = identity; selectedId = ''; zoom = 1; panX = 40; panY = 40; drag = null; } }
      catch (cause) { canvas = { nodes: [], edges: [] }; selectedId = ''; parseError = true; error = cause instanceof Error ? cause.message : String(cause); }
    });
  });
  function commit(mutate: (value: CanvasDocument) => void, source: Snapshot = { text: content, documentId }) {
    try {
      if (source.documentId !== documentId || source.text !== content) throw new Error('Canvas changed. Select the card again before applying.');
      const next = mutateCanvas(source.text, mutate);
      if (!apply(next, source)) throw new Error('Canvas changed. Try the action again.');
      error = ''; message = 'Canvas updated.'; return true;
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); return false; }
  }
  function select(node: CanvasNode) {
    selectedId = node.id; cardText = node.text ?? ''; cardFile = node.file ?? ''; cardLabel = node.label ?? ''; cardURL = node.url ?? ''; cardWidth = node.width; cardHeight = node.height;
    formSnapshot = { text: content, documentId };
  }
  function add(type: 'text' | 'file' | 'group', variant = '') {
    addOpen = false; addTrigger?.focus();
    const id = crypto.randomUUID(), width = type === 'group' ? 420 : 280, height = type === 'group' ? 300 : 180;
    const node: CanvasNode = { id, type, x: Math.round(((viewport?.clientWidth ?? 800) / 2 - panX) / zoom - width / 2), y: Math.round(((viewport?.clientHeight ?? 500) / 2 - panY) / zoom - height / 2), width, height };
    const previous = [...canvas.nodes].reverse().find(node => node.type !== 'group');
    if (previous && type !== 'group') { node.x = previous.x + previous.width + 32; node.y = previous.y; }
    if (type === 'text') node.text = variant === 'diagram' ? '```mermaid\ngraph TD\n  Idea --> Note\n```' : 'New card';
    if (variant === 'diagram') node.label = 'Mermaid diagram';
    if (type === 'file') { node.file = ''; node.label = variant === 'media' ? 'Media' : 'Note'; }
    if (type === 'group') node.label = 'Group';
    if (commit((value) => value.nodes.push(node))) void tick().then(() => { const added = canvas.nodes.find((item) => item.id === id); if (added) { select(added); void tick().then(showSelected); } });
  }
  function applyCard() {
    if (!selected || !formSnapshot) return;
    const id = selected.id;
    if (commit((value) => { const node = value.nodes.find((item) => item.id === id)!; node.width = Math.round(Number(cardWidth)); node.height = Math.round(Number(cardHeight)); if (node.type === 'text') node.text = cardText; if (node.type === 'file') node.file = cardFile; if (node.type === 'link') node.url = cardURL; if (cardLabel) node.label = cardLabel; else delete node.label; }, formSnapshot)) { formSnapshot = null; selectedId = ''; }
  }
  function remove() { if (selected && commit((value) => removeCanvasNode(value, selected.id))) selectedId = ''; }
  function begin(event: PointerEvent, node?: CanvasNode) {
    if (event.button !== 0) return;
    event.preventDefault(); if (node) select(node);
    drag = { id: node?.id ?? null, x: event.clientX, y: event.clientY, panX, panY, snapshot: { text: content, documentId } }; dx = 0; dy = 0;
    viewport.focus(); viewport.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    if (!drag) return;
    if (drag.id) { dx = (event.clientX - drag.x) / zoom; dy = (event.clientY - drag.y) / zoom; }
    else { panX = drag.panX + event.clientX - drag.x; panY = drag.panY + event.clientY - drag.y; }
  }
  function end() {
    const value = drag, changeX = Math.round(dx), changeY = Math.round(dy); drag = null; dx = 0; dy = 0;
    if (value?.id && (changeX || changeY)) commit((canvas) => { const node = canvas.nodes.find((node) => node.id === value.id); if (!node) throw new Error('The dragged card was removed.'); node.x += changeX; node.y += changeY; }, value.snapshot);
  }
  function fit() {
    if (!canvas.nodes.length) { zoom = 1; panX = 40; panY = 40; return; }
    const left = Math.min(...canvas.nodes.map((node) => node.x)), top = Math.min(...canvas.nodes.map((node) => node.y)), right = Math.max(...canvas.nodes.map((node) => node.x + node.width)), bottom = Math.max(...canvas.nodes.map((node) => node.y + node.height));
    zoom = Math.max(.1, Math.min(2, ((viewport?.clientWidth ?? 800) - 80) / (right - left), ((viewport?.clientHeight ?? 500) - 80) / (bottom - top))); panX = 40 - left * zoom; panY = 40 - top * zoom;
  }
  function wheel(event: WheelEvent) { event.preventDefault(); if (event.ctrlKey || event.metaKey) zoom = Math.max(.1, Math.min(3, zoom * (event.deltaY < 0 ? 1.1 : .9))); else { panX -= event.deltaX; panY -= event.deltaY; } }
  function historyKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea,select,[contenteditable=true]')) return;
    if ((event.ctrlKey || event.metaKey) && ['z','y'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); if (event.key.toLowerCase() === 'y' || event.shiftKey) redo?.(); else undo?.(); }
  }
  function keyboard(event: KeyboardEvent) {
    if (event.target !== viewport) return;
    if (selected && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); const amount = event.shiftKey ? 10 : 1; commit((value) => { const node = value.nodes.find((node) => node.id === selectedId)!; if (event.key === 'ArrowUp') node.y -= amount; if (event.key === 'ArrowDown') node.y += amount; if (event.key === 'ArrowLeft') node.x -= amount; if (event.key === 'ArrowRight') node.x += amount; }); }
    if (selected && event.key === 'Delete') { event.preventDefault(); remove(); }
  }
  function connect() {
    if (!fromCard || !toCard || fromCard === toCard) { error = 'Choose two different cards.'; return; }
    if (commit((value) => value.edges.push({ id: crypto.randomUUID(), fromNode: fromCard, toNode: toCard, fromSide: 'right', toSide: 'left', ...(edgeLabel ? { label: edgeLabel } : {}) }))) { connectOpen = false; edgeLabel = ''; }
  }
  function fileMarkdown(node: CanvasNode) {
    const file = node.file || '';
    if (/\.(?:png|jpe?g|gif|webp|avif|svg|bmp)$/iu.test(file)) return '![](' + encodeURI(file).replace(/[()]/gu, (value) => '%' + value.charCodeAt(0).toString(16)) + ')';
    if (/\.(?:md|markdown)$/iu.test(file) && !file.includes(']]')) return '![[' + file + (node.subpath || '') + ']]';
    return file || 'Choose a file in the card editor.';
  }
  function openLink(url: string) { try { const target = new URL(url); if (!['https:','http:','mailto:'].includes(target.protocol)) throw new Error('Only HTTP, HTTPS, and mail links can open from the canvas.'); window.open(target.href, '_blank', 'noopener,noreferrer'); } catch (cause) { error = String(cause); } }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Canvas history keys apply outside editable form fields.) -->
<section class="canvas-view" aria-label="Canvas" onkeydown={historyKey}>
  <div class="canvas-tools"><div class="canvas-add-menu" bind:this={addMenuHost}><button aria-label="Add card" aria-haspopup="menu" aria-expanded={addOpen} disabled={parseError} bind:this={addTrigger} onclick={() => addOpen=!addOpen}>Add card ⌄</button>{#if addOpen}<div role="menu" aria-label="Add card" tabindex="-1" onkeydown={menuKey}><button role="menuitem" onclick={() => add('text')}>Add text card</button><button role="menuitem" onclick={() => add('file')}>Add note card</button><button role="menuitem" onclick={() => add('file','media')}>Add media card</button><button role="menuitem" onclick={() => add('text','diagram')}>Add diagram card</button><button role="menuitem" onclick={() => add('group')}>Add group</button></div>{/if}</div><button disabled={parseError} aria-expanded={connectOpen} onclick={() => connectOpen = !connectOpen}>Connect cards</button><span class="canvas-tool-space"></span><button aria-label="Zoom out" onclick={() => zoom = Math.max(.1, zoom / 1.2)}>−</button><span class="canvas-zoom">{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" onclick={() => zoom = Math.min(3, zoom * 1.2)}>+</button><button onclick={fit}>Fit canvas</button></div>
  {#if error}<div class="app-error" role="alert">{error} Use Source to inspect the original JSON.</div>{/if}
  <div class="canvas-area">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions (Interactive canvas supports panning, card movement, and keyboard history.) -->
    <div class="canvas-viewport" role="application" aria-label="Canvas board" tabindex="0" bind:this={viewport} onpointerdown={(event) => { if (event.target === viewport) begin(event); }} onpointermove={move} onpointerup={end} onpointercancel={() => { drag = null; dx = 0; dy = 0; }} onwheel={wheel} onkeydown={keyboard}>
      <div class="canvas-plane" style={'transform:translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')'}>
        <svg class="canvas-edges" width="1" height="1" aria-label="Canvas connections"><defs><marker id={'canvas-arrow-' + documentId} markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto-start-reverse"><path d="M0,0 L6,3 L0,6" fill="var(--muted)" /></marker></defs>{#each canvas.edges as edge}<g>{#if canvas.nodes.some((node) => node.id === edge.fromNode) && canvas.nodes.some((node) => node.id === edge.toNode)}{@const from = canvasAnchor(canvas.nodes.find((node) => node.id === edge.fromNode)!, edge.fromSide || 'right')}{@const to = canvasAnchor(canvas.nodes.find((node) => node.id === edge.toNode)!, edge.toSide || 'left')}<line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="var(--muted)" stroke-width="1.5" marker-start={edge.fromEnd === 'arrow' ? 'url(#canvas-arrow-' + documentId + ')' : undefined} marker-end={edge.toEnd === 'none' ? undefined : 'url(#canvas-arrow-' + documentId + ')'} /><text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 7} fill="var(--muted)" font-size="11">{edge.label || ''}</text>{/if}</g>{/each}</svg>
        {#each canvas.nodes as node (node.id)}<article class="canvas-node" class:canvas-group={node.type === 'group'} class:selected={selectedId === node.id} aria-label={'Canvas card: ' + canvasNodeTitle(node)} style={'left:' + (node.x + (drag?.id === node.id ? dx : 0)) + 'px;top:' + (node.y + (drag?.id === node.id ? dy : 0)) + 'px;width:' + node.width + 'px;height:' + node.height + 'px'}>
          <div class="canvas-node-heading"><button class="canvas-move" aria-label={'Move card: ' + canvasNodeTitle(node)} onpointerdown={(event) => { event.stopPropagation(); begin(event,node); }}>{canvasNodeTitle(node)}</button><button aria-label={'Edit card: ' + canvasNodeTitle(node)} onclick={() => select(node)}>⋯</button></div>
          {#if node.type === 'text'}<CanvasCard markdown={node.text || ''} sourcePath={path ?? undefined} render={renderCard} />{:else if node.type === 'file'}<div class="canvas-file"><button disabled={!node.file} onclick={() => openNote(node.file!,node.subpath)} aria-label={'Open card file: ' + (node.file || '')}>Open original</button><CanvasCard markdown={fileMarkdown(node)} sourcePath="" render={renderCard} /></div>{:else if node.type === 'link'}<button class="canvas-link" onclick={() => openLink(node.url || '')}>{node.url}</button>{/if}
        </article>{/each}
      </div>
      {#if !canvas.nodes.length && !error}<p class="canvas-empty">Add a card to start this canvas. Drag card titles to move them; drag empty space to pan.</p>{/if}
    </div>
    {#if selected || connectOpen}<aside class="canvas-inspector" aria-label="Canvas inspector">
      {#if selected}<div class="scripts-heading"><strong>Edit card</strong><button aria-label="Close card editor" onclick={() => selectedId = ''}>×</button></div><label>Card label<input aria-label="Card label" bind:value={cardLabel} /></label>{#if selected.type === 'text'}<label>Card text<textarea aria-label="Card text" bind:value={cardText}></textarea></label>{:else if selected.type === 'file'}<label>Card file<input aria-label="Card file" bind:value={cardFile} /></label>{:else if selected.type === 'link'}<label>Card URL<input aria-label="Card URL" bind:value={cardURL} /></label>{/if}<div class="canvas-size"><label>Width<input type="number" aria-label="Card width" bind:value={cardWidth} min="1" max="1000000" /></label><label>Height<input type="number" aria-label="Card height" bind:value={cardHeight} min="1" max="1000000" /></label></div><div class="panel-actions"><button onclick={applyCard}>Apply card</button><button onclick={remove}>Delete card</button></div>{/if}
      {#if connectOpen}<strong>Connection</strong><label>From card<select aria-label="From card" bind:value={fromCard}><option value="">Choose a card</option>{#each canvas.nodes as node}<option value={node.id}>{canvasNodeTitle(node)}</option>{/each}</select></label><label>To card<select aria-label="To card" bind:value={toCard}><option value="">Choose a card</option>{#each canvas.nodes as node}<option value={node.id}>{canvasNodeTitle(node)}</option>{/each}</select></label><label>Connection label<input aria-label="Connection label" bind:value={edgeLabel} /></label><button onclick={connect}>Add connection</button>{/if}
      {#if canvas.edges.length}<details><summary>Connections</summary>{#each canvas.edges as edge}<div class="canvas-edge-row"><span>{edge.label || edge.fromNode.slice(0,8) + ' → ' + edge.toNode.slice(0,8)}</span><button aria-label={'Delete connection: ' + edge.id} onclick={() => commit((value) => value.edges = value.edges.filter((item) => item.id !== edge.id))}>×</button></div>{/each}</details>{/if}
    </aside>{/if}
  </div>
  {#if message}<div class="canvas-message" role="status">{message}</div>{/if}
</section>

<style>
  .canvas-view{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;flex:1;background:var(--bg)}.canvas-tools{display:flex;align-items:center;gap:4px;padding:5px 7px;border-bottom:1px solid var(--border);flex-wrap:nowrap;min-height:32px}.canvas-tools button{font-size:10px;padding:3px 6px}.canvas-tool-space{flex:1}.canvas-zoom{font-size:10px;color:var(--muted);min-width:32px;text-align:center}.canvas-area{display:flex;flex:1;min-height:0;overflow:hidden}.canvas-viewport{position:relative;flex:1;overflow:hidden;touch-action:none;outline:none}.canvas-plane{position:absolute;left:0;top:0;transform-origin:0 0}.canvas-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}.canvas-node{position:absolute;display:flex;flex-direction:column;border:1px solid var(--border);background:var(--panel);overflow:hidden;box-shadow:0 2px 12px #0002}.canvas-node.selected{border-color:var(--muted)}.canvas-node-heading{display:flex;align-items:center;border-bottom:1px solid var(--border);height:27px;flex-shrink:0;background:var(--bar)}.canvas-node-heading button{border:0;border-radius:0;height:100%;padding:3px 7px;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.canvas-move{flex:1;cursor:grab;text-align:left;touch-action:none}.canvas-group{background:transparent;border-style:dashed;pointer-events:none;box-shadow:none}.canvas-group .canvas-node-heading{pointer-events:auto}.canvas-file{min-height:0;display:flex;flex-direction:column;flex:1;overflow:hidden}.canvas-file>button{font-size:10px;align-self:flex-start;margin:6px 8px}.canvas-link{margin:12px;overflow-wrap:anywhere;white-space:normal}.canvas-inspector{width:220px;flex-shrink:0;overflow:auto;border-left:1px solid var(--border);padding:12px;display:flex;flex-direction:column;gap:10px;background:var(--panel)}.canvas-inspector label{display:grid;gap:5px;font-size:11px;color:var(--muted)}.canvas-inspector input,.canvas-inspector select,.canvas-inspector textarea{width:100%;min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:6px;font:11px/1.5 inherit}.canvas-inspector textarea{min-height:120px;resize:vertical;font-family:'Geist Mono',monospace}.canvas-size{display:grid;grid-template-columns:1fr 1fr;gap:7px}.canvas-empty{position:absolute;left:24px;top:20px;color:var(--muted);font-size:12px;pointer-events:none;max-width:310px;line-height:1.7}.canvas-message{padding:4px 10px;border-top:1px solid var(--border);font-size:10px;color:var(--muted)}.canvas-edge-row{display:flex;gap:5px;align-items:center;font-size:10px;padding:5px 0}.canvas-edge-row span{flex:1;overflow-wrap:anywhere}
.canvas-add-menu{position:relative}.canvas-add-menu [role=menu]{position:absolute;left:0;top:calc(100% + 4px);z-index:10;width:180px;padding:4px;background:var(--menu);border:1px solid var(--border);border-radius:4px;box-shadow:0 8px 24px #0005}.canvas-add-menu [role=menuitem]{display:block;width:100%;text-align:left;padding:6px 8px}.canvas-tools button:disabled{cursor:default}@media(max-width:800px){.canvas-inspector{width:200px;padding:10px}}
</style>
