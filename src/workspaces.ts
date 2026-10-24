import type { DocumentSelection, DocumentTab } from './documents';

export type WorkspaceRecord = { id: string; name: string; files: string[]; legacyRoot: string | null };
export type WorkspaceCatalog = { activeId: string | null; workspaces: WorkspaceRecord[] };
export type WorkspaceLayout = 'source' | 'split' | 'preview' | 'live';
export type WorkspaceView = {
  tabIds: string[]; activeTabId: string; layout: WorkspaceLayout;
  selections: Record<string, DocumentSelection>;
};
export const emptyCatalog = (): WorkspaceCatalog => ({ activeId: null, workspaces: [] });
export const workspaceKey = (id: string | null) => id ?? '__personal__';

/** Restore references only. Document content lives once in the shared session. */
export function restoreWorkspaceView(value: WorkspaceView | undefined, tabs: DocumentTab[], fallback: WorkspaceLayout): WorkspaceView | null {
  if (!value || !Array.isArray(value.tabIds)) return null;
  const tabIds = [...new Set(value.tabIds)].filter(id => tabs.some(tab => tab.id === id));
  if (!tabIds.length) return null;
  const selections: Record<string, DocumentSelection> = {};
  for (const id of tabIds) {
    const candidate = value.selections?.[id];
    if (candidate && Number.isFinite(candidate.anchor) && Number.isFinite(candidate.head)) selections[id] = candidate;
  }
  return { tabIds, activeTabId: tabIds.includes(value.activeTabId) ? value.activeTabId : tabIds[0],
    layout: ['source','split','preview','live'].includes(value.layout) ? value.layout : fallback, selections };
}

export function captureWorkspaceView(tabs: DocumentTab[], tabIds: string[], activeTabId: string, layout: WorkspaceLayout): WorkspaceView {
  return { tabIds: [...tabIds], activeTabId, layout,
    selections: Object.fromEntries(tabs.filter(tab => tabIds.includes(tab.id)).map(tab => [tab.id, { ...tab.selection }])) };
}

export function restoreWorkspaceViews(values: Record<string, WorkspaceView> | undefined, tabs: DocumentTab[]): Record<string, WorkspaceView> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
  return Object.fromEntries(Object.entries(values).flatMap(([id, value]) => {
    const restored = restoreWorkspaceView(value, tabs, 'split');
    return restored ? [[id, restored]] : [];
  }));
}
