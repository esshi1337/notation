export type CanvasNode = { id: string; type: 'text' | 'file' | 'link' | 'group'; x: number; y: number; width: number; height: number; text?: string; file?: string; subpath?: string; url?: string; label?: string; color?: string; [key: string]: unknown };
export type CanvasEdge = { id: string; fromNode: string; toNode: string; fromSide?: 'top' | 'right' | 'bottom' | 'left'; toSide?: 'top' | 'right' | 'bottom' | 'left'; fromEnd?: 'none' | 'arrow'; toEnd?: 'none' | 'arrow'; color?: string; label?: string; [key: string]: unknown };
export type CanvasDocument = { nodes: CanvasNode[]; edges: CanvasEdge[]; [key: string]: unknown };
const MAX_BYTES = 4 * 1024 * 1024;
export const MAX_CARDS = 2000, MAX_CONNECTIONS = 8000;
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function string(value: unknown, field: string, optional = false) { if (value === undefined && optional) return; if (typeof value !== 'string') throw new Error('Canvas ' + field + ' must be text.'); }
function color(value: unknown) { if (value !== undefined && (typeof value !== 'string' || !/^(?:#[\da-f]{6}|[1-6])$/iu.test(value))) throw new Error('Canvas colors must use #RRGGBB or a preset from 1 to 6.'); }
export function validateCanvas(value: unknown): CanvasDocument {
  if (!object(value)) throw new Error('Canvas JSON must be an object with nodes and edges arrays.');
  const nodes = value.nodes ?? [], edges = value.edges ?? [];
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('Canvas nodes and edges must be arrays.');
  if (nodes.length > MAX_CARDS || edges.length > MAX_CONNECTIONS) throw new Error('Canvas supports at most 2,000 cards and 8,000 connections. The original JSON remains unchanged.');
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!object(node)) throw new Error('Every canvas node must be an object.');
    string(node.id, 'card ID'); if (!(node.id as string).trim() || ids.has(node.id as string)) throw new Error('Canvas card IDs must be nonempty and unique.'); ids.add(node.id as string);
    if (!['text','file','link','group'].includes(String(node.type))) throw new Error('Unsupported canvas card type: ' + String(node.type) + '. Edit the JSON in Source to retain custom node types.');
    for (const field of ['x','y','width','height']) if (!Number.isInteger(node[field]) || Math.abs(node[field] as number) > 1_000_000 || (field === 'width' || field === 'height') && (node[field] as number) <= 0) throw new Error('Canvas positions and sizes must be bounded integers; card sizes must be positive.');
    if (node.type === 'text') string(node.text, 'card text');
    if (node.type === 'file') { string(node.file, 'card file'); string(node.subpath, 'card subpath', true); if (node.subpath !== undefined && !(node.subpath as string).startsWith('#')) throw new Error('Canvas file subpaths must begin with #.'); }
    if (node.type === 'link') string(node.url, 'card URL');
    string(node.label, 'card label', true); color(node.color);
  }
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (!object(edge)) throw new Error('Every canvas connection must be an object.');
    string(edge.id, 'connection ID'); if (!(edge.id as string).trim() || edgeIds.has(edge.id as string)) throw new Error('Canvas connection IDs must be nonempty and unique.'); edgeIds.add(edge.id as string);
    if (!ids.has(edge.fromNode as string) || !ids.has(edge.toNode as string)) throw new Error('A canvas connection references a missing card. Repair it in Source.');
    for (const field of ['fromSide','toSide']) if (edge[field] !== undefined && !['top','right','bottom','left'].includes(String(edge[field]))) throw new Error('Canvas connection sides must be top, right, bottom, or left.');
    for (const field of ['fromEnd','toEnd']) if (edge[field] !== undefined && !['none','arrow'].includes(String(edge[field]))) throw new Error('Canvas connection ends must be none or arrow.');
    string(edge.label, 'connection label', true); color(edge.color);
  }
  return { ...value, nodes: nodes as CanvasNode[], edges: edges as CanvasEdge[] };
}
export function parseCanvas(text: string) {
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('Canvas exceeds the 4 MiB document limit.');
  let value: unknown; try { value = JSON.parse(text); } catch (cause) { throw new Error('Invalid Canvas JSON: ' + String(cause)); }
  return validateCanvas(value);
}
/** How a file was written: its line ending, its indentation and whether it ends with a newline. A change keeps all three. */
export type CanvasFormat = { eol: string; indent: string | number; trailing: boolean };
export function canvasFormat(text: string): CanvasFormat {
  const eol = text.includes('\r\n') ? '\r\n' : '\n', indent = /^\s*[{[]\r?\n([ \t]+)\S/u.exec(text)?.[1];
  // A file on one line stays on one line.
  return { eol, indent: indent ?? (/[{[,]\r?\n/u.test(text) ? 2 : 0), trailing: /\n\s*$/u.test(text) };
}
export function serializeCanvas(value: CanvasDocument, format: CanvasFormat = { eol: '\n', indent: 2, trailing: true }) {
  validateCanvas(value);
  const text = JSON.stringify(value, null, format.indent).replace(/\n/gu, format.eol) + (format.trailing ? format.eol : '');
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('Canvas exceeds the 4 MiB document limit. No changes were applied.');
  return text;
}
export function newCanvas() { return '{\n  "nodes": [],\n  "edges": []\n}\n'; }
/**
 * Apply a mutation and return the new text and the document it was serialized
 * from. A mutation that leaves the document as it was returns the text
 * untouched (`changed` is false), whatever formatting the file uses.
 */
export function mutateCanvasDocument(text: string, mutation: (canvas: CanvasDocument) => void) {
  const canvas = parseCanvas(text), before = JSON.stringify(canvas);
  mutation(canvas);
  if (JSON.stringify(canvas) === before) return { text, canvas, changed: false };
  return { text: serializeCanvas(canvas, canvasFormat(text)), canvas, changed: true };
}
export function canvasNodeTitle(node: CanvasNode) { return node.label || node.type === 'text' && node.text?.split('\n').find((line) => line.trim())?.replace(/^#+\s*/u, '').slice(0,80) || node.file || node.url || (node.type === 'text' ? 'Empty card' : 'Group'); }
