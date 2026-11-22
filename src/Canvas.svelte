<script lang="ts" module>
  import type { CanvasFragment, View } from './canvas-flow';
  // Shared by every canvas tab: copy in one board, paste in another.
  let clipboard: CanvasFragment | null = null;
  // Each document keeps its own pan and zoom while its tab stays open.
  const views = new Map<number, View>();
  // Documents whose "connections look old" hint was dismissed.
  const hintsDismissed = new Set<number>();
</script>

<script lang="ts">
  import { onMount, setContext, tick, untrack } from 'svelte';
  import { Background, BackgroundVariant, ConnectionMode, MarkerType, MiniMap, SvelteFlow, ViewportPortal, useSvelteFlow, type Edge, type Node } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/base.css';
  import './canvas-flow.css';
  import { EXIT_RATIO, motionMs, pop } from './motion';
  import CanvasFlowBridge from './CanvasFlowBridge.svelte';
  import CanvasFlowEdge from './CanvasFlowEdge.svelte';
  import CanvasFlowNode from './CanvasFlowNode.svelte';
  import { pinchZoom, wheelDelta, wheelZoomFactor } from './wheel';
  import { canvasNodeTitle, mutateCanvasDocument, parseCanvas } from './canvas';
  import type { CanvasDocument, CanvasEdge, CanvasNode } from './canvas';
  import { BOARD, type CanvasBoard, type RenderCard } from './canvas-board';
  import { GRID, MAX_SIZE, MAX_ZOOM, MIN_HEIGHT, MIN_WIDTH, MIN_ZOOM, alignmentGuides, applyGeometry, boundsOf, canvasColor, coordinate, copyFragment, edgeSides, fitBounds, groupMembers, looksRightToLeftOnly, neighbourInDirection, oppositeSide, pasteFragment, pinnedSides, placeBySide, rectsTouching, removeElements, toDocument, unpinAllSides, zoomAtPoint } from './canvas-flow';
  import type { Direction, Geometry, Guides, Rect, Side } from './canvas-flow';

  type Snapshot = { text: string; documentId: number };
  type NoteCandidate = { file: string; name?: string; title?: string; detail?: string };
  type CardData = { node: CanvasNode; key: string };
  type FlowNode = Node<CardData>;
  type FlowEdge = Edge<{ edge: CanvasEdge; key: string; auto: boolean }>;
  type Point = { x: number; y: number };
  type Menu = { kind: 'pane' | 'node' | 'edge'; id: string; left: number; top: number; at: Point; canPaste: boolean };
  type Ghost = { id: string; rect: Rect; color: string | null; group: boolean };
  const MAX_DROP_TEXT = 20_000, NUDGE_IDLE = 450, GUIDE_PIXELS = 6, VISIBLE_ONLY_ABOVE = 60, PAN_KEY_STEP = 60;
  // Cards turn into placeholders below FAR_IN and back into content above FAR_OUT;
  // the gap keeps a pinch that hovers around the threshold from flickering.
  const FAR_IN = 0.36, FAR_OUT = 0.44;
  const COLORS = ['1', '2', '3', '4', '5', '6'];
  const ARROWS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

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
  let addOpen = $state(false), menu = $state<Menu | null>(null), guides = $state<Guides | null>(null), connecting = $state(false);
  let far = $state(false), detailIn = $state(false), hintHidden = $state(false);
  let box = $state.raw<Rect | null>(null), ghosts = $state.raw<Ghost[]>([]);
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
  // Gestures in progress. Each can be cancelled with Escape; a cancelled gesture writes nothing.
  let gesture: { snapshot: Snapshot; start: Map<string, Point>; followers: Map<string, { leader: string; from: Point }>; cancelled: boolean } | null = null;
  let resize: { id: string; snapshot: Snapshot; cancelled: boolean } | null = null;
  let connection: { cancelled: boolean; reconnect: { id: string; end: 'source' | 'target' } | null } | null = null;
  let selecting: { pointerId: number; origin: Point; base: string[]; additive: boolean; moved: boolean; group: string } | null = null;
  let nudge: { snapshot: Snapshot; ids: Set<string>; selection: string; timer: ReturnType<typeof setTimeout> } | null = null;
  let pan = $state.raw<{ pointerId: number; x: number; y: number; view: View } | null>(null), spaceHeld = $state(false);
  let pointer: Point | null = null, swallowMouseDown = false, swallowClick = false;
  let pendingSelect: string[] | null = null, pendingEdit = '', pendingReveal = '', pendingFocus = '';
  const freshIds = new Set<string>();

  const current = (): Snapshot => ({ text: content, documentId });
  const matches = (source: Snapshot) => source.documentId === documentId && source.text === content;
  const rectOf = (node: FlowNode): Rect => ({ x: node.position.x, y: node.position.y, width: node.width ?? node.data.node.width, height: node.height ?? node.data.node.height });
  const selectedNodes = () => nodes.filter((node) => node.selected);
  const boardPoint = (clientX: number, clientY: number): Point => { const frame = host.getBoundingClientRect(); return { x: clientX - frame.left, y: clientY - frame.top }; };
  const documentPoint = (clientX: number, clientY: number) => toDocument(view, boardPoint(clientX, clientY));
  const cardElement = (id: string) => host?.querySelector<HTMLElement>('.svelte-flow__node[data-id="' + CSS.escape(id) + '"]');
  const focusBoard = () => host?.querySelector<HTMLElement>('.svelte-flow')?.focus({ preventScroll: true });
  const count = (total: number, noun: string) => total + ' ' + noun + (total === 1 ? '' : 's');

  // ---- document → flow -------------------------------------------------
  function flowNode(node: CanvasNode, key: string, old?: FlowNode): FlowNode {
    return { id: node.id, type: 'card', position: { x: node.x, y: node.y }, width: node.width, height: node.height, data: { node, key }, selected: old?.selected ?? false, zIndex: node.type === 'group' ? -1 : 0, ariaRole: 'article', ariaLabel: 'Canvas card: ' + canvasNodeTitle(node), class: node.type === 'group' ? 'canvas-flow-group' : undefined };
  }
  function flowEdge(edge: CanvasEdge, rects: Map<string, Rect>, titles: Map<string, string>, old?: FlowEdge): FlowEdge {
    const sides = edgeSides(edge, rects.get(edge.fromNode)!, rects.get(edge.toNode)!), key = JSON.stringify(edge) + sides.fromSide + sides.toSide + titles.get(edge.fromNode) + '\n' + titles.get(edge.toNode);
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
      // A document that changed underneath a gesture ends that gesture without a write.
      if (nudge && (fresh || nudge.snapshot.text !== text)) dropNudge();
      if (gesture && (fresh || gesture.snapshot.text !== text)) gesture.cancelled = true;
      if (resize && (fresh || resize.snapshot.text !== text)) resize.cancelled = true;
      try {
        const next = own && own.text === text ? own.canvas : parseCanvas(text);
        own = null; canvas = next; parseError = false; error = '';
        if (fresh) { loadedId = identity; detailId = ''; editing = ''; editingEdge = ''; menu = null; guides = null; ghosts = []; pendingSelect = null; pendingEdit = ''; pendingReveal = ''; pendingFocus = ''; hintHidden = hintsDismissed.has(identity); resetNoteSearch(); }
        reconcile(next, fresh);
        if (fresh) setView(views.get(identity) ?? fitted(next));
        if (detailId && !next.nodes.some((node) => node.id === detailId)) { detailId = ''; resetNoteSearch(); }
        if (editing && !next.nodes.some((node) => node.id === editing)) editing = '';
        if (editingEdge && !next.edges.some((edge) => edge.id === editingEdge)) editingEdge = '';
        if (pendingEdit && next.nodes.some((node) => node.id === pendingEdit)) editing = pendingEdit;
        pendingEdit = '';
        if (pendingReveal) { const id = pendingReveal; pendingReveal = ''; reveal(id); }
        if (pendingFocus) { const id = pendingFocus; pendingFocus = ''; void tick().then(() => cardElement(id)?.focus({ preventScroll: true })); }
      } catch (cause) {
        own = null; canvas = { nodes: [], edges: [] }; nodes = []; edges = []; detailId = ''; editing = ''; editingEdge = ''; resetNoteSearch(); parseError = true; error = cause instanceof Error ? cause.message : String(cause);
        if (fresh) { loadedId = identity; setView({ x: 0, y: 0, zoom: 1 }); }
      }
    });
  });

  // ---- flow → document -------------------------------------------------
  /** Apply one change to the document. A mutation that changes nothing writes nothing. */
  function commit(mutate: (value: CanvasDocument) => void, source?: Snapshot) {
    flushNudge();
    const from = source ?? current();
    try {
      if (!matches(from)) throw new Error('Canvas changed. Select the card again before applying.');
      const next = mutateCanvasDocument(from.text, mutate);
      if (!next.changed) return from;
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
  $effect(() => {
    const live = viewport;
    untrack(() => {
      if (!easing) view = live;
      if (loadedId >= 0) views.set(loadedId, view);
      if (!far && live.zoom < FAR_IN) far = true;
      else if (far && live.zoom > FAR_OUT) {
        far = false;
        // Content fades back in over the placeholders instead of popping.
        const duration = motionMs('base');
        if (duration > 0) { detailIn = true; setTimeout(() => { detailIn = false; }, duration + 40); }
      }
    });
  });
  function fitted(doc: CanvasDocument): View {
    const bounds = boundsOf(doc.nodes);
    return bounds && host ? fitBounds(bounds, host.clientWidth || 800, host.clientHeight || 500) : { x: 0, y: 0, zoom: 1 };
  }
  function fit() { setView(fitted(canvas), motionMs('base')); }
  function zoomAt(factor: number, clientX: number, clientY: number) { setView(zoomAtPoint(view, boardPoint(clientX, clientY), factor)); }
  function zoomButton(factor: number) { setView(zoomAtPoint(view, { x: host.clientWidth / 2, y: host.clientHeight / 2 }, factor), motionMs('base')); }
  function wheel(event: WheelEvent) {
    if (event.target instanceof Element && event.target.closest('.nowheel')) return;
    // This handler owns the wheel: Svelte Flow's own zoom (its Ctrl "zoom activation key")
    // must not also act on the event, or one notch would zoom twice.
    event.preventDefault(); event.stopPropagation();
    if (pan) return;
    // Pinch and Ctrl/Cmd+wheel zoom around the cursor; a plain wheel or two-finger scroll pans.
    if (event.ctrlKey || event.metaKey) { zoomAt(wheelZoomFactor(event, { in: 1.1, out: .9 }), event.clientX, event.clientY); return; }
    const delta = wheelDelta(event);
    // A mouse wheel has one axis: Shift turns it sideways where the platform has not already.
    if (event.shiftKey && !delta.x) setView({ ...view, x: view.x - delta.y });
    else setView({ ...view, x: view.x - delta.x, y: view.y - delta.y });
  }
  function reveal(id: string) {
    const node = canvas.nodes.find((item) => item.id === id);
    if (!node || !host) return;
    const left = node.x * view.zoom + view.x, top = node.y * view.zoom + view.y;
    if (left < 0 || left + node.width * view.zoom > host.clientWidth || top < 0 || top + node.height * view.zoom > host.clientHeight) setView({ zoom: view.zoom, x: host.clientWidth / 2 - (node.x + node.width / 2) * view.zoom, y: host.clientHeight / 2 - (node.y + node.height / 2) * view.zoom }, motionMs('base'));
  }

  // ---- pointer: panning over cards, and the selection box ------------------
  function pointerDown(event: PointerEvent) {
    swallowClick = false; swallowMouseDown = false;
    if (pan || selecting || !(event.target instanceof Element)) return;
    const onCard = !!event.target.closest('.svelte-flow__node'), onPane = event.target.classList.contains('svelte-flow__pane');
    // Space or the middle button pans from anywhere, including over a card.
    if ((event.button === 1 || event.button === 0 && spaceHeld) && onCard) {
      event.preventDefault(); event.stopPropagation();
      swallowMouseDown = true;
      pan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view };
      host.setPointerCapture(event.pointerId);
      return;
    }
    // A press on empty space with Shift (or with the Select tool) draws a selection box.
    // Shift, Ctrl or Cmd adds to the selection that is already there. A group is mostly
    // empty space too: Shift+drag inside one draws a box instead of dragging the group.
    const group = event.shiftKey ? event.target.closest('.svelte-flow__node.canvas-flow-group')?.getAttribute('data-id') ?? '' : '';
    const onGroup = !!group && !event.target.closest('button,input,.svelte-flow__handle,.svelte-flow__resize-control');
    if (event.button === 0 && !spaceHeld && !parseError && (onPane && (event.shiftKey || marquee) || onGroup)) {
      event.preventDefault(); event.stopPropagation();
      swallowMouseDown = true;
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      selecting = { pointerId: event.pointerId, origin: boardPoint(event.clientX, event.clientY), base: additive ? selectedNodes().map((node) => node.id) : [], additive, moved: false, group: onGroup ? group : '' };
      host.setPointerCapture(event.pointerId);
      focusBoard();
    }
  }
  // Svelte Flow pans and drags from mousedown; a press this view took over must not reach it.
  function mouseDownCapture(event: MouseEvent) { if (swallowMouseDown) { swallowMouseDown = false; event.stopPropagation(); } }
  function clickCapture(event: MouseEvent) { if (swallowClick) { swallowClick = false; event.stopPropagation(); } }
  function pointerMove(event: PointerEvent) {
    if (host.contains(event.target as globalThis.Node)) pointer = { x: event.clientX, y: event.clientY };
    if (pan?.pointerId === event.pointerId) setView({ zoom: pan.view.zoom, x: pan.view.x + event.clientX - pan.x, y: pan.view.y + event.clientY - pan.y });
    const active = selecting;
    if (active?.pointerId !== event.pointerId) return;
    const at = boardPoint(event.clientX, event.clientY);
    if (!active.moved && Math.hypot(at.x - active.origin.x, at.y - active.origin.y) < 3) return;
    active.moved = true;
    box = { x: Math.min(at.x, active.origin.x), y: Math.min(at.y, active.origin.y), width: Math.abs(at.x - active.origin.x), height: Math.abs(at.y - active.origin.y) };
    const from = toDocument(view, box), area = { ...from, width: box.width / view.zoom, height: box.height / view.zoom };
    const hits = rectsTouching(nodes.map((node) => ({ id: node.id, ...rectOf(node) })), area).map((node) => node.id);
    selectOnly([...new Set([...active.base, ...hits])]);
  }
  function pointerUp(event: PointerEvent) {
    if (pan?.pointerId === event.pointerId) endPan();
    const active = selecting;
    if (active?.pointerId !== event.pointerId) return;
    endSelecting();
    // A press that never travelled is a click: on a group (with Shift) it adds or removes that group,
    // on empty space it clears the selection unless it was additive.
    if (!active.moved && active.group) selectOnly(active.base.includes(active.group) ? active.base.filter((id) => id !== active.group) : [...active.base, active.group]);
    else if (!active.moved && !active.additive) selectOnly([]);
    // The click that follows this release belongs to the box, not to the board underneath.
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
  }
  function endPan() { if (pan) { if (host.hasPointerCapture(pan.pointerId)) host.releasePointerCapture(pan.pointerId); pan = null; } }
  function endSelecting() { if (selecting) { if (host.hasPointerCapture(selecting.pointerId)) host.releasePointerCapture(selecting.pointerId); selecting = null; box = null; } }
  function pointerLost(event: PointerEvent) { if (pan?.pointerId === event.pointerId) endPan(); if (selecting?.pointerId === event.pointerId) endSelecting(); }

  /**
   * Escape: abandon whatever is being dragged and put everything back. Svelte Flow has no
   * cancel of its own, so its gesture is ended with the release it is waiting for and the
   * stop handlers, seeing the cancelled flag, restore the document's state without writing.
   */
  function cancelGesture() {
    const releaseMouse = () => host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    // The button is still down; the click its real release produces belongs to the abandoned gesture.
    swallowClick = true;
    if (gesture) { gesture.cancelled = true; guides = null; releaseMouse(); return true; }
    if (resize) { resize.cancelled = true; releaseMouse(); return true; }
    if (connection) { connection.cancelled = true; releaseMouse(); return true; }
    if (selecting) { const base = selecting.base; endSelecting(); selectOnly(base); return true; }
    if (pan) { const before = pan.view; endPan(); setView(before); return true; }
    swallowClick = false;
    return false;
  }

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
  /** Add a card, and optionally the connection that created it, as one change. `connect` sees the card's final place. */
  function insert(node: CanvasNode, options: { edit?: boolean; connect?: (placed: CanvasNode) => CanvasEdge } = {}) {
    if (snap) { node.x = coordinate(Math.round(node.x / GRID) * GRID); node.y = coordinate(Math.round(node.y / GRID) * GRID); }
    const edge = options.connect?.(node);
    if (!commit((value) => { value.nodes.push(node); if (edge) value.edges.push(edge); })) return false;
    freshIds.add(node.id); pendingSelect = [node.id]; pendingReveal = node.id;
    if (options.edit) pendingEdit = node.id; else pendingFocus = node.id;
    return true;
  }
  /** Toolbar and empty-state add: beside the last card, or in the middle of the board. */
  function add(type: 'text' | 'file' | 'group', variant = '') {
    addOpen = false;
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
  /** Remove cards and connections as one change; the removed cards fade out where they stood. */
  function remove(ids: string[], edgeIds: string[] = []) {
    if (!ids.length && !edgeIds.length) return false;
    const leaving = nodes.filter((node) => ids.includes(node.id)).map((node) => ({ id: node.id, rect: rectOf(node), color: canvasColor(node.data.node.color), group: node.data.node.type === 'group' }));
    if (!commit((value) => removeElements(value, ids, edgeIds))) return false;
    if (motionMs('base') > 0 && leaving.length <= 40) ghosts = [...ghosts, ...leaving];
    return true;
  }
  function removeDetail() { if (detailId && remove([detailId])) { detailId = ''; resetNoteSearch(); focusBoard(); } }
  function deleteSelection() {
    if (!remove(selectedNodes().map((node) => node.id), edges.filter((edge) => edge.selected).map((edge) => edge.id))) return false;
    focusBoard();
    return true;
  }
  function vanish(element: HTMLElement, id: string) {
    const animation = element.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.92)' }], { duration: motionMs('base') * EXIT_RATIO, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
    const done = () => { ghosts = ghosts.filter((ghost) => ghost.id !== id); };
    animation.onfinish = done; animation.oncancel = done;
  }
  function selectOnly(ids: string[], edgeIds: string[] = []) {
    const wanted = new Set(ids), wantedEdges = new Set(edgeIds);
    if (nodes.some((node) => !!node.selected !== wanted.has(node.id))) nodes = nodes.map((node) => !!node.selected === wanted.has(node.id) ? node : { ...node, selected: wanted.has(node.id) });
    if (edges.some((edge) => !!edge.selected !== wantedEdges.has(edge.id))) edges = edges.map((edge) => !!edge.selected === wantedEdges.has(edge.id) ? edge : { ...edge, selected: wantedEdges.has(edge.id) });
  }
  function copySelection() {
    const ids = selectedNodes().map((node) => node.id);
    if (!ids.length) return false;
    flushNudge();
    clipboard = copyFragment(parseCanvas(content), ids);
    message = 'Copied ' + count(ids.length, 'card') + '.';
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
  /** Write the in-place editor's text to the document if it differs; the editor stays open. */
  function saveDraft(id: string, text: string) {
    const node = editing === id ? canvas.nodes.find((item) => item.id === id) : undefined;
    if (!node) return;
    if (node.type === 'group') commit((value) => { const item = value.nodes.find((entry) => entry.id === id)!; if (text) item.label = text; else delete item.label; });
    else if (node.type === 'text') commit((value) => { value.nodes.find((entry) => entry.id === id)!.text = text; });
  }
  function commitEdit(id: string, text: string) {
    if (editing !== id) return;
    saveDraft(id, text);
    editing = '';
    cardElement(id)?.focus({ preventScroll: true });
  }
  function commitEdgeLabel(id: string, label: string) {
    if (editingEdge !== id) return;
    editingEdge = '';
    const next = label.trim();
    if (canvas.edges.some((edge) => edge.id === id)) commit((value) => { const item = value.edges.find((entry) => entry.id === id)!; if (next) item.label = next; else delete item.label; });
  }
  function openFile(node: CanvasNode) {
    const file = (node.file || '').trim();
    if (!file) { linkNote(node); return; }
    if (/[\r\n]/u.test(file) || file.includes(']]')) { error = 'This card path is not a valid note target. Edit Card file and Apply card.'; return; }
    openNote(file, node.subpath);
  }
  function openLink(url: string) { try { const target = new URL(url); if (!['https:', 'http:', 'mailto:'].includes(target.protocol)) throw new Error('Only HTTP, HTTPS, and mail links can open from the canvas.'); window.open(target.href, '_blank', 'noopener,noreferrer'); } catch (cause) { error = String(cause); } }

  let selectionSize = $derived(nodes.reduce((total, node) => total + (node.selected ? 1 : 0), 0));
  setContext<CanvasBoard>(BOARD, {
    get editing() { return editing; },
    get editingEdge() { return editingEdge; },
    get selectionSize() { return selectionSize; },
    get far() { return far; },
    get path() { return path ?? undefined; },
    get render() { return renderCard; },
    fresh: (id) => freshIds.delete(id),
    edit: startEdit, saveDraft, commitEdit, commitEdgeLabel,
    details: (id) => { const node = canvas.nodes.find((item) => item.id === id); if (node) openDetails(node); },
    openFile, linkNote, openLink,
    resizeStart: (id) => { flushNudge(); resize = { id, snapshot: current(), cancelled: false }; },
    resizeEnd: (id, geometry) => {
      const started = resize; resize = null;
      if (!started || started.id !== id || started.cancelled || !matches(started.snapshot)) { settle(); return; }
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
    if (!active || active.cancelled) return;
    const positions = new Map(dragged.map((node) => [node.id, node.position]));
    if (active.followers.size) nodes = nodes.map((node) => { const follow = active.followers.get(node.id), leader = follow && positions.get(follow.leader), origin = follow && active.start.get(follow.leader); return follow && leader && origin ? { ...node, position: { x: follow.from.x + leader.x - origin.x, y: follow.from.y + leader.y - origin.y } } : node; });
    refreshEdges(new Set([...active.start.keys(), ...active.followers.keys()]));
    if (dragged.length !== 1 || snap) { guides = null; return; }
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
  /** Move keyboard focus to the nearest card in a direction, bringing it into view first. */
  function focusNeighbour(from: string, direction: Direction) {
    const rects = canvas.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y, width: node.width, height: node.height })), origin = rects.find((rect) => rect.id === from);
    const target = origin && neighbourInDirection(rects, origin, direction);
    if (!target) return false;
    reveal(target.id);
    // A card outside the view is not in the page until the view reaches it.
    const focus = (tries: number) => { const element = cardElement(target.id); if (element) element.focus({ preventScroll: true }); else if (tries > 0) setTimeout(() => focus(tries - 1), 60); };
    void tick().then(() => focus(8));
    return true;
  }
  const typing = (target: EventTarget | null) => target instanceof Element && !!target.closest('input,textarea,select,[contenteditable=true]');
  function boardKey(event: KeyboardEvent) {
    if (typing(event.target) || parseError) return;
    const key = event.key, mod = event.ctrlKey || event.metaKey, plainMod = mod && !event.shiftKey && !event.altKey, handled = () => { event.preventDefault(); event.stopPropagation(); };
    const focused = event.target instanceof Element ? event.target.closest('.svelte-flow__node')?.getAttribute('data-id') ?? '' : '';
    if (key === 'Escape') {
      // Escape backs out one level: the menu, the gesture in progress, the selection, then the focused card.
      // (Svelte Flow would also drop focus from a card it deselects; focus stays where the user is.)
      if (menu) { menu = null; focusBoard(); handled(); }
      else if (cancelGesture()) handled();
      else if (selectionSize || edges.some((edge) => edge.selected)) { selectOnly([]); handled(); }
      else if (focused) { focusBoard(); handled(); }
      return;
    }
    if (menu || event.target instanceof Element && event.target.closest('.canvas-hint')) return;
    if (ARROWS[key] && !mod) {
      const step = event.shiftKey ? (snap ? GRID * 5 : 10) : snap ? GRID : 1, horizontal = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0, vertical = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
      // With a selection, arrows move it (Alt resizes). Without one they move focus from card to card, or pan the board.
      if (nudgeBy(horizontal * step, vertical * step, event.altKey)) handled();
      else if (focused) { if (!event.altKey) { focusNeighbour(focused, ARROWS[key]); handled(); } }
      else if (!event.altKey) { setView({ ...view, x: view.x - horizontal * PAN_KEY_STEP, y: view.y - vertical * PAN_KEY_STEP }); handled(); }
    } else if (key === 'Delete' || key === 'Backspace') { if (deleteSelection()) handled(); }
    else if (plainMod && key.toLowerCase() === 'a') { selectOnly(nodes.map((node) => node.id)); handled(); }
    else if (plainMod && key.toLowerCase() === 'c') { if (!String(window.getSelection() ?? '') && copySelection()) handled(); }
    else if (plainMod && key.toLowerCase() === 'v') { if (paste()) handled(); }
    else if (plainMod && key.toLowerCase() === 'd') { if (duplicateSelection()) handled(); }
    else if ((key === 'Enter' || key === 'F2') && !mod) {
      // Enter on a focused card selects it (Svelte Flow); Enter on the selected card edits it.
      const chosen = selectedNodes();
      if (chosen.length === 1 && (key === 'F2' || focused === chosen[0].id)) { startEdit(chosen[0].id); handled(); }
    }
  }
  function historyKey(event: KeyboardEvent) {
    if (typing(event.target)) return;
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); flushNudge(); if (event.key.toLowerCase() === 'y' || event.shiftKey) redo?.(); else undo?.(); }
  }
  function windowKey(event: KeyboardEvent) {
    if (event.key === ' ') spaceHeld = event.type === 'keydown' && !typing(event.target);
    // A mouse gesture does not move focus onto the board, so Escape is heard here.
    if (event.key === 'Escape' && event.type === 'keydown' && cancelGesture()) { event.preventDefault(); event.stopPropagation(); }
  }

  // ---- connections ---------------------------------------------------------
  const cardById = (id: string) => canvas.nodes.find((node) => node.id === id);
  /** A new connection records a side only where the user picked one other than the automatic choice. */
  function newEdge(from: CanvasNode, to: CanvasNode, chosen: { fromSide?: Side | null; toSide?: Side | null } = {}, label = ''): CanvasEdge {
    return { id: crypto.randomUUID(), fromNode: from.id, ...pinnedSides(from, to, chosen), toNode: to.id, ...(label ? { label } : {}) };
  }
  function connect() {
    const from = cardById(fromCard), to = cardById(toCard);
    if (!from || !to || from === to) { error = 'Choose two different cards.'; return; }
    if (commit((value) => value.edges.push(newEdge(from, to, {}, edgeLabel)))) { connectOpen = false; edgeLabel = ''; }
  }
  function connectStart() { connection = { cancelled: false, reconnect: connection?.reconnect ?? null }; connecting = true; }
  /** A connection dropped on a side dot. The document owns the connection list, so Svelte Flow is told not to add its own copy. */
  function handleConnect(link: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) {
    const from = cardById(link.source), to = cardById(link.target);
    if (!connection?.cancelled && from && to && from !== to) commit((value) => value.edges.push(newEdge(from, to, { fromSide: link.sourceHandle as Side, toSide: link.targetHandle as Side })));
    return undefined as unknown as FlowEdge;
  }
  const dropPoint = (event: MouseEvent | TouchEvent) => 'changedTouches' in event ? event.changedTouches[0] : event;
  const cardUnder = (at: { clientX: number; clientY: number }) => document.elementFromPoint(at.clientX, at.clientY)?.closest('.svelte-flow__node')?.getAttribute('data-id') ?? '';
  /** A new connection dropped on a card body joins that card; dropped on empty space it makes a new card there. */
  function connectEnd(event: MouseEvent | TouchEvent, state: { isValid: boolean | null; fromNode: { id: string } | null; fromHandle: { id?: string | null } | null }) {
    const active = connection;
    connecting = false;
    if (!active || active.reconnect) return;
    connection = null;
    const from = state.fromNode && cardById(state.fromNode.id), at = dropPoint(event);
    if (active.cancelled || state.isValid || !from || !at) return;
    const fromSide = (state.fromHandle?.id as Side) || 'right', target = cardUnder(at), to = target ? cardById(target) : null;
    if (to) { if (to !== from) commit((value) => value.edges.push(newEdge(from, to, { fromSide }))); return; }
    if (target || !(event.target instanceof Element) || !host.contains(event.target)) return;
    // Too short a pull is a slip on the dot, not a request for a card.
    const where = documentPoint(at.clientX, at.clientY), origin = { x: from.x + (fromSide === 'left' ? 0 : fromSide === 'right' ? from.width : from.width / 2), y: from.y + (fromSide === 'top' ? 0 : fromSide === 'bottom' ? from.height : from.height / 2) };
    if (Math.hypot(where.x - origin.x, where.y - origin.y) * view.zoom < 24) return;
    const node = newCard('text', 'blank', { x: 0, y: 0 }), corner = placeBySide(where, oppositeSide(fromSide), node.width, node.height);
    node.x = coordinate(corner.x); node.y = coordinate(corner.y);
    insert(node, { edit: true, connect: (placed) => newEdge(from, placed, { fromSide }) });
  }
  /** Move one end of a connection to another card. `side` is the dot it was dropped on, if any. */
  function moveEnd(id: string, end: 'source' | 'target', cardId: string, side: Side | null) {
    const edge = canvas.edges.find((item) => item.id === id), card = cardById(cardId);
    const from = end === 'source' ? card : edge && cardById(edge.fromNode), to = end === 'target' ? card : edge && cardById(edge.toNode);
    if (!edge || !from || !to || from === to) return;
    // Only the moved end's side is reconsidered; the other end keeps what the file says.
    const picked = pinnedSides(from, to, end === 'source' ? { fromSide: side } : { toSide: side });
    commit((value) => {
      const item = value.edges.find((entry) => entry.id === id)!;
      if (end === 'source') { item.fromNode = from.id; if (picked.fromSide) item.fromSide = picked.fromSide; else delete item.fromSide; }
      else { item.toNode = to.id; if (picked.toSide) item.toSide = picked.toSide; else delete item.toSide; }
    });
  }
  function reconnectStart(_event: MouseEvent | TouchEvent, edge: FlowEdge, end: 'source' | 'target') { connection = { cancelled: false, reconnect: { id: edge.id, end } }; }
  /** An end dropped on a side dot of another card. */
  function handleReconnect(next: FlowEdge) {
    const active = connection;
    if (active?.reconnect && !active.cancelled) moveEnd(active.reconnect.id, active.reconnect.end, active.reconnect.end === 'source' ? next.source : next.target, ((active.reconnect.end === 'source' ? next.sourceHandle : next.targetHandle) as Side) ?? null);
    return false as const;
  }
  /** An end dropped on a card body moves there; dropped on empty space, or back on its own card, nothing changes. */
  function reconnectEnd(event: MouseEvent | TouchEvent, _edge: FlowEdge, _type: unknown, state: { isValid: boolean | null }) {
    const active = connection;
    connection = null; connecting = false;
    const at = dropPoint(event);
    if (!active?.reconnect || active.cancelled || state.isValid || !at) return;
    const target = cardUnder(at);
    if (target) moveEnd(active.reconnect.id, active.reconnect.end, target, null);
  }
  /** Let every connection choose its sides from where its cards are. One undo step; nothing happens unasked. */
  export function chooseSidesAutomatically() {
    if (parseError) return;
    let changed = 0;
    const result = commit((value) => { changed = unpinAllSides(value); });
    if (result) message = changed ? count(changed, 'connection') + (changed === 1 ? ' now chooses its sides' : ' now choose their sides') + ' automatically.' : 'Every connection already chooses its sides automatically.';
  }
  function dismissHint() { hintsDismissed.add(documentId); hintHidden = true; focusBoard(); }
  let pinnedCount = $derived(canvas.edges.reduce((total, edge) => total + (edge.fromSide || edge.toSide ? 1 : 0), 0));
  let hint = $derived(!hintHidden && !parseError && looksRightToLeftOnly(canvas));

  // ---- menus, double-click and drops ----------------------------------------
  function doubleClick(event: MouseEvent) {
    if (parseError || !(event.target instanceof Element)) return;
    const label = event.target.closest('[data-edge-id]')?.getAttribute('data-edge-id'), edge = label ?? event.target.closest('.svelte-flow__edge')?.getAttribute('data-id');
    if (edge) { editingEdge = edge; return; }
    if (event.target.classList.contains('svelte-flow__pane')) addAt('text', documentPoint(event.clientX, event.clientY), true);
  }
  // A connection's label is not part of its line, so the label opens the connection's menu itself.
  function labelMenu(event: MouseEvent) {
    const id = event.target instanceof Element ? event.target.closest('[data-edge-id]')?.getAttribute('data-edge-id') : null;
    if (id) openMenu(event, 'edge', id);
  }
  function openMenu(event: MouseEvent, kind: Menu['kind'], id = '') {
    if (parseError) return;
    event.preventDefault();
    if (kind === 'node' && id && !nodes.find((node) => node.id === id)?.selected) selectOnly([id]);
    if (kind === 'edge') selectOnly([], [id]);
    const at = boardPoint(event.clientX, event.clientY);
    menu = { kind, id, left: Math.max(4, Math.min(at.x, host.clientWidth - 240)), top: Math.max(4, Math.min(at.y, host.clientHeight - 250)), at: toDocument(view, at), canPaste: !!clipboard };
    void tick().then(() => menuHost?.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')?.focus());
  }
  /** Run a menu item. Focus returns to the board unless the action moved it (an editor that opened). */
  function menuAction(run: () => void) { run(); menu = null; if (!editing && !editingEdge) focusBoard(); }
  function menuKey(event: KeyboardEvent, root: HTMLElement, close: () => void) {
    const items = [...root.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)')], at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); event.stopPropagation(); items[event.key === 'Home' ? 0 : items.length - 1]?.focus(); }
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
    const blur = () => { spaceHeld = false; cancelGesture(); flushNudge(); };
    const pinch = pinchZoom(host, zoomAt);
    host.addEventListener('wheel', wheel, { passive: false, capture: true });
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', windowKey); window.addEventListener('keyup', windowKey); window.addEventListener('blur', blur);
    return () => { pinch.destroy(); host.removeEventListener('wheel', wheel, { capture: true }); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', windowKey); window.removeEventListener('keyup', windowKey); window.removeEventListener('blur', blur); flushNudge(); resetNoteSearch(); };
  });
  $effect(() => { if (addOpen) queueMicrotask(() => addMenuHost.querySelector<HTMLElement>('[role=menuitem]')?.focus()); });
  const nodeTypes = { card: CanvasFlowNode }, edgeTypes = { canvas: CanvasFlowEdge };
  let menuNode = $derived(menu?.kind === 'node' ? canvas.nodes.find((node) => node.id === menu!.id) : undefined);
  let menuEdge = $derived(menu?.kind === 'edge' ? canvas.edges.find((edge) => edge.id === menu!.id) : undefined);
  const menuTargets = () => { const chosen = selectedNodes().map((node) => node.id); return chosen.length ? chosen : menu?.id ? [menu.id] : []; };
  let titles = $derived(new Map(canvas.nodes.map((node) => [node.id, canvasNodeTitle(node)])));
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Canvas history keys apply outside editable form fields.) -->
<section class="canvas-view" aria-label="Canvas" onkeydown={historyKey}>
  <div class="canvas-tools"><div class="canvas-add-menu" bind:this={addMenuHost}><button aria-label="Add card" aria-haspopup="menu" aria-expanded={addOpen} disabled={parseError} bind:this={addTrigger} onclick={() => addOpen = !addOpen}>Add card ⌄</button>{#if addOpen}<div role="menu" aria-label="Add card" tabindex="-1" onkeydown={(event) => menuKey(event, addMenuHost, () => { addOpen = false; addTrigger.focus(); })} in:pop out:pop={{ exit: true }}><button role="menuitem" onclick={() => add('text')}>Add text card</button><button role="menuitem" onclick={() => add('file')}>Add note card</button><button role="menuitem" onclick={() => add('file', 'media')}>Add media card</button><button role="menuitem" onclick={() => add('text', 'diagram')}>Add diagram card</button><button role="menuitem" onclick={() => add('group')}>Add group</button></div>{/if}</div><button disabled={parseError} aria-expanded={connectOpen} onclick={() => connectOpen = !connectOpen}>Connect cards</button><span class="canvas-tool-divider" aria-hidden="true"></span><button class="canvas-toggle" aria-pressed={marquee} title="Drag empty space to select cards instead of panning (or hold Shift)" onclick={() => marquee = !marquee}>Select</button><button class="canvas-toggle" aria-pressed={snap} title="Snap cards to the grid" onclick={() => { snap = !snap; remember('snap', snap); }}>Snap</button><button class="canvas-toggle" aria-pressed={minimap} title="Show the minimap" onclick={() => { minimap = !minimap; remember('minimap', minimap); }}>Map</button><span class="canvas-tool-space"></span><button class="canvas-zoom-button" aria-label="Zoom out" onclick={() => zoomButton(1 / 1.2)}>−</button><span class="canvas-zoom">{Math.round(viewport.zoom * 100)}%</span><button class="canvas-zoom-button" aria-label="Zoom in" onclick={() => zoomButton(1.2)}>+</button><button onclick={fit}>Fit canvas</button></div>
  <p class="canvas-help" title="Shift+click or Ctrl/Cmd+click adds to the selection. Arrows move the selection or, with none, the focus; Alt+arrows resize. Ctrl/Cmd+C, V and D copy, paste and duplicate. Escape cancels a drag.">Drag a card to move · drag a side dot to connect · double-click to add or edit · Shift+drag to select · scroll or Space+drag to pan · right-click for more</p>
  {#if error}<div class="app-error" role="alert">{error} Use Source to inspect the original JSON.</div>{/if}
  <div class="canvas-area">
    <!-- svelte-ignore a11y_no_static_element_interactions (The board inside handles focus; this wrapper adds wheel, pan, selection-box and drop handling around it.) -->
    <div class="canvas-board" class:panning={!!pan} class:pan-ready={spaceHeld} class:select-tool={marquee} class:easing={eased} class:connecting class:far class:detail-in={detailIn} bind:this={host} onkeydowncapture={boardKey} onpointerdowncapture={pointerDown} onmousedowncapture={mouseDownCapture} onclickcapture={clickCapture} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={pointerLost} onlostpointercapture={pointerLost} onfocusout={(event) => { if (!(event.relatedTarget instanceof globalThis.Node) || !host.contains(event.relatedTarget)) flushNudge(); }} ondblclick={doubleClick} oncontextmenu={labelMenu} ondragover={dragover} ondrop={drop}>
      <!-- Selection, deletion and wheel zoom are handled here, so Svelte Flow's own keys for them are empty. -->
      <SvelteFlow bind:nodes bind:edges bind:viewport {nodeTypes} {edgeTypes} class="canvas-viewport" aria-label="Canvas board" tabindex={0}
        minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM} connectionMode={ConnectionMode.Loose} snapGrid={snap ? [GRID, GRID] : undefined}
        zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} panOnScroll={false} panOnDrag={marquee ? [1] : true}
        nodeDragThreshold={0} selectionKey={[]} deleteKey={[]} zoomActivationKey={[]} multiSelectionKey={['Shift', 'Meta', 'Control']} elevateNodesOnSelect={false} nodesConnectable={!parseError} connectionRadius={28}
        onlyRenderVisibleElements={nodes.length > VISIBLE_ONLY_ABOVE} defaultMarkerColor={null} attributionPosition="bottom-left"
        ariaLabelConfig={{ 'node.a11yDescription.default': 'Press Enter or Space to select a card, then Enter to edit it. Arrow keys move the selection, or move between cards when nothing is selected. Delete removes the selection.', 'node.a11yDescription.keyboardDisabled': 'Press Enter or Space to select a card.', 'edge.a11yDescription.default': 'Press Enter or Space to select a connection, then Delete to remove it.' }}
        isValidConnection={(link) => link.source !== link.target} onbeforeconnect={handleConnect} onconnectstart={connectStart} onconnectend={connectEnd} onreconnectstart={reconnectStart} onbeforereconnect={handleReconnect} onreconnectend={reconnectEnd} oninit={() => setView(view)}
        onnodedragstart={({ nodes: dragged }) => dragStart(dragged)} onnodedrag={({ nodes: dragged }) => dragMove(dragged)} onnodedragstop={({ nodes: dragged }) => dragStop(dragged)}
        onpanecontextmenu={({ event }) => openMenu(event, 'pane')} onnodecontextmenu={({ node, event }) => openMenu(event, 'node', node.id)} onedgecontextmenu={({ edge, event }) => openMenu(event, 'edge', edge.id)}>
        <CanvasFlowBridge ready={(api) => flow = api} />
        {#if snap && !far}<Background variant={BackgroundVariant.Dots} gap={GRID} size={1} />{/if}
        {#if minimap}<MiniMap pannable zoomable ariaLabel="Canvas minimap" nodeColor={(node) => canvasColor((node.data as CardData).node.color) ?? 'var(--muted)'} />{/if}
        {#if guides || ghosts.length}<ViewportPortal target="front">
          {#if guides?.vertical != null}<div class="canvas-guide vertical" style={'left:' + guides.vertical + 'px;width:' + 1 / viewport.zoom + 'px'}></div>{/if}
          {#if guides?.horizontal != null}<div class="canvas-guide horizontal" style={'top:' + guides.horizontal + 'px;height:' + 1 / viewport.zoom + 'px'}></div>{/if}
          {#each ghosts as ghost (ghost.id)}<div class="canvas-ghost" class:canvas-group={ghost.group} class:colored={!!ghost.color} aria-hidden="true" use:vanish={ghost.id} style={'left:' + ghost.rect.x + 'px;top:' + ghost.rect.y + 'px;width:' + ghost.rect.width + 'px;height:' + ghost.rect.height + 'px' + (ghost.color ? ';--canvas-color:' + ghost.color : '')}></div>{/each}
        </ViewportPortal>{/if}
      </SvelteFlow>
      {#if box}<div class="canvas-marquee" aria-hidden="true" style={'left:' + box.x + 'px;top:' + box.y + 'px;width:' + box.width + 'px;height:' + box.height + 'px'}></div>{/if}
      {#if hint}<div class="canvas-hint" role="note" aria-label="Connection sides" in:pop><span>These connections all leave from the right and enter from the left, the way earlier versions of Notation wrote them.</span><button onclick={() => { chooseSidesAutomatically(); focusBoard(); }}>Choose sides automatically</button><button aria-label="Dismiss hint" onclick={dismissHint}>×</button></div>{/if}
      {#if !canvas.nodes.length && !error}<div class="canvas-empty"><strong>This canvas is empty</strong><p>Double-click anywhere to write a card. Drag from a dot on a card's side to connect it to another, or drop the line on empty space to make a new card.</p><div class="canvas-empty-actions"><button class="canvas-empty-primary" disabled={parseError} onclick={() => add('text')}>Add text card</button><button disabled={parseError} onclick={() => add('file')}>Add note card</button></div></div>{/if}
      {#if menu}{@const open = menu}<div class="canvas-context-menu" role="menu" aria-label="Canvas actions" tabindex="-1" bind:this={menuHost} style={'left:' + open.left + 'px;top:' + open.top + 'px'} onkeydown={(event) => menuKey(event, menuHost!, () => menuAction(() => {}))} oncontextmenu={(event) => event.preventDefault()} in:pop>
        {#if open.kind === 'pane'}
          <button role="menuitem" onclick={() => menuAction(() => addAt('text', open.at, true))}>Add text card here</button>
          <button role="menuitem" onclick={() => menuAction(() => addAt('file', open.at))}>Add note card here</button>
          <button role="menuitem" onclick={() => menuAction(() => addAt('group', open.at))}>Add group here</button>
          <button role="menuitem" disabled={!open.canPaste} onclick={() => menuAction(() => paste(open.at))}>Paste</button>
          <button role="menuitem" disabled={!nodes.length} onclick={() => menuAction(() => selectOnly(nodes.map((node) => node.id)))}>Select all</button>
          <button role="menuitem" disabled={!pinnedCount} onclick={() => menuAction(chooseSidesAutomatically)}>Choose sides automatically for all connections</button>
          <button role="menuitem" onclick={() => menuAction(fit)}>Fit canvas</button>
        {:else if open.kind === 'node'}
          {#if menuNode && (menuNode.type === 'text' || menuNode.type === 'group')}<button role="menuitem" onclick={() => menuAction(() => startEdit(open.id))}>{menuNode.type === 'group' ? 'Rename group' : 'Edit text'}</button>{/if}
          <button role="menuitem" onclick={() => menuAction(() => { if (menuNode) openDetails(menuNode); })}>Card details…</button>
          <button role="menuitem" onclick={() => menuAction(duplicateSelection)}>Duplicate</button>
          <button role="menuitem" onclick={() => menuAction(copySelection)}>Copy</button>
          <div class="canvas-swatches" role="group" aria-label="Card colour">{#each COLORS as preset}<button role="menuitem" class="canvas-swatch" aria-label={'Colour ' + preset} style={'--canvas-color:' + canvasColor(preset)} onclick={() => { const ids = menuTargets(); menuAction(() => setColor(ids, preset)); }}></button>{/each}<button role="menuitem" class="canvas-swatch none" aria-label="No colour" onclick={() => { const ids = menuTargets(); menuAction(() => setColor(ids, null)); }}>×</button></div>
          <button role="menuitem" onclick={() => menuAction(deleteSelection)}>Delete</button>
        {:else if menuEdge}
          {@const shown = edges.find((edge) => edge.id === open.id)}
          <button role="menuitem" onclick={() => menuAction(() => editingEdge = open.id)}>{menuEdge.label ? 'Edit label' : 'Add label'}</button>
          <button role="menuitem" onclick={() => menuAction(() => commit((value) => { const edge = value.edges.find((item) => item.id === open.id)!; [edge.fromNode, edge.toNode] = [edge.toNode, edge.fromNode]; const side = edge.fromSide; if (edge.toSide) edge.fromSide = edge.toSide; else delete edge.fromSide; if (side) edge.toSide = side; else delete edge.toSide; }))}>Reverse direction</button>
          {#if menuEdge.fromSide && menuEdge.toSide}
            <button role="menuitem" onclick={() => menuAction(() => commit((value) => { const edge = value.edges.find((item) => item.id === open.id)!; delete edge.fromSide; delete edge.toSide; }))}>Choose sides automatically</button>
          {:else}
            <button role="menuitem" disabled={!shown} onclick={() => menuAction(() => commit((value) => { const edge = value.edges.find((item) => item.id === open.id)!; edge.fromSide = shown!.sourceHandle as Side; edge.toSide = shown!.targetHandle as Side; }))}>Keep these sides</button>
          {/if}
          <button role="menuitem" onclick={() => menuAction(deleteSelection)}>Delete connection</button>
        {/if}
      </div>{/if}
    </div>
    {#if selected || connectOpen}<aside class="canvas-inspector" aria-label="Canvas inspector">
      {#if selected}<div class="scripts-heading"><strong>Card details</strong><button aria-label="Close card editor" onclick={() => { detailId = ''; resetNoteSearch(); }}>×</button></div><label>Card label<input aria-label="Card label" bind:value={cardLabel} /></label>{#if selected.type === 'text'}<p class="canvas-note-help">Double-click the card to edit its text in place.</p>{:else if selected.type === 'file'}<label>Card file<input aria-label="Card file" placeholder="notes/example.md" bind:this={fileField} bind:value={cardFile} /></label><p class="canvas-note-help">Enter a workspace-relative path, choose a search result, then Apply card. Open original opens the linked note at its saved heading. Missing notes can be created explicitly in the desktop app.</p>{#if noteCandidates}<div class="canvas-note-search"><label>Find note<input type="search" aria-label="Find note" maxlength="200" bind:value={noteQuery} onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void searchNotes(); } }} /></label><button type="button" disabled={noteSearchBusy} onclick={() => void searchNotes()}>{noteSearchBusy ? 'Searching…' : 'Search notes'}</button></div>{#if noteSearchError}<p class="canvas-note-status" role="alert">{noteSearchError}</p>{/if}{#if noteResults.length}<ul class="canvas-note-results" aria-label="Note results">{#each noteResults as note (note.file)}<li><button type="button" aria-label={'Use note: ' + note.file} onclick={() => chooseNote(detailId, note.file)}><strong>{note.title || note.name || note.file}</strong><span>{note.file}{note.detail ? ' · ' + note.detail : ''}</span></button></li>{/each}</ul>{/if}{/if}{:else if selected.type === 'link'}<label>Card URL<input aria-label="Card URL" bind:value={cardURL} /></label>{/if}<div class="panel-actions"><button onclick={applyCard}>Apply card</button><button onclick={removeDetail}>Delete card</button></div>{/if}
      {#if connectOpen}<strong>Connection</strong><label>From card<select aria-label="From card" bind:value={fromCard}><option value="">Choose a card</option>{#each canvas.nodes as node}<option value={node.id}>{canvasNodeTitle(node)}</option>{/each}</select></label><label>To card<select aria-label="To card" bind:value={toCard}><option value="">Choose a card</option>{#each canvas.nodes as node}<option value={node.id}>{canvasNodeTitle(node)}</option>{/each}</select></label><label>Connection label<input aria-label="Connection label" bind:value={edgeLabel} /></label><button onclick={connect}>Add connection</button>{/if}
      {#if canvas.edges.length}<details><summary>Connections</summary>{#each canvas.edges as edge}<div class="canvas-edge-row"><span>{edge.label ? edge.label + ' · ' : ''}{titles.get(edge.fromNode)} → {titles.get(edge.toNode)}</span><button aria-label={'Delete connection: ' + edge.id} onclick={() => remove([], [edge.id])}>×</button></div>{/each}</details>{/if}
    </aside>{/if}
  </div>
  {#if message}<div class="canvas-message" role="status">{message}</div>{/if}
</section>
