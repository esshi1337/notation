// Visible disambiguation for tabs that share a file name. Saved files show the
// shortest run of parent folders that tells them apart; unsaved documents are
// numbered in tab order. Tabs with a unique name get no suffix.
export type TabIdentity = { id: string; name: string; path?: string | null };

const folders = (path: string) => path.split(/[\\/]/u).slice(0, -1).filter(Boolean);

export function tabContexts(documents: readonly TabIdentity[]): Map<string, string> {
  const groups = new Map<string, TabIdentity[]>();
  for (const document of documents) {
    const group = groups.get(document.name);
    if (group) group.push(document); else groups.set(document.name, [document]);
  }
  const contexts = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const saved = group.filter((document) => document.path);
    const unsaved = group.filter((document) => !document.path);
    if (saved.length) {
      const parents = saved.map((document) => folders(document.path!));
      const longest = Math.max(1, ...parents.map((parts) => parts.length));
      let labels: string[] = [];
      for (let depth = 1; depth <= longest; depth++) {
        labels = parents.map((parts) => parts.slice(-depth).join('/'));
        if (new Set(labels).size === labels.length) break;
      }
      saved.forEach((document, index) => { if (labels[index]) contexts.set(document.id, labels[index]); });
    }
    unsaved.forEach((document, index) => {
      if (index > 0) contexts.set(document.id, String(index + 1));
      else if (saved.length) contexts.set(document.id, 'unsaved');
    });
  }
  return contexts;
}
