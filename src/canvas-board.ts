// What a card or connection component can ask of the canvas that owns it.
import type { CanvasNode } from './canvas';
import type { Geometry } from './canvas-flow';

export const BOARD = Symbol('canvas-board');
export type RenderCard = (host: HTMLElement, markdown: string, sourcePath?: string, current?: () => boolean) => Promise<void>;
export type CanvasBoard = {
  /** Id of the card being edited in place, or ''. */
  readonly editing: string;
  /** Id of the connection whose label is being edited, or ''. */
  readonly editingEdge: string;
  /** How many cards are selected; resize handles show for a single selection only. */
  readonly selectionSize: number;
  /** Zoomed so far out that cards show a placeholder instead of their content. */
  readonly far: boolean;
  readonly path: string | undefined;
  readonly render: RenderCard | undefined;
  /** True once for a card this session just added, so only it animates in. */
  fresh(id: string): boolean;
  edit(id: string): void;
  /** Write the editor's text to the document and keep editing. */
  saveDraft(id: string, text: string): void;
  /** Write the editor's text to the document and leave the editor. */
  commitEdit(id: string, text: string): void;
  commitEdgeLabel(id: string, label: string): void;
  details(id: string): void;
  openFile(node: CanvasNode): void;
  linkNote(node: CanvasNode): void;
  openLink(url: string): void;
  resizeStart(id: string): void;
  resizeEnd(id: string, geometry: Geometry): void;
};
