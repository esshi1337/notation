export type LayoutNode = { id: string; title?: string; name?: string; path?: string };
export type LayoutEdge = { source: string; target: string };

export type LayoutPoint = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  node: LayoutNode;
};

export type LayoutLink = {
  source: string;
  target: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type GraphLayout = {
  points: LayoutPoint[];
  byId: Map<string, LayoutPoint>;
  links: LayoutLink[];
  width: number;
  height: number;
  signature: string;
};

export type LayoutOptions = { aspect?: number };

const CARD_HEIGHT = 28;
const CARD_PADDING_X = 9;
const CARD_MIN_WIDTH = 56;
const CARD_MAX_WIDTH = 196;
const CARD_GAP_X = 10;
const CARD_GAP_Y = 8;
const LABEL_MAX_WIDTH = CARD_MAX_WIDTH - CARD_PADDING_X * 2;
const COMPONENT_GAP = 36;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function glyphWidth(character: string) {
  const code = character.codePointAt(0) ?? 0;
  if (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60))) return 12;
  if (character === ' ') return 3.6;
  if (/[il.,'!|:;]/u.test(character)) return 3.5;
  if (/[mwMW@#%&]/u.test(character)) return 9;
  if (/[A-Z0-9]/u.test(character)) return 7.2;
  return 6.4;
}

function measureLabel(value: string) {
  let width = 0;
  for (const character of value) width += glyphWidth(character);
  return width;
}

/** Deterministic, card-sized label that never overflows its own card. */
export function displayLabel(node: LayoutNode, maxWidth = LABEL_MAX_WIDTH) {
  const raw = (node.title || node.name || node.path || node.id).replace(/\s+/gu, ' ').trim() || node.id;
  if (measureLabel(raw) <= maxWidth) return raw;
  let output = '';
  for (const character of raw) {
    if (measureLabel(output + character + '…') > maxWidth) break;
    output += character;
  }
  return (output.trimEnd() || Array.from(raw)[0] || '') + '…';
}

function cardWidth(label: string) {
  return clamp(Math.ceil(measureLabel(label) + CARD_PADDING_X * 2), CARD_MIN_WIDTH, CARD_MAX_WIDTH);
}

type Position = { x: number; y: number };
type Component = {
  ids: string[];
  positions: Map<string, Position>;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
};

function buildAdjacency(ids: string[], edges: LayoutEdge[]) {
  const adjacency = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    const source = adjacency.get(edge.source);
    const target = adjacency.get(edge.target);
    if (!source || !target) continue;
    source.add(edge.target);
    target.add(edge.source);
  }
  return adjacency;
}

function buildComponents(ids: string[], adjacency: Map<string, Set<string>>) {
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const group: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const current = stack.pop()!;
      group.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    group.sort();
    components.push(group);
  }
  return components;
}

/** Breadth-first order keeps connected cards close together in the packed rows. */
function orderComponent(ids: string[], adjacency: Map<string, Set<string>>) {
  const remaining = new Set(ids);
  const order: string[] = [];
  const openDegree = (id: string) => {
    let degree = 0;
    for (const neighbor of adjacency.get(id) ?? []) if (remaining.has(neighbor)) degree += 1;
    return degree;
  };
  while (remaining.size) {
    let root = '';
    let rootDegree = -1;
    for (const id of [...remaining].sort()) {
      const degree = openDegree(id);
      if (degree > rootDegree) { root = id; rootDegree = degree; }
    }
    remaining.delete(root);
    const queue = [root];
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index];
      order.push(id);
      const neighbors = [...(adjacency.get(id) ?? [])].filter((neighbor) => remaining.has(neighbor));
      neighbors.sort((a, b) => openDegree(b) - openDegree(a) || a.localeCompare(b));
      for (const neighbor of neighbors) {
        remaining.delete(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return order;
}

function layoutComponent(ids: string[], adjacency: Map<string, Set<string>>, cards: Map<string, { width: number; height: number }>, aspect: number): Component {
  const order = orderComponent(ids, adjacency);
  const totalArea = order.reduce((sum, id) => {
    const card = cards.get(id)!;
    return sum + (card.width + CARD_GAP_X) * (card.height + CARD_GAP_Y);
  }, 0);
  const targetWidth = Math.max(120, Math.sqrt(totalArea * aspect) * 1.08);
  const positions = new Map<string, Position>();
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let width = 0;
  for (const id of order) {
    const card = cards.get(id)!;
    if (cursorX > 0 && cursorX + card.width > targetWidth) {
      cursorX = 0;
      cursorY += rowHeight + CARD_GAP_Y;
      rowHeight = 0;
    }
    positions.set(id, { x: cursorX, y: cursorY });
    width = Math.max(width, cursorX + card.width);
    cursorX += card.width + CARD_GAP_X;
    rowHeight = Math.max(rowHeight, card.height);
  }
  return { ids, positions, width, height: cursorY + rowHeight, offsetX: 0, offsetY: 0 };
}

function packComponents(components: Component[]) {
  components.sort((a, b) => b.width * b.height - a.width * a.height || a.ids[0].localeCompare(b.ids[0]));
  const totalArea = components.reduce((sum, component) => sum + (component.width + COMPONENT_GAP) * (component.height + COMPONENT_GAP), 0);
  const shelfWidth = Math.max(280, Math.sqrt(totalArea) * 1.12);
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const component of components) {
    if (cursorX > 0 && cursorX + component.width > shelfWidth) {
      cursorX = 0;
      cursorY += rowHeight + COMPONENT_GAP;
      rowHeight = 0;
    }
    component.offsetX = cursorX;
    component.offsetY = cursorY;
    cursorX += component.width + COMPONENT_GAP;
    rowHeight = Math.max(rowHeight, component.height);
  }
}

function resolveCollisions(points: LayoutPoint[]) {
  const passes = points.length > 120 ? 60 : 90;
  for (let pass = 0; pass < passes; pass += 1) {
    let moved = false;
    for (let left = 0; left < points.length; left += 1) {
      const a = points[left];
      for (let right = left + 1; right < points.length; right += 1) {
        const b = points[right];
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        if (overlapX <= 0.01 || overlapY <= 0.01) continue;
        moved = true;
        if (overlapX < overlapY) {
          const push = Math.min(14, overlapX / 2 + 0.5);
          const direction = a.x + a.width / 2 <= b.x + b.width / 2 ? -1 : 1;
          a.x += push * direction;
          b.x -= push * direction;
        } else {
          const push = Math.min(14, overlapY / 2 + 0.5);
          const direction = a.y + a.height / 2 <= b.y + b.height / 2 ? -1 : 1;
          a.y += push * direction;
          b.y -= push * direction;
        }
      }
    }
    if (!moved) break;
  }
}

function boundaryPoint(point: LayoutPoint, dx: number, dy: number) {
  const halfWidth = point.width / 2;
  const halfHeight = point.height / 2;
  const xScale = Math.abs(dx) < 1e-6 ? Infinity : halfWidth / Math.abs(dx);
  const yScale = Math.abs(dy) < 1e-6 ? Infinity : halfHeight / Math.abs(dy);
  const scale = Math.min(xScale, yScale);
  if (!Number.isFinite(scale)) return { x: point.x + halfWidth, y: point.y + halfHeight };
  return { x: point.x + halfWidth + dx * scale, y: point.y + halfHeight + dy * scale };
}

/**
 * Build a deterministic, bounded card layout. The same inputs always produce
 * the same points, independent of input array order, and every card (including
 * its label) is separated from every other card. No animation loop is needed.
 */
export function layoutGraph(nodes: LayoutNode[], edges: LayoutEdge[], options: LayoutOptions = {}): GraphLayout {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const aspect = clamp(options.aspect && Number.isFinite(options.aspect) ? options.aspect : 1.25, 0.6, 2.8);
  const idSet = new Set(ordered.map((node) => node.id));
  const safeEdges = edges.filter((edge) => idSet.has(edge.source) && idSet.has(edge.target) && edge.source !== edge.target);
  const adjacency = buildAdjacency(ordered.map((node) => node.id), safeEdges);
  const labels = new Map(ordered.map((node) => [node.id, displayLabel(node)]));
  const cards = new Map(ordered.map((node) => {
    const label = labels.get(node.id)!;
    return [node.id, { width: cardWidth(label), height: CARD_HEIGHT }];
  }));
  const components = buildComponents(ordered.map((node) => node.id), adjacency).map((ids) => layoutComponent(ids, adjacency, cards, aspect));
  packComponents(components);

  const componentFor = new Map<string, Component>();
  for (const component of components) for (const id of component.ids) componentFor.set(id, component);

  const points: LayoutPoint[] = ordered.map((node) => {
    const component = componentFor.get(node.id)!;
    const position = component.positions.get(node.id)!;
    const card = cards.get(node.id)!;
    return {
      id: node.id,
      x: component.offsetX + position.x,
      y: component.offsetY + position.y,
      width: card.width,
      height: card.height,
      label: labels.get(node.id)!,
      node,
    };
  });
  resolveCollisions(points);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x + point.width);
    maxY = Math.max(maxY, point.y + point.height);
  }
  if (!points.length) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  for (const point of points) {
    point.x -= minX;
    point.y -= minY;
  }
  const width = Math.max(0, maxX - minX);
  const height = Math.max(0, maxY - minY);

  const byId = new Map(points.map((point) => [point.id, point]));
  const links: LayoutLink[] = [];
  for (const edge of safeEdges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const start = boundaryPoint(source, target.x + target.width / 2 - (source.x + source.width / 2), target.y + target.height / 2 - (source.y + source.height / 2));
    const end = boundaryPoint(target, source.x + source.width / 2 - (target.x + target.width / 2), source.y + source.height / 2 - (target.y + target.height / 2));
    links.push({ source: edge.source, target: edge.target, x1: start.x, y1: start.y, x2: end.x, y2: end.y });
  }

  const signature = JSON.stringify({
    nodes: ordered.map((node) => `${node.id}\u0000${labels.get(node.id)}\u0000${cards.get(node.id)!.width}`),
    edges: safeEdges.map((edge) => `${edge.source}\u0000${edge.target}`).sort(),
    width: width.toFixed(2),
    height: height.toFixed(2),
    margin: `${CARD_GAP_X}:${CARD_GAP_Y}`,
  });

  return { points, byId, links, width, height, signature };
}
