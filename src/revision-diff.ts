import { formatPatch, structuredPatch } from 'diff';

export type RevisionDiff = { text: string; added: number; removed: number; unchanged: boolean; error?: string };
export function compareRevisions(before: string, after: string, beforeLabel = 'Revision', afterLabel = 'Current draft', context = 3): RevisionDiff {
  if (before === after) return { text: '', added: 0, removed: 0, unchanged: true };
  const patch = structuredPatch(beforeLabel, afterLabel, before, after, undefined, undefined, { context: Math.max(0, Math.min(20, Math.round(context))), timeout: 100, maxEditLength: 20_000 });
  if (!patch) return { text: '', added: 0, removed: 0, unchanged: false, error: 'This comparison is too large to display. The revision and document are unchanged.' };
  let added = 0, removed = 0;
  for (const hunk of patch.hunks) for (const line of hunk.lines) { if (line.startsWith('+')) added++; else if (line.startsWith('-')) removed++; }
  return { text: formatPatch(patch, { includeIndex: false, includeUnderline: false, includeFileHeaders: true }), added, removed, unchanged: !patch.hunks.length };
}
