// Pure geometry and document helpers for the Svelte Flow canvas. Nothing here
// touches the DOM or Svelte, so the Node test suite can import it directly.
import type { CanvasDocument, CanvasEdge, CanvasNode } from './canvas';

export type Side = 'top' | 'right' | 'bottom' | 'left';
export type Rect = { x: number; y: number; width: number; height: number };
export type View = { x: number; y: number; zoom: number };

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;
export const GRID = 20;
export const MIN_WIDTH = 120;
export const MIN_HEIGHT = 80;
export const MAX_SIZE = 1_000_000;
const LIMIT = 1_000_000;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
/** A document coordinate: an integer inside the JSON Canvas bounds this app accepts. */
export const coordinate = (value: number) => clamp(Math.round(value), -LIMIT, LIMIT);

/**
 * Zoom by `factor` keeping the board point under `point` fixed. `point` is in
 * pixels from the board's top-left corner. The factor is applied after
 * clamping, so hitting a zoom limit never pans the board.
 */
export function zoomAtPoint(view: View, point: { x: number; y: number }, factor: number, min = MIN_ZOOM, max = MAX_ZOOM): View {
  const zoom = clamp(view.zoom * factor, min, max), ratio = zoom / view.zoom;
  return { zoom, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}

/** Board pixels to document coordinates. */
export function toDocument(view: View, point: { x: number; y: number }) {
  return { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom };
}

/** The view that shows `bounds` with `padding` pixels around it, never zoomed in past `max`. */
export function fitBounds(bounds: Rect, width: number, height: number, padding = 40, min = MIN_ZOOM, max = 1): View {
  const zoom = clamp(Math.min((width - padding * 2) / Math.max(1, bounds.width), (height - padding * 2) / Math.max(1, bounds.height)), min, max);
  return { zoom, x: width / 2 - (bounds.x + bounds.width / 2) * zoom, y: height / 2 - (bounds.y + bounds.height / 2) * zoom };
}

export function boundsOf(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.x)), top = Math.min(...rects.map((rect) => rect.y));
  return { x: left, y: top, width: Math.max(...rects.map((rect) => rect.x + rect.width)) - left, height: Math.max(...rects.map((rect) => rect.y + rect.height)) - top };
}

/**
 * Sides for a connection whose file does not pin them: the pair that faces
 * across the larger gap between the two cards, so an arrow never loops back
 * around its own card.
 */
export function autoSides(from: Rect, to: Rect): { fromSide: Side; toSide: Side } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2), dy = to.y + to.height / 2 - (from.y + from.height / 2);
  const gapX = Math.max(to.x - (from.x + from.width), from.x - (to.x + to.width));
  const gapY = Math.max(to.y - (from.y + from.height), from.y - (to.y + to.height));
  const horizontal = gapX === gapY ? Math.abs(dx) >= Math.abs(dy) : gapX > gapY;
  if (horizontal) return dx >= 0 ? { fromSide: 'right', toSide: 'left' } : { fromSide: 'left', toSide: 'right' };
  return dy >= 0 ? { fromSide: 'bottom', toSide: 'top' } : { fromSide: 'top', toSide: 'bottom' };
}

/** Sides to draw an edge with: the file's own where it pins them, geometry otherwise. */
export function edgeSides(edge: Pick<CanvasEdge, 'fromSide' | 'toSide'>, from: Rect, to: Rect): { fromSide: Side; toSide: Side } {
  if (edge.fromSide && edge.toSide) return { fromSide: edge.fromSide, toSide: edge.toSide };
  const auto = autoSides(from, to);
  return { fromSide: edge.fromSide ?? auto.fromSide, toSide: edge.toSide ?? auto.toSide };
}

/** The side of `rect` nearest to a point, for a connection dropped on a card body. */
export function nearestSide(rect: Rect, point: { x: number; y: number }): Side {
  const distances: [Side, number][] = [['left', Math.abs(point.x - rect.x)], ['right', Math.abs(point.x - rect.x - rect.width)], ['top', Math.abs(point.y - rect.y)], ['bottom', Math.abs(point.y - rect.y - rect.height)]];
  return distances.sort((a, b) => a[1] - b[1])[0][0];
}

export const oppositeSide = (side: Side): Side => side === 'left' ? 'right' : side === 'right' ? 'left' : side === 'top' ? 'bottom' : 'top';

/** Top-left corner for a new card whose `side` midpoint sits at `point`. */
export function placeBySide(point: { x: number; y: number }, side: Side, width: number, height: number) {
  return { x: point.x - (side === 'left' ? 0 : side === 'right' ? width : width / 2), y: point.y - (side === 'top' ? 0 : side === 'bottom' ? height : height / 2) };
}

/**
 * JSON Canvas groups own no children; membership is geometric. A card belongs
 * to a group when the group's rectangle fully contains it.
 */
export function groupMembers(nodes: (Rect & { id: string })[], group: Rect & { id: string }): string[] {
  return nodes.filter((node) => node.id !== group.id && node.x >= group.x && node.y >= group.y && node.x + node.width <= group.x + group.width && node.y + node.height <= group.y + group.height).map((node) => node.id);
}

export type Guides = { dx: number; dy: number; vertical: number | null; horizontal: number | null };

/**
 * Alignment guides for a moving rectangle: the nearest left/centre/right and
 * top/middle/bottom match within `threshold`, with the offset that snaps to it.
 */
export function alignmentGuides(moving: Rect, others: Rect[], threshold: number): Guides {
  const stops = (start: number, size: number) => [start, start + size / 2, start + size];
  const result: Guides = { dx: 0, dy: 0, vertical: null, horizontal: null };
  let bestX = threshold + 1, bestY = threshold + 1;
  for (const other of others) {
    for (const mine of stops(moving.x, moving.width)) for (const theirs of stops(other.x, other.width)) {
      const delta = theirs - mine;
      if (Math.abs(delta) < bestX) { bestX = Math.abs(delta); result.dx = delta; result.vertical = theirs; }
    }
    for (const mine of stops(moving.y, moving.height)) for (const theirs of stops(other.y, other.height)) {
      const delta = theirs - mine;
      if (Math.abs(delta) < bestY) { bestY = Math.abs(delta); result.dy = delta; result.horizontal = theirs; }
    }
  }
  return result;
}

export type Geometry = { x: number; y: number; width: number; height: number };

/** Write geometry for several cards in one mutation; unknown ids are an error. */
export function applyGeometry(canvas: CanvasDocument, changes: Map<string, Partial<Geometry>>) {
  for (const [id, change] of changes) {
    const node = canvas.nodes.find((item) => item.id === id);
    if (!node) throw new Error('A moved card was removed.');
    if (change.x !== undefined) node.x = coordinate(change.x);
    if (change.y !== undefined) node.y = coordinate(change.y);
    if (change.width !== undefined) node.width = clamp(Math.round(change.width), 1, MAX_SIZE);
    if (change.height !== undefined) node.height = clamp(Math.round(change.height), 1, MAX_SIZE);
  }
}

export type CanvasFragment = { nodes: CanvasNode[]; edges: CanvasEdge[] };

/** The selected cards and the connections that run between them, deep-copied. */
export function copyFragment(canvas: CanvasDocument, ids: Iterable<string>): CanvasFragment {
  const wanted = new Set(ids);
  return {
    nodes: structuredClone(canvas.nodes.filter((node) => wanted.has(node.id))),
    edges: structuredClone(canvas.edges.filter((edge) => wanted.has(edge.fromNode) && wanted.has(edge.toNode))),
  };
}

/**
 * Add a copied fragment under fresh ids, shifted by `offset`. Every field of
 * the copied cards and connections, known or not, comes along. Returns the
 * new card ids.
 */
export function pasteFragment(canvas: CanvasDocument, fragment: CanvasFragment, offset: { x: number; y: number }, newId: () => string): string[] {
  const ids = new Map<string, string>();
  for (const node of fragment.nodes) {
    const id = newId();
    ids.set(node.id, id);
    canvas.nodes.push({ ...structuredClone(node), id, x: coordinate(node.x + offset.x), y: coordinate(node.y + offset.y) });
  }
  for (const edge of fragment.edges) canvas.edges.push({ ...structuredClone(edge), id: newId(), fromNode: ids.get(edge.fromNode)!, toNode: ids.get(edge.toNode)! });
  return [...ids.values()];
}

/** Remove cards (with their connections) and connections in one mutation. */
export function removeElements(canvas: CanvasDocument, nodeIds: Iterable<string>, edgeIds: Iterable<string>) {
  const nodes = new Set(nodeIds), edges = new Set(edgeIds);
  canvas.nodes = canvas.nodes.filter((node) => !nodes.has(node.id));
  canvas.edges = canvas.edges.filter((edge) => !edges.has(edge.id) && !nodes.has(edge.fromNode) && !nodes.has(edge.toNode));
}

/** JSON Canvas colour presets 1-6, or the file's own #RRGGBB. */
const PRESETS: Record<string, string> = { '1': '#e5484d', '2': '#f2994a', '3': '#e0b93b', '4': '#3fb26f', '5': '#3fb6c9', '6': '#9a6bdc' };
export function canvasColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return PRESETS[value] ?? (/^#[\da-f]{6}$/iu.test(value) ? value : null);
}
