export type DocumentSelection = { anchor: number; head: number };
export type DocumentData = {
  id: string; name: string; path: string | null; content: string;
  savedContent?: string; savedName?: string; selection?: DocumentSelection; updatedAt?: number; openKey?: string; hemingway?: boolean;
};
export type DocumentSession = { activeTabId: string; tabs: DocumentData[]; updatedAt: number };
export type DocumentTab = DocumentData & {
  savedContent: string; savedName: string; selection: DocumentSelection;
  hemingway: boolean; lifetime: number; folds: Map<string, boolean>; openKey?: string;
};
let lifetime = 0;

export function createTab(document: Partial<DocumentData> = {}): DocumentTab {
  const name = document.name || 'untitled.md', content = document.content ?? '';
  const selection = document.selection ?? { anchor: 0, head: 0 };
  const position = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(content.length, Math.trunc(value))) : 0;
  return {
    id: document.id || crypto.randomUUID(), name, hemingway: document.hemingway === true, path: document.path || null, content,
    savedContent: document.savedContent ?? content, savedName: document.savedName ?? name,
    selection: { anchor: position(selection.anchor), head: position(selection.head) },
    updatedAt: document.updatedAt ?? Date.now(), lifetime: ++lifetime, folds: new Map(), openKey: document.openKey,
  };
}

export function serializeTab(tab: DocumentTab): DocumentData {
  return {
    id: tab.id, name: tab.name, hemingway: tab.hemingway, path: tab.path, content: tab.content,
    savedContent: tab.savedContent, savedName: tab.savedName,
    selection: { ...tab.selection }, updatedAt: tab.updatedAt, openKey: tab.openKey,
  };
}

export function restoreTabs(session: DocumentSession | null | undefined, draft: DocumentData | null, sample: string) {
  if (session && Array.isArray(session.tabs) && session.tabs.length && session.tabs.every((tab) => tab && typeof tab.id === 'string' && typeof tab.name === 'string' && typeof tab.content === 'string')) {
    const tabs = session.tabs.map(createTab);
    if (new Set(tabs.map((tab) => tab.id)).size === tabs.length) return { tabs, activeTabId: tabs.some((tab) => tab.id === session.activeTabId) ? session.activeTabId : tabs[0].id };
  }
  const tab = createTab(draft ?? { name: 'welcome.md', content: sample });
  return { tabs: [tab], activeTabId: tab.id };
}

export function tabDirty(tab: DocumentTab) { return tab.content !== tab.savedContent || tab.name !== tab.savedName; }
