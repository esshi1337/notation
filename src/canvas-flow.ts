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

export const oppositeSide = (side: Side): Side => side === 'left' ? 'right' : side === 'right' ? 'left' : side === 'top' ? 'bottom' : 'top';

/**
 * The sides a connection should record. A side is written only where the
 * user chose one that differs from the automatic choice, so an ordinary
 * connection stays free to follow its cards and a deliberate one stays put.
 */
export function pinnedSides(from: Rect, to: Rect, chosen: { fromSide?: Side | null; toSide?: Side | null }): { fromSide?: Side; toSide?: Side } {
  const auto = autoSides(from, to), sides: { fromSide?: Side; toSide?: Side } = {};
  if (chosen.fromSide && chosen.fromSide !== auto.fromSide) sides.fromSide = chosen.fromSide;
  if (chosen.toSide && chosen.toSide !== auto.toSide) sides.toSide = chosen.toSide;
  return sides;
}

/**
 * True for a board whose connections all leave right and enter left although
 * the cards are not all laid out that way: what the first Notation canvas wrote
 * for every connection. Such a board draws arrows that loop around cards.
 */
export function looksRightToLeftOnly(canvas: CanvasDocument): boolean {
  if (!canvas.edges.length || !canvas.edges.every((edge) => edge.fromSide === 'right' && edge.toSide === 'left')) return false;
  const rects = new Map(canvas.nodes.map((node) => [node.id, node]));
  return canvas.edges.some((edge) => { const from = rects.get(edge.fromNode), to = rects.get(edge.toNode); return !!from && !!to && autoSides(from, to).fromSide !== 'right'; });
}

/** Clear the recorded sides of every connection; returns how many changed. */
export function unpinAllSides(canvas: CanvasDocument): number {
  let changed = 0;
  for (const edge of canvas.edges) if (edge.fromSide !== undefined || edge.toSide !== undefined) { delete edge.fromSide; delete edge.toSide; changed++; }
  return changed;
}

/** Cards a selection rectangle touches (document coordinates). */
export function rectsTouching<T extends Rect>(items: T[], area: Rect): T[] {
  return items.filter((item) => item.x < area.x + area.width && item.x + item.width > area.x && item.y < area.y + area.height && item.y + item.height > area.y);
}

export type Direction = 'up' | 'down' | 'left' | 'right';
/**
 * The card to move keyboard focus to from `from`: the nearest one whose centre
 * lies in that direction, preferring cards in line with the current one.
 */
export function neighbourInDirection<T extends Rect & { id: string }>(items: T[], from: T, direction: Direction): T | null {
  const centre = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }), origin = centre(from);
  let best: T | null = null, bestScore = Infinity;
  for (const item of items) {
    if (item.id === from.id) continue;
    const at = centre(item), dx = at.x - origin.x, dy = at.y - origin.y;
    const along = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy, across = Math.abs(direction === 'left' || direction === 'right' ? dy : dx);
    if (along <= 0 || across > along * 2) continue;
    const score = along + across * 2;
    if (score < bestScore) { bestScore = score; best = item; }
  }
  return best;
}

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
