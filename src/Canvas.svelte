<script lang="ts" module>
  import type { CanvasFragment, View } from './canvas-flow';
  // Shared by every canvas tab: copy in one board, paste in another.
  let clipboard: CanvasFragment | null = null;
  // Each document keeps its own pan and zoom while its tab stays open.
  const views = new Map<number, View>();
</script>

<script lang="ts">
  import { onMount, setContext, tick, untrack } from 'svelte';
  import { Background, BackgroundVariant, ConnectionMode, MarkerType, MiniMap, SelectionMode, SvelteFlow, ViewportPortal, useSvelteFlow, type Edge, type Node } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/base.css';
  import './canvas-flow.css';
  import { motionMs, pop } from './motion';
  import CanvasFlowBridge from './CanvasFlowBridge.svelte';
  import CanvasFlowEdge from './CanvasFlowEdge.svelte';
  import CanvasFlowNode from './CanvasFlowNode.svelte';
  import { pinchZoom, wheelZoomFactor } from './wheel';
  import { canvasNodeTitle, mutateCanvasDocument, parseCanvas } from './canvas';
  import type { CanvasDocument, CanvasEdge, CanvasNode } from './canvas';
  import { BOARD, type CanvasBoard, type RenderCard } from './canvas-board';
  import { GRID, MAX_SIZE, MAX_ZOOM, MIN_HEIGHT, MIN_WIDTH, MIN_ZOOM, alignmentGuides, applyGeometry, boundsOf, canvasColor, coordinate, copyFragment, edgeSides, fitBounds, groupMembers, nearestSide, oppositeSide, pasteFragment, placeBySide, removeElements, toDocument, zoomAtPoint } from './canvas-flow';
  import type { Geometry, Guides, Rect, Side } from './canvas-flow';

  type Snapshot = { text: string; documentId: number };
  type NoteCandidate = { file: string; name?: string; title?: string; detail?: string };
  type CardData = { node: CanvasNode; key: string };
  type FlowNode = Node<CardData>;
  type FlowEdge = Edge<{ edge: CanvasEdge; key: string; auto: boolean }>;
  type Point = { x: number; y: number };
  type Menu = { kind: 'pane' | 'node' | 'edge'; id: string; left: number; top: number; at: Point; canPaste: boolean };
  const MAX_DROP_TEXT = 20_000, NUDGE_IDLE = 450, GUIDE_PIXELS = 6, VISIBLE_ONLY_ABOVE = 60;
  const COLORS = ['1', '2', '3', '4', '5', '6'];

  let { content, documentId, path, apply, openNote, noteCandidates, renderCard, undo, redo }: { content: string; documentId: number; path?: string | null; apply: (next: string, snapshot: Snapshot) => boolean; openNote: (file: string, subpath?: string) => void; noteCandidates?: (query: string) => Promise<NoteCandidate[]>; renderCard?: RenderCard; undo?: () => void; redo?: () => void } = $props();

  let parseError = $state(false), error = $state(''), message = $state('');
  let canvas = $state.raw<CanvasDocument>({ nodes: [], edges: [] });
  let nodes = $state.raw<FlowNode[]>([]), edges = $state.raw<FlowEdge[]>([]);
  let viewport = $state.raw<View>({ x: 0, y: 0, zoom: 1 });
  let detailId = $state(''), selected = $derived(canvas.nodes.find((node) => node.id === detailId));
  let editing = $state(''), editingEdge = $state('');
  let cardFile = $state(''), cardLabel = $state(''), cardURL = $state('');
  let noteQuery = $state(''), noteResults = $state<NoteCandidate[]>([]), noteSearchError = $state(''), noteSearchBusy = $state(false), noteSerial = 0;
  let fileField = $state<HTMLInputElement>();
  let fromCard = $state(''), toCard = $state(''), edgeLabel = $state(''), connectOpen = $state(false);
  let addOpen = $state(false), menu = $state<Menu | null>(null), guides = $state<Guides | null>(null);
  let host: HTMLDivElement, addMenuHost: HTMLDivElement, addTrigger: HTMLButtonElement, menuHost = $state<HTMLDivElement>();
  const preference = (key: string, fallback: boolean) => { try { const value = localStorage.getItem('notation.canvas.' + key); return value === null ? fallback : value === '1'; } catch { return fallback; } };
  const remember = (key: string, value: boolean) => { try { localStorage.setItem('notation.canvas.' + key, value ? '1' : '0'); } catch { /* Preferences are a convenience. */ } };
  let snap = $state(preference('snap', true)), minimap = $state(preference('minimap', false)), marquee = $state(false);

  let flow: ReturnType<typeof useSvelteFlow> | undefined;
  let formSnapshot: Snapshot | null = null, loadedId = -1;
  // The document this view last wrote, so its own change is not parsed twice.
  let own: { text: string; canvas: CanvasDocument } | null = null;
  // The view this component last asked for. Wheel and pinch events can arrive
  // faster than the flow reports back, and an eased zoom is still on its way.
  let view: View = { x: 0, y: 0, zoom: 1 }, easing = 0, eased = $state(false);
  let gesture: { snapshot: Snapshot; start: Map<string, Point>; followers: Map<string, { leader: string; from: Point }>; cancelled: boolean } | null = null;
  let resize: { id: string; snapshot: Snapshot } | null = null;
  let nudge: { snapshot: Snapshot; ids: Set<string>; selection: string; timer: ReturnType<typeof setTimeout> } | null = null;
  let pan = $state.raw<{ pointerId: number; x: number; y: number; view: View } | null>(null), spaceHeld = false;
  let pointer: Point | null = null, shiftPress: { x: number; y: number; ids: string[] } | null = null;
  let pendingSelect: string[] | null = null, pendingEdit = '', pendingReveal = '';
  const freshIds = new Set<string>();

  const current = (): Snapshot => ({ text: content, documentId });
  const matches = (source: Snapshot) => source.documentId === documentId && source.text === content;
  const rectOf = (node: FlowNode): Rect => ({ x: node.position.x, y: node.position.y, width: node.width ?? node.data.node.width, height: node.height ?? node.data.node.height });
  const selectedNodes = () => nodes.filter((node) => node.selected);
  const boardPoint = (clientX: number, clientY: number): Point => { const box = host.getBoundingClientRect(); return { x: clientX - box.left, y: clientY - box.top }; };
  const documentPoint = (clientX: number, clientY: number) => toDocument(view, boardPoint(clientX, clientY));

  // ---- document → flow -------------------------------------------------
  function flowNode(node: CanvasNode, key: string, old?: FlowNode): FlowNode {
    return { id: node.id, type: 'card', position: { x: node.x, y: node.y }, width: node.width, height: node.height, data: { node, key }, selected: old?.selected ?? false, zIndex: node.type === 'group' ? -1 : 0, ariaRole: 'article', ariaLabel: 'Canvas card: ' + canvasNodeTitle(node), class: node.type === 'group' ? 'canvas-flow-group' : undefined };
  }
  function flowEdge(edge: CanvasEdge, rects: Map<string, Rect>, titles: Map<string, string>, old?: FlowEdge): FlowEdge {
    const sides = edgeSides(edge, rects.get(edge.fromNode)!, rects.get(edge.toNode)!), key = JSON.stringify(edge) + sides.fromSide + sides.toSide;
    if (old && old.data!.key === key) return old;
    const color = canvasColor(edge.color), marker = { type: MarkerType.ArrowClosed, width: 16, height: 16, ...(color ? { color } : {}) };
    return { id: edge.id, source: edge.fromNode, target: edge.toNode, sourceHandle: sides.fromSide, targetHandle: sides.toSide, type: 'canvas', label: edge.label || undefined, data: { edge, key, auto: !edge.fromSide || !edge.toSide }, selected: old?.selected ?? false, markerStart: edge.fromEnd === 'arrow' ? marker : undefined, markerEnd: edge.toEnd === 'none' ? undefined : marker, style: color ? 'stroke:' + color : undefined, ariaLabel: 'Connection: ' + (edge.label ? edge.label + ', ' : '') + titles.get(edge.fromNode) + ' to ' + titles.get(edge.toNode) };
  }
  /** Rebuild the flow from the document, reusing every card and connection that did not change. */
  function reconcile(doc: CanvasDocument, fresh = false) {
    const oldNodes = new Map(fresh ? [] : nodes.map((node) => [node.id, node])), oldEdges = new Map(fresh ? [] : edges.map((edge) => [edge.id, edge]));
    const select = pendingSelect ? new Set(pendingSelect) : null;
    pendingSelect = null;
    nodes = doc.nodes.map((node) => {
      const old = oldNodes.get(node.id), key = JSON.stringify(node);
      let next = old && old.data.key === key && old.position.x === node.x && old.position.y === node.y && old.width === node.width && old.height === node.height ? old : flowNode(node, key, old);
      if (select && !!next.selected !== select.has(node.id)) next = { ...next, selected: select.has(node.id) };
      return next;
    });
    const rects = new Map(doc.nodes.map((node) => [node.id, node as Rect])), titles = new Map(doc.nodes.map((node) => [node.id, canvasNodeTitle(node)]));
    edges = doc.edges.map((edge) => { const next = flowEdge(edge, rects, titles, oldEdges.get(edge.id)); return select && next.selected ? { ...next, selected: false } : next; });
  }
  /** Re-pick sides for unpinned connections while their cards move. */
  function refreshEdges(moved: Set<string>) {
    const rects = new Map(nodes.map((node) => [node.id, rectOf(node)]));
    let changed = false;
    const next = edges.map((edge) => {
      if (!edge.data!.auto || !moved.has(edge.source) && !moved.has(edge.target)) return edge;
      const sides = edgeSides(edge.data!.edge, rects.get(edge.source)!, rects.get(edge.target)!);
      if (sides.fromSide === edge.sourceHandle && sides.toSide === edge.targetHandle) return edge;
      changed = true;
      return { ...edge, sourceHandle: sides.fromSide, targetHandle: sides.toSide };
    });
    if (changed) edges = next;
  }
  function dropNudge() { if (nudge) { clearTimeout(nudge.timer); nudge = null; } }
  $effect(() => {
    const text = content, identity = documentId;
    untrack(() => {
      const fresh = identity !== loadedId;
      if (nudge && (fresh || nudge.snapshot.text !== text)) dropNudge();
      if (gesture && (fresh || gesture.snapshot.text !== text)) gesture.cancelled = true;
      try {
        const next = own && own.text === text ? own.canvas : parseCanvas(text);
        own = null; canvas = next; parseError = false; error = '';
        if (fresh) { loadedId = identity; detailId = ''; editing = ''; editingEdge = ''; menu = null; guides = null; resize = null; pendingSelect = null; pendingEdit = ''; pendingReveal = ''; resetNoteSearch(); }
        reconcile(next, fresh);
        if (fresh) setView(views.get(identity) ?? fitted(next));
        if (detailId && !next.nodes.some((node) => node.id === detailId)) { detailId = ''; resetNoteSearch(); }
        if (editing && !next.nodes.some((node) => node.id === editing)) editing = '';
        if (pendingEdit && next.nodes.some((node) => node.id === pendingEdit)) editing = pendingEdit;
        pendingEdit = '';
        if (pendingReveal) { const id = pendingReveal; pendingReveal = ''; reveal(id); }
      } catch (cause) {
        own = null; canvas = { nodes: [], edges: [] }; nodes = []; edges = []; detailId = ''; editing = ''; editingEdge = ''; resetNoteSearch(); parseError = true; error = cause instanceof Error ? cause.message : String(cause);
        if (fresh) { loadedId = identity; setView({ x: 0, y: 0, zoom: 1 }); }
      }
    });
  });

  // ---- flow → document -------------------------------------------------
  function commit(mutate: (value: CanvasDocument) => void, source?: Snapshot) {
    flushNudge();
    const from = source ?? current();
    try {
      if (!matches(from)) throw new Error('Canvas changed. Select the card again before applying.');
      const next = mutateCanvasDocument(from.text, mutate);
      own = next;
      if (!apply(next.text, from)) { own = null; throw new Error('Canvas changed. Try the action again.'); }
      const result = { text: next.text, documentId: from.documentId };
      // The details form follows this view's own changes, never outside edits or history.
      if (formSnapshot && formSnapshot.documentId === from.documentId && formSnapshot.text === from.text) formSnapshot = result;
      error = ''; message = 'Canvas updated.';
      return result;
    } catch (cause) { message = ''; error = cause instanceof Error ? cause.message : String(cause); return null; }
  }
  /**
   * Commit positions and sizes the flow already shows. Svelte Flow applies a
   * gesture's last change in a microtask, after its stop callback, so the flow
   * is matched to the document once that has landed: on success this settles
   * rounding and guide snapping, on failure it puts the document's values back.
   */
  function commitGeometry(changes: Map<string, Partial<Geometry>>, source: Snapshot) {
    if (changes.size) commit((value) => applyGeometry(value, changes), source);
    settle();
  }
  function settle() { const identity = loadedId; void tick().then(() => { if (identity === loadedId && !gesture && !resize && !nudge) reconcile(canvas); }); }

  // ---- viewport ----------------------------------------------------------
  function setView(next: View, duration = 0) {
    view = next;
    if (!flow) return;
    if (!duration) { easing = 0; eased = false; void flow.setViewport(next); return; }
    const ticket = ++easing;
    eased = true;
    void flow.setViewport(next, { duration }).then(() => { if (ticket === easing) { easing = 0; eased = false; } });
  }
  $effect(() => { const live = viewport; untrack(() => { if (!easing) view = live; if (loadedId >= 0) views.set(loadedId, view); }); });
  function fitted(doc: CanvasDocument): View {
    const bounds = boundsOf(doc.nodes);
    return bounds && host ? fitBounds(bounds, host.clientWidth || 800, host.clientHeight || 500) : { x: 0, y: 0, zoom: 1 };
  }
  function fit() { setView(fitted(canvas), motionMs('base')); }
  function zoomAt(factor: number, clientX: number, clientY: number) { setView(zoomAtPoint(view, boardPoint(clientX, clientY), factor)); }
  function zoomButton(factor: number) { setView(zoomAtPoint(view, { x: host.clientWidth / 2, y: host.clientHeight / 2 }, factor), motionMs('base')); }
  function wheel(event: WheelEvent) {
    if (event.target instanceof Element && event.target.closest('.nowheel')) return;
    event.preventDefault();
    if (pan) return;
    // Pinch and Ctrl/Cmd+wheel zoom around the cursor; a plain wheel or two-finger scroll pans.
    if (event.ctrlKey || event.metaKey) zoomAt(wheelZoomFactor(event, { in: 1.1, out: .9 }), event.clientX, event.clientY);
    else setView({ ...view, x: view.x - event.deltaX, y: view.y - event.deltaY });
  }
  function reveal(id: string) {
    const node = canvas.nodes.find((item) => item.id === id);
    if (!node || !host) return;
    const left = node.x * view.zoom + view.x, top = node.y * view.zoom + view.y;
    if (left < 0 || left + node.width * view.zoom > host.clientWidth || top < 0 || top + node.height * view.zoom > host.clientHeight) setView({ zoom: view.zoom, x: host.clientWidth / 2 - (node.x + node.width / 2) * view.zoom, y: host.clientHeight / 2 - (node.y + node.height / 2) * view.zoom }, motionMs('base'));
  }
  // Space or the middle button pans from anywhere, including over a card.
  function panStart(event: PointerEvent) {
    shiftPress = event.button === 0 && event.shiftKey && !spaceHeld ? { x: event.clientX, y: event.clientY, ids: selectedNodes().map((node) => node.id) } : null;
    // Svelte Flow compares a new marquee with the selection it is about to clear, so
    // cards that were already selected would drop out. Clear it before the marquee starts.
    if (marquee && event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.metaKey && !spaceHeld && event.target instanceof Element && event.target.classList.contains('svelte-flow__pane')) selectOnly([]);
    if (pan || !(event.button === 1 || event.button === 0 && spaceHeld) || !(event.target instanceof Element) || !event.target.closest('.svelte-flow__node')) return;
    event.preventDefault(); event.stopPropagation();
    pan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view };
    host.setPointerCapture(event.pointerId);
  }
  function panMove(event: PointerEvent) {
    if (host.contains(event.target as globalThis.Node)) pointer = { x: event.clientX, y: event.clientY };
    if (pan?.pointerId === event.pointerId) setView({ zoom: pan.view.zoom, x: pan.view.x + event.clientX - pan.x, y: pan.view.y + event.clientY - pan.y });
  }
  // Shift is the marquee key, so Svelte Flow reads a Shift+click on a card as
  // an empty marquee. Treat a Shift press that did not travel as "add or
  // remove this card", the way a file manager does.
  function shiftClick(event: PointerEvent) {
    const press = shiftPress;
    shiftPress = null;
    if (!press || event.type !== 'pointerup' || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 3) return;
    const id = document.elementsFromPoint(event.clientX, event.clientY).map((element) => element.closest('.svelte-flow__node')?.getAttribute('data-id')).find(Boolean);
    if (!id) return;
    const next = press.ids.includes(id) ? press.ids.filter((item) => item !== id) : [...press.ids, id];
    void tick().then(() => selectOnly(next));
  }
  function panEnd(event: PointerEvent) { shiftClick(event); if (pan?.pointerId === event.pointerId) { if (host.hasPointerCapture(pan.pointerId)) host.releasePointerCapture(pan.pointerId); pan = null; } }
  // Svelte Flow starts a card drag on mousedown; with Space held the press pans instead.
  function mouseDownCapture(event: MouseEvent) { if (spaceHeld && event.target instanceof Element && event.target.closest('.svelte-flow__node')) event.stopPropagation(); }

  // ---- cards -------------------------------------------------------------
  function resetNoteSearch() { noteSerial++; noteQuery = ''; noteResults = []; noteSearchError = ''; noteSearchBusy = false; }
  function openDetails(node: CanvasNode) {
    resetNoteSearch(); flushNudge();
    detailId = node.id; cardFile = node.file ?? ''; cardLabel = node.label ?? ''; cardURL = node.url ?? '';
    formSnapshot = current();
  }
  function linkNote(node: CanvasNode) {
    if (detailId !== node.id) openDetails(node);
    message = 'Choose an open or indexed note, or enter a workspace-relative path, then Apply card.';
    void tick().then(() => { if (detailId === node.id) fileField?.focus(); });
  }
  async function searchNotes() {
    if (!selected || selected.type !== 'file' || !noteCandidates) return;
    const id = selected.id, serial = ++noteSerial, query = noteQuery.trim().slice(0, 200), source = current();
    noteSearchBusy = true; noteSearchError = ''; noteResults = [];
    try {
      const results = await noteCandidates(query);
      // Ignore a response once the card, tab, source, or details form changed.
      if (serial !== noteSerial || detailId !== id || !matches(source) || !formSnapshot || formSnapshot.text !== source.text || formSnapshot.documentId !== source.documentId) return;
      noteResults = results;
      if (!results.length) noteSearchError = query ? 'No open or indexed note matches "' + query + '". Enter a workspace-relative path above, then Apply card.' : 'No open or indexed notes are available. Enter a workspace-relative path above, then Apply card.';
    } catch (cause) {
      if (serial === noteSerial && detailId === id) noteSearchError = 'Could not search notes: ' + (cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (serial === noteSerial) noteSearchBusy = false;
    }
  }
  function chooseNote(id: string, file: string) {
    if (detailId !== id || !selected || selected.type !== 'file' || !file.trim()) return;
    cardFile = file.trim();
    noteResults = []; noteSearchError = '';
    message = 'Selected ' + cardFile + '. Apply card to save the link, then Open original.';
  }
  function newCard(type: 'text' | 'file' | 'group', variant: string, at: Point): CanvasNode {
    const width = type === 'group' ? 420 : 280, height = type === 'group' ? 300 : 180;
    const node: CanvasNode = { id: crypto.randomUUID(), type, x: coordinate(at.x - width / 2), y: coordinate(at.y - height / 2), width, height };
    if (type === 'text') node.text = variant === 'diagram' ? '```mermaid\ngraph TD\n  Idea --> Note\n```' : variant === 'blank' ? '' : 'New card';
    if (variant === 'diagram') node.label = 'Mermaid diagram';
    if (type === 'file') { node.file = ''; node.label = variant === 'media' ? 'Media' : 'Note'; }
    if (type === 'group') node.label = 'Group';
    return node;
  }
  function insert(node: CanvasNode, options: { edit?: boolean; edge?: CanvasEdge } = {}) {
    if (!commit((value) => { value.nodes.push(node); if (options.edge) value.edges.push(options.edge); })) return false;
    freshIds.add(node.id); pendingSelect = [node.id]; pendingReveal = node.id;
    if (options.edit) pendingEdit = node.id;
    return true;
  }
  /** Toolbar and empty-state add: beside the last card, or in the middle of the board. */
  function add(type: 'text' | 'file' | 'group', variant = '') {
    addOpen = false; addTrigger?.focus();
    const node = newCard(type, variant, toDocument(view, { x: (host?.clientWidth ?? 800) / 2, y: (host?.clientHeight ?? 500) / 2 }));
    const previous = [...canvas.nodes].reverse().find((item) => item.type !== 'group');
    if (previous && type !== 'group') { node.x = previous.x + previous.width + 40; node.y = previous.y; }
    insert(node);
  }
  function addAt(type: 'text' | 'file' | 'group', at: Point, edit = false) { insert(newCard(type, edit ? 'blank' : '', at), { edit }); }
  function applyCard() {
    flushNudge();
    if (!selected || !formSnapshot) return;
    if (selected.type === 'file' && cardFile && !cardFile.trim()) { error = 'Enter a note path or clear Card file to leave this card unlinked.'; return; }
    if (selected.type === 'file' && /[\r\n]/u.test(cardFile)) { error = 'Note paths cannot contain line breaks.'; return; }
    const id = selected.id;
    if (commit((value) => { const node = value.nodes.find((item) => item.id === id)!; if (node.type === 'file') node.file = cardFile.trim(); if (node.type === 'link') node.url = cardURL; if (cardLabel) node.label = cardLabel; else delete node.label; }, formSnapshot)) { formSnapshot = null; detailId = ''; resetNoteSearch(); }
  }
  function removeDetail() { const id = detailId; if (id && commit((value) => removeElements(value, [id], []))) { detailId = ''; resetNoteSearch(); } }
  function deleteSelection() {
    const ids = selectedNodes().map((node) => node.id), edgeIds = edges.filter((edge) => edge.selected).map((edge) => edge.id);
    if (!ids.length && !edgeIds.length) return false;
    commit((value) => removeElements(value, ids, edgeIds));
    return true;
  }
  function selectOnly(ids: string[], edgeIds: string[] = []) {
    const wanted = new Set(ids), wantedEdges = new Set(edgeIds);
    nodes = nodes.map((node) => !!node.selected === wanted.has(node.id) ? node : { ...node, selected: wanted.has(node.id) });
    edges = edges.map((edge) => !!edge.selected === wantedEdges.has(edge.id) ? edge : { ...edge, selected: wantedEdges.has(edge.id) });
  }
  function copySelection() {
    const ids = selectedNodes().map((node) => node.id);
    if (!ids.length) return false;
    flushNudge();
    clipboard = copyFragment(parseCanvas(content), ids);
    message = ids.length === 1 ? 'Copied 1 card.' : 'Copied ' + ids.length + ' cards.';
    return true;
  }
  function pasteFragmentAt(fragment: CanvasFragment, offset: Point) {
    let ids: string[] = [];
    if (!commit((value) => { ids = pasteFragment(value, fragment, offset, () => crypto.randomUUID()); })) return;
    for (const id of ids) freshIds.add(id);
    pendingSelect = ids;
  }
  function paste(at?: Point) {
    const bounds = clipboard && boundsOf(clipboard.nodes);
    if (!clipboard || !bounds) return false;
    const target = at ?? (pointer ? documentPoint(pointer.x, pointer.y) : toDocument(view, { x: host.clientWidth / 2, y: host.clientHeight / 2 }));
    pasteFragmentAt(clipboard, { x: Math.round(target.x - bounds.x - bounds.width / 2), y: Math.round(target.y - bounds.y - bounds.height / 2) });
    return true;
  }
  function duplicateSelection() {
    const ids = selectedNodes().map((node) => node.id);
    if (!ids.length) return false;
    flushNudge();
    pasteFragmentAt(copyFragment(parseCanvas(content), ids), { x: GRID * 2, y: GRID * 2 });
    return true;
  }
  function setColor(ids: string[], color: string | null) { commit((value) => { for (const node of value.nodes) if (ids.includes(node.id)) { if (color) node.color = color; else delete node.color; } }); }
  function startEdit(id: string) {
    const node = canvas.nodes.find((item) => item.id === id);
    if (!node) return;
    if (node.type === 'text' || node.type === 'group') { flushNudge(); editing = id; }
    else if (node.type === 'file') linkNote(node);
    else openDetails(node);
  }
  function commitEdit(id: string, text: string) {
    if (editing !== id) return;
    editing = '';
    const node = canvas.nodes.find((item) => item.id === id);
    if (!node) return;
    if (node.type === 'group') { if ((node.label ?? '') !== text) commit((value) => { const item = value.nodes.find((entry) => entry.id === id)!; if (text) item.label = text; else delete item.label; }); }
    else if (node.type === 'text' && (node.text ?? '') !== text) commit((value) => { value.nodes.find((entry) => entry.id === id)!.text = text; });
    host?.querySelector<HTMLElement>('.svelte-flow__node[data-id="' + CSS.escape(id) + '"]')?.focus({ preventScroll: true });
  }
  function commitEdgeLabel(id: string, label: string) {
    if (editingEdge !== id) return;
    editingEdge = '';
    const edge = canvas.edges.find((item) => item.id === id), next = label.trim();
    if (edge && (edge.label ?? '') !== next) commit((value) => { const item = value.edges.find((entry) => entry.id === id)!; if (next) item.label = next; else delete item.label; });
  }
  function openFile(node: CanvasNode) {
    const file = (node.file || '').trim();
    if (!file) { linkNote(node); return; }
    if (/[\r\n]/u.test(file) || file.includes(']]')) { error = 'This card path is not a valid note target. Edit Card file and Apply card.'; return; }
    openNote(file, node.subpath);
  }
  function openLink(url: string) { try { const target = new URL(url); if (!['https:', 'http:', 'mailto:'].includes(target.protocol)) throw new Error('Only HTTP, HTTPS, and mail links can open from the canvas.'); window.open(target.href, '_blank', 'noopener,noreferrer'); } catch (cause) { error = String(cause); } }

  setContext<CanvasBoard>(BOARD, {
    get editing() { return editing; },
    get editingEdge() { return editingEdge; },
    get path() { return path ?? undefined; },
    get render() { return renderCard; },
    fresh: (id) => freshIds.delete(id),
    edit: startEdit, commitEdit, commitEdgeLabel,
    details: (id) => { const node = canvas.nodes.find((item) => item.id === id); if (node) openDetails(node); },
    openFile, linkNote, openLink,
    resizeStart: (id) => { flushNudge(); resize = { id, snapshot: current() }; },
    resizeEnd: (id, geometry) => {
      const started = resize; resize = null;
      if (!started || started.id !== id || !matches(started.snapshot)) { settle(); return; }
      const before = canvas.nodes.find((node) => node.id === id), next = { x: coordinate(geometry.x), y: coordinate(geometry.y), width: Math.max(MIN_WIDTH, Math.min(MAX_SIZE, Math.round(geometry.width))), height: Math.max(MIN_HEIGHT, Math.min(MAX_SIZE, Math.round(geometry.height))) };
      const same = before && before.x === next.x && before.y === next.y && before.width === next.width && before.height === next.height;
      commitGeometry(same ? new Map() : new Map([[id, next]]), started.snapshot);
    },
  });

  // ---- dragging ----------------------------------------------------------
  function dragStart(dragged: FlowNode[]) {
    flushNudge();
    const ids = new Set(dragged.map((node) => node.id)), rects = nodes.map((node) => ({ id: node.id, ...rectOf(node) }));
    const start = new Map(nodes.filter((node) => ids.has(node.id)).map((node) => [node.id, { x: node.data.node.x, y: node.data.node.y }]));
    // Cards inside a dragged group travel with it.
    const followers = new Map<string, { leader: string; from: Point }>();
    for (const node of nodes) if (ids.has(node.id) && node.data.node.type === 'group') for (const member of groupMembers(rects, { id: node.id, ...rectOf(node) })) if (!ids.has(member) && !followers.has(member)) { const item = canvas.nodes.find((entry) => entry.id === member)!; followers.set(member, { leader: node.id, from: { x: item.x, y: item.y } }); }
    gesture = { snapshot: current(), start, followers, cancelled: false };
  }
  function dragMove(dragged: FlowNode[]) {
    const active = gesture;
    if (!active) return;
    const positions = new Map(dragged.map((node) => [node.id, node.position]));
    if (active.followers.size) nodes = nodes.map((node) => { const follow = active.followers.get(node.id), leader = follow && positions.get(follow.leader), origin = follow && active.start.get(follow.leader); return follow && leader && origin ? { ...node, position: { x: follow.from.x + leader.x - origin.x, y: follow.from.y + leader.y - origin.y } } : node; });
    refreshEdges(new Set([...active.start.keys(), ...active.followers.keys()]));
    if (dragged.length !== 1) { guides = null; return; }
    const moving = dragged[0], others = nodes.filter((node) => node.id !== moving.id && !active.followers.has(node.id)).map(rectOf);
    const next = alignmentGuides(rectOf(moving), others, GUIDE_PIXELS / view.zoom);
    guides = next.vertical === null && next.horizontal === null ? null : next;
  }
  function dragStop(dragged: FlowNode[]) {
    const active = gesture, snapTo = guides;
    gesture = null; guides = null;
    if (!active) return;
    if (active.cancelled || !matches(active.snapshot)) { settle(); return; }
    const final = new Map(nodes.map((node) => [node.id, node.position]));
    for (const node of dragged) final.set(node.id, node.position);
    const dx = snapTo?.vertical != null ? snapTo.dx : 0, dy = snapTo?.horizontal != null ? snapTo.dy : 0, changes = new Map<string, Partial<Geometry>>();
    for (const [id, from] of [...active.start, ...[...active.followers].map(([member, follow]) => [member, follow.from] as [string, Point])]) {
      const at = final.get(id);
      if (!at) continue;
      const x = coordinate(at.x + dx), y = coordinate(at.y + dy);
      if (x !== from.x || y !== from.y) changes.set(id, { x, y });
    }
    commitGeometry(changes, active.snapshot);
  }

  // ---- keyboard ----------------------------------------------------------
  /** Arrow keys preview in the flow at once and reach the document as one undo step. */
  function nudgeBy(dx: number, dy: number, resizing: boolean) {
    const chosen = selectedNodes();
    if (!chosen.length) return false;
    const selection = chosen.map((node) => node.id).join('\n') + (resizing ? '\nresize' : '');
    if (nudge && nudge.selection !== selection) flushNudge();
    if (!nudge) {
      const ids = new Set(chosen.map((node) => node.id)), rects = nodes.map((node) => ({ id: node.id, ...rectOf(node) }));
      if (!resizing) for (const node of chosen) if (node.data.node.type === 'group') for (const member of groupMembers(rects, { id: node.id, ...rectOf(node) })) ids.add(member);
      nudge = { snapshot: current(), ids, selection, timer: setTimeout(flushNudge, NUDGE_IDLE) };
    }
    const active = nudge;
    nodes = nodes.map((node) => {
      if (!active.ids.has(node.id)) return node;
      const rect = rectOf(node);
      return resizing ? { ...node, width: Math.max(MIN_WIDTH, Math.min(MAX_SIZE, rect.width + dx)), height: Math.max(MIN_HEIGHT, Math.min(MAX_SIZE, rect.height + dy)) } : { ...node, position: { x: coordinate(rect.x + dx), y: coordinate(rect.y + dy) } };
    });
    refreshEdges(active.ids);
    clearTimeout(active.timer); active.timer = setTimeout(flushNudge, NUDGE_IDLE);
    return true;
  }
  function flushNudge() {
    const pending = nudge;
    if (!pending) return;
    clearTimeout(pending.timer); nudge = null;
    const changes = new Map<string, Partial<Geometry>>();
    for (const node of nodes) if (pending.ids.has(node.id)) { const rect = rectOf(node), before = node.data.node; if (rect.x !== before.x || rect.y !== before.y || rect.width !== before.width || rect.height !== before.height) changes.set(node.id, rect); }
    commitGeometry(changes, pending.snapshot);
  }
  const typing = (target: EventTarget | null) => target instanceof Element && !!target.closest('input,textarea,select,[contenteditable=true]');
  function boardKey(event: KeyboardEvent) {
    if (typing(event.target) || parseError) return;
    const key = event.key, mod = event.ctrlKey || event.metaKey, handled = () => { event.preventDefault(); event.stopPropagation(); };
    if (key === 'Escape') { if (menu) { menu = null; handled(); } else if (gesture) { gesture.cancelled = true; guides = null; handled(); } return; }
    if (menu) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key) && !mod) {
      const step = event.shiftKey ? (snap ? GRID * 5 : 10) : snap ? GRID : 1;
      if (nudgeBy(key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0, key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0, event.altKey)) handled();
    } else if (key === 'Delete' || key === 'Backspace') { if (deleteSelection()) handled(); }
    else if (mod && !event.shiftKey && !event.altKey && key.toLowerCase() === 'a') { selectOnly(nodes.map((node) => node.id)); handled(); }
    else if (mod && !event.shiftKey && !event.altKey && key.toLowerCase() === 'c') { if (!String(window.getSelection() ?? '') && copySelection()) handled(); }
    else if (mod && !event.shiftKey && !event.altKey && key.toLowerCase() === 'v') { if (paste()) handled(); }
    else if (mod && !event.shiftKey && !event.altKey && key.toLowerCase() === 'd') { if (duplicateSelection()) handled(); }
    else if ((key === 'Enter' || key === 'F2') && !mod) {
      // Enter on a focused card selects it (Svelte Flow); Enter on the selected card edits it.
      const chosen = selectedNodes(), focused = event.target instanceof Element ? event.target.closest('.svelte-flow__node')?.getAttribute('data-id') : null;
      if (chosen.length === 1 && (key === 'F2' || focused === chosen[0].id)) { startEdit(chosen[0].id); handled(); }
    }
  }
  function historyKey(event: KeyboardEvent) {
    if (typing(event.target)) return;
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); flushNudge(); if (event.key.toLowerCase() === 'y' || event.shiftKey) redo?.(); else undo?.(); }
  }
  function windowKey(event: KeyboardEvent) {
    if (event.key === ' ') spaceHeld = event.type === 'keydown' && !typing(event.target);
    // A mouse drag does not move focus onto the board, so Escape is heard here.
    if (event.key === 'Escape' && event.type === 'keydown' && gesture) { gesture.cancelled = true; guides = null; }
  }

  // ---- connections ---------------------------------------------------------
  const newEdge = (fromNode: string, fromSide: Side, toNode: string, toSide: Side, label = ''): CanvasEdge => ({ id: crypto.randomUUID(), fromNode, fromSide, toNode, toSide, ...(label ? { label } : {}) });
  function connectSides(fromNode: string, toNode: string) {
    const from = canvas.nodes.find((node) => node.id === fromNode), to = canvas.nodes.find((node) => node.id === toNode);
    return from && to ? edgeSides({}, from, to) : null;
  }
  function connect() {
    if (!fromCard || !toCard || fromCard === toCard) { error = 'Choose two different cards.'; return; }
    const sides = connectSides(fromCard, toCard);
    if (sides && commit((value) => value.edges.push(newEdge(fromCard, sides.fromSide, toCard, sides.toSide, edgeLabel)))) { connectOpen = false; edgeLabel = ''; }
  }
  /** A connection dropped on a handle: both sides are the ones the user picked. */
  function handleConnect(connection: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) {
    const auto = connectSides(connection.source, connection.target);
    if (auto && connection.source !== connection.target) commit((value) => value.edges.push(newEdge(connection.source, (connection.sourceHandle as Side) ?? auto.fromSide, connection.target, (connection.targetHandle as Side) ?? auto.toSide)));
    // The document owns the connection list, so Svelte Flow must not add its own copy.
    return undefined as unknown as FlowEdge;
  }
  /** A connection dropped on a card body joins that card; dropped on empty space it makes a new one. */
  function connectEnd(event: MouseEvent | TouchEvent, state: { isValid: boolean | null; fromNode: { id: string } | null; fromHandle: { id?: string | null } | null }) {
    if (state.isValid || !state.fromNode) return;
    const from = canvas.nodes.find((node) => node.id === state.fromNode!.id), touch = 'changedTouches' in event ? event.changedTouches[0] : event;
    if (!from || !touch) return;
    const fromSide = (state.fromHandle?.id as Side) || 'right', at = documentPoint(touch.clientX, touch.clientY);
    const target = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.svelte-flow__node')?.getAttribute('data-id');
    if (target === from.id) return;
    const to = target ? canvas.nodes.find((node) => node.id === target) : null;
    if (to) { commit((value) => value.edges.push(newEdge(from.id, fromSide, to.id, to.type === 'group' ? edgeSides({ fromSide }, from, to).toSide : nearestSide(to, at)))); return; }
    if (target || !(event.target instanceof Element) || !host.contains(event.target)) return;
    // Too short a pull is a slip on the handle, not a request for a card.
    const origin = { x: from.x + (fromSide === 'left' ? 0 : fromSide === 'right' ? from.width : from.width / 2), y: from.y + (fromSide === 'top' ? 0 : fromSide === 'bottom' ? from.height : from.height / 2) };
    if (Math.hypot(at.x - origin.x, at.y - origin.y) * view.zoom < 24) return;
    const toSide = oppositeSide(fromSide), node = newCard('text', 'blank', { x: 0, y: 0 }), corner = placeBySide(at, toSide, node.width, node.height);
    node.x = coordinate(corner.x); node.y = coordinate(corner.y);
    insert(node, { edit: true, edge: newEdge(from.id, fromSide, node.id, toSide) });
  }

  // ---- pointer extras ------------------------------------------------------
  function doubleClick(event: MouseEvent) {
    if (parseError || !(event.target instanceof Element)) return;
    const label = event.target.closest('[data-edge-id]')?.getAttribute('data-edge-id'), edge = label ?? event.target.closest('.svelte-flow__edge')?.getAttribute('data-id');
    if (edge) { editingEdge = edge; return; }
    if (event.target.classList.contains('svelte-flow__pane')) addAt('text', documentPoint(event.clientX, event.clientY), true);
  }
  function openMenu(event: MouseEvent, kind: Menu['kind'], id = '') {
    if (parseError) return;
    event.preventDefault();
    if (kind === 'node' && id && !nodes.find((node) => node.id === id)?.selected) selectOnly([id]);
    if (kind === 'edge') selectOnly([], [id]);
    const at = boardPoint(event.clientX, event.clientY);
    menu = { kind, id, left: Math.max(4, Math.min(at.x, host.clientWidth - 196)), top: Math.max(4, Math.min(at.y, host.clientHeight - (kind === 'node' ? 232 : 200))), at: toDocument(view, at), canPaste: !!clipboard };
    void tick().then(() => menuHost?.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')?.focus());
  }
  function menuAction(run: () => void) { run(); menu = null; host?.querySelector<HTMLElement>('.svelte-flow')?.focus({ preventScroll: true }); }
  function menuKey(event: KeyboardEvent, root: HTMLElement, close: () => void) {
    const items = [...root.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)')], at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
    else if (event.key === 'Tab') close();
  }
  function dragover(event: DragEvent) {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    if (transfer.files.length || [...transfer.types].includes('Files')) { event.preventDefault(); transfer.dropEffect = 'none'; return; }
    if (![...transfer.types].includes('text/plain')) return;
    event.preventDefault(); transfer.dropEffect = 'copy';
  }
  function drop(event: DragEvent) {
    if (!event.dataTransfer) return;
    if (event.dataTransfer.files.length || [...event.dataTransfer.types].includes('Files')) { event.preventDefault(); message = 'Use Add note card or Add media card to link a file.'; return; }
    if (![...event.dataTransfer.types].includes('text/plain')) return;
    const text = event.dataTransfer.getData('text/plain');
    if (!text.trim()) return;
    event.preventDefault();
    if (text.length > MAX_DROP_TEXT) { error = 'Dropped text is too large for a canvas card (20,000 characters max).'; return; }
    const node = newCard('text', '', documentPoint(event.clientX, event.clientY));
    node.text = text;
    if (insert(node)) { pendingReveal = ''; message = 'Dropped text card added.'; }
  }

  onMount(() => {
    const outside = (event: PointerEvent) => { if (addOpen && !addMenuHost.contains(event.target as globalThis.Node)) addOpen = false; if (menu && !menuHost?.contains(event.target as globalThis.Node)) menu = null; };
    const blur = () => { spaceHeld = false; if (pan) { if (host.hasPointerCapture(pan.pointerId)) host.releasePointerCapture(pan.pointerId); pan = null; } flushNudge(); };
    const pinch = pinchZoom(host, zoomAt);
    host.addEventListener('wheel', wheel, { passive: false });
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', windowKey); window.addEventListener('keyup', windowKey); window.addEventListener('blur', blur);
    return () => { pinch.destroy(); host.removeEventListener('wheel', wheel); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', windowKey); window.removeEventListener('keyup', windowKey); window.removeEventListener('blur', blur); flushNudge(); resetNoteSearch(); };
  });
  $effect(() => { if (addOpen) queueMicrotask(() => addMenuHost.querySelector<HTMLElement>('[role=menuitem]')?.focus()); });
  const nodeTypes = { card: CanvasFlowNode }, edgeTypes = { canvas: CanvasFlowEdge };
  let menuNode = $derived(menu?.kind === 'node' ? canvas.nodes.find((node) => node.id === menu!.id) : undefined);
  let menuEdge = $derived(menu?.kind === 'edge' ? canvas.edges.find((edge) => edge.id === menu!.id) : undefined);
  const menuTargets = () => { const chosen = selectedNodes().map((node) => node.id); return chosen.length ? chosen : menu?.id ? [menu.id] : []; };
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Canvas history keys apply outside editable form fields.) -->
<section class="canvas-view" aria-label="Canvas" onkeydown={historyKey}>
  <div class="canvas-tools"><div class="canvas-add-menu" bind:this={addMenuHost}><button aria-label="Add card" aria-haspopup="menu" aria-expanded={addOpen} disabled={parseError} bind:this={addTrigger} onclick={() => addOpen = !addOpen}>Add card ⌄</button>{#if addOpen}<div role="menu" aria-label="Add card" tabindex="-1" onkeydown={(event) => menuKey(event, addMenuHost, () => { addOpen = false; addTrigger.focus(); })} in:pop out:pop={{ exit: true }}><button role="menuitem" onclick={() => add('text')}>Add text card</button><button role="menuitem" onclick={() => add('file')}>Add note card</button><button role="menuitem" onclick={() => add('file', 'media')}>Add media card</button><button role="menuitem" onclick={() => add('text', 'diagram')}>Add diagram card</button><button role="menuitem" onclick={() => add('group')}>Add group</button></div>{/if}</div><button disabled={parseError} aria-expanded={connectOpen} onclick={() => connectOpen = !connectOpen}>Connect cards</button><span class="canvas-tool-divider" aria-hidden="true"></span><button class="canvas-toggle" aria-pressed={marquee} title="Drag empty space to select cards instead of panning (or hold Shift)" onclick={() => marquee = !marquee}>Select</button><button class="canvas-toggle" aria-pressed={snap} title="Snap cards to the grid" onclick={() => { snap = !snap; remember('snap', snap); }}>Snap</button><button class="canvas-toggle" aria-pressed={minimap} title="Show the minimap" onclick={() => { minimap = !minimap; remember('minimap', minimap); }}>Map</button><span class="canvas-tool-space"></span><button class="canvas-zoom-button" aria-label="Zoom out" onclick={() => zoomButton(1 / 1.2)}>−</button><span class="canvas-zoom">{Math.round(viewport.zoom * 100)}%</span><button class="canvas-zoom-button" aria-label="Zoom in" onclick={() => zoomButton(1.2)}>+</button><button onclick={fit}>Fit canvas</button></div>
  <p class="canvas-help" title="Shift+click or Ctrl/Cmd+click adds to the selection. Arrows move the selection, Alt+arrows resize it. Ctrl/Cmd+C, V and D copy, paste and duplicate.">Drag a card to move · drag a side dot to connect · double-click to add or edit · Shift+drag to select · scroll or Space+drag to pan · right-click for more</p>
  {#if error}<div class="app-error" role="alert">{error} Use Source to inspect the original JSON.</div>{/if}
  <div class="canvas-area">
    <!-- svelte-ignore a11y_no_static_element_interactions (The board inside handles focus; this wrapper adds wheel, pan and drop handling around it.) -->
    <div class="canvas-board" class:panning={!!pan} class:easing={eased} bind:this={host} onkeydowncapture={boardKey} onpointerdowncapture={panStart} onmousedowncapture={mouseDownCapture} onpointermove={panMove} onpointerup={panEnd} onpointercancel={panEnd} onlostpointercapture={panEnd} onfocusout={(event) => { if (!(event.relatedTarget instanceof globalThis.Node) || !host.contains(event.relatedTarget)) flushNudge(); }} ondblclick={doubleClick} ondragover={dragover} ondrop={drop}>
      <SvelteFlow bind:nodes bind:edges bind:viewport {nodeTypes} {edgeTypes} class="canvas-viewport" aria-label="Canvas board" tabindex={0}
        minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM} connectionMode={ConnectionMode.Loose} selectionMode={SelectionMode.Partial} snapGrid={snap ? [GRID, GRID] : undefined}
        zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} panOnScroll={false} panOnDrag={marquee ? [1] : true} selectionOnDrag={marquee}
        nodeDragThreshold={0} onbeforedelete={async () => false} selectionKey="Shift" multiSelectionKey={['Shift', 'Meta', 'Control']} elevateNodesOnSelect={false} nodesConnectable={!parseError} connectionRadius={28}
        onlyRenderVisibleElements={nodes.length > VISIBLE_ONLY_ABOVE} defaultMarkerColor={null}
        ariaLabelConfig={{ 'node.a11yDescription.default': 'Press Enter or Space to select a card. Arrow keys move the selection, Enter edits it and Delete removes it.', 'node.a11yDescription.keyboardDisabled': 'Press Enter or Space to select a card.' }}
        isValidConnection={(connection) => connection.source !== connection.target} onbeforeconnect={handleConnect} onconnectend={connectEnd} oninit={() => setView(view)}
        onnodedragstart={({ nodes: dragged }) => dragStart(dragged)} onnodedrag={({ nodes: dragged }) => dragMove(dragged)} onnodedragstop={({ nodes: dragged }) => dragStop(dragged)}
        onselectiondragstart={(_event, dragged) => dragStart(dragged)} onselectiondrag={(_event, dragged) => dragMove(dragged)} onselectiondragstop={(_event, dragged) => dragStop(dragged)}
        onpanecontextmenu={({ event }) => openMenu(event, 'pane')} onnodecontextmenu={({ node, event }) => openMenu(event, 'node', node.id)} onselectioncontextmenu={({ nodes: chosen, event }) => openMenu(event, 'node', chosen[0]?.id)} onedgecontextmenu={({ edge, event }) => openMenu(event, 'edge', edge.id)}>
        <CanvasFlowBridge ready={(api) => flow = api} />
        {#if snap}<Background variant={BackgroundVariant.Dots} gap={GRID} size={1} />{/if}
        {#if minimap}<MiniMap pannable zoomable ariaLabel="Canvas minimap" nodeColor={(node) => canvasColor((node.data as CardData).node.color) ?? 'var(--muted)'} />{/if}
        {#if guides}<ViewportPortal target="front">{#if guides.vertical !== null}<div class="canvas-guide vertical" style={'left:' + guides.vertical + 'px;width:' + 1 / viewport.zoom + 'px'}></div>{/if}{#if guides.horizontal !== null}<div class="canvas-guide horizontal" style={'top:' + guides.horizontal + 'px;height:' + 1 / viewport.zoom + 'px'}></div>{/if}</ViewportPortal>{/if}
      </SvelteFlow>
      {#if !canvas.nodes.length && !error}<div class="canvas-empty"><strong>This canvas is empty</strong><p>Double-click anywhere to write a card, or add one here. Drag cards to move them and drag from a side to connect.</p><div class="canvas-empty-actions"><button class="canvas-empty-primary" disabled={parseError} onclick={() => add('text')}>Add text card</button><button disabled={parseError} onclick={() => add('file')}>Add note card</button></div></div>{/if}
      {#if menu}{@const open = menu}<div class="canvas-context-menu" role="menu" aria-label="Canvas actions" tabindex="-1" bind:this={menuHost} style={'left:' + open.left + 'px;top:' + open.top + 'px'} onkeydown={(event) => menuKey(event, menuHost!, () => menuAction(() => {}))} oncontextmenu={(event) => event.preventDefault()} in:pop>
        {#if open.kind === 'pane'}
          <button role="menuitem" onclick={() => menuAction(() => addAt('text', open.at, true))}>Add text card here</button>
          <button role="menuitem" onclick={() => menuAction(() => addAt('file', open.at))}>Add note card here</button>
          <button role="menuitem" onclick={() => menuAction(() => addAt('group', open.at))}>Add group here</button>
          <button role="menuitem" disabled={!open.canPaste} onclick={() => menuAction(() => paste(open.at))}>Paste</button>
          <button role="menuitem" disabled={!nodes.length} onclick={() => menuAction(() => selectOnly(nodes.map((node) => node.id)))}>Select all</button>
          <button role="menuitem" onclick={() => menuAction(fit)}>Fit canvas</button>
        {:else if open.kind === 'node'}
          {#if menuNode && (menuNode.type === 'text' || menuNode.type === 'group')}<button role="menuitem" onclick={() => menuAction(() => startEdit(open.id))}>{menuNode.type === 'group' ? 'Rename group' : 'Edit text'}</button>{/if}
          <button role="menuitem" onclick={() => menuAction(() => { if (menuNode) openDetails(menuNode); })}>Card details…</button>
          <button role="menuitem" onclick={() => menuAction(duplicateSelection)}>Duplicate</button>
          <button role="menuitem" onclick={() => menuAction(copySelection)}>Copy</button>
          <div class="canvas-swatches" role="group" aria-label="Card colour">{#each COLORS as preset}<button role="menuitem" class="canvas-swatch" aria-label={'Colour ' + preset} style={'--canvas-color:' + canvasColor(preset)} onclick={() => { const ids = menuTargets(); menuAction(() => setColor(ids, preset)); }}></button>{/each}<button role="menuitem" class="canvas-swatch none" aria-label="No colour" onclick={() => { const ids = menuTargets(); menuAction(() => setColor(ids, null)); }}>×</button></div>
          <button role="menuitem" onclick={() => menuAction(deleteSelection)}>Delete</button>
        {:else if menuEdge}
          <button role="menuitem" onclick={() => menuAction(() => editingEdge = open.id)}>{menuEdge.label ? 'Edit label' : 'Add label'}</button>
          <button role="menuitem" onclick={() => menuAction(() => commit((value) => { const edge = value.edges.find((item) => item.id === open.id)!; [edge.fromNode, edge.toNode] = [edge.toNode, edge.fromNode]; const side = edge.fromSide; if (edge.toSide) edge.fromSide = edge.toSide; else delete edge.fromSide; if (side) edge.toSide = side; else delete edge.toSide; }))}>Reverse direction</button>
          <button role="menuitem" disabled={!menuEdge.fromSide && !menuEdge.toSide} onclick={() => menuAction(() => commit((value) => { const edge = value.edges.find((item) => item.id === open.id)!; delete edge.fromSide; delete edge.toSide; }))}>Choose sides automatically</button>
          <button role="menuitem" onclick={() => menuAction(deleteSelection)}>Delete connection</button>
        {/if}
      </div>{/if}
    </div>
    {#if selected || connectOpen}<aside class="canvas-inspector" aria-label="Canvas inspector">
      {#if selected}<div class="scripts-heading"><strong>Card details</strong><button aria-label="Close card editor" onclick={() => { detailId = ''; resetNoteSearch(); }}>×</button></div><label>Card label<input aria-label="Card label" bind:value={cardLabel} /></label>{#if selected.type === 'text'}<p class="canvas-note-help">Double-click the card to edit its text in place.</p>{:else if selected.type === 'file'}<label>Card file<input aria-label="Card file" placeholder="notes/example.md" bind:this={fileField} bind:value={cardFile} /></label><p class="canvas-note-help">Enter a workspace-relative path, choose a search result, then Apply card. Open original opens the linked note at its saved heading. Missing notes can be created explicitly in the desktop app.</p>{#if noteCandidates}<div class="canvas-note-search"><label>Find note<input type="search" aria-label="Find note" maxlength="200" bind:value={noteQuery} onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void searchNotes(); } }} /></label><button type="button" disabled={noteSearchBusy} onclick={() => void searchNotes()}>{noteSearchBusy ? 'Searching…' : 'Search notes'}</button></div>{#if noteSearchError}<p class="canvas-note-status" role="alert">{noteSearchError}</p>{/if}{#if noteResults.length}<ul class="canvas-note-results" aria-label="Note results">{#each noteResults as note (note.file)}<li><button type="button" aria-label={'Use note: ' + note.file} onclick={() => chooseNote(detailId, note.file)}><strong>{note.title || note.name || note.file}</strong><span>{note.file}{note.detail ? ' · ' + note.detail : ''}</span></button></li>{/each}</ul>{/if}{/if}{:else if selected.type === 'link'}<label>Card URL<input aria-label="Card URL" bind:value={cardURL} /></label>{/if}<div class="panel-actions"><button onclick={applyCard}>Apply card</button><button onclick={removeDetail}>Delete card</button></div>{/if}
      {#if connectOpen}<strong>Connection</strong><label>From card<select aria-label="From card" bind:value={fromCard}><option value="">Choose a card</option>{#each canvas.nodes as node}<option value={node.id}>{canvasNodeTitle(node)}</option>{/each}</select></label><label>To card<select aria-label="To card" bind:value={toCard}><option value="">Choose a card</option>{#each canvas.nodes as node}<option value={node.id}>{canvasNodeTitle(node)}</option>{/each}</select></label><label>Connection label<input aria-label="Connection label" bind:value={edgeLabel} /></label><button onclick={connect}>Add connection</button>{/if}
      {#if canvas.edges.length}<details><summary>Connections</summary>{#each canvas.edges as edge}<div class="canvas-edge-row"><span>{edge.label || edge.fromNode.slice(0, 8) + ' → ' + edge.toNode.slice(0, 8)}</span><button aria-label={'Delete connection: ' + edge.id} onclick={() => commit((value) => removeElements(value, [], [edge.id]))}>×</button></div>{/each}</details>{/if}
    </aside>{/if}
  </div>
  {#if message}<div class="canvas-message" role="status">{message}</div>{/if}
</section>
