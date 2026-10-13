<script lang="ts">
  import ExplorerNode from './ExplorerNode.svelte';
  export type Entry = { name: string; path: string; isDir: boolean; isFile: boolean; editable: boolean };
  let { entry, depth = 1, currentPath = null, load, openFile }: { entry: Entry; depth?: number; currentPath?: string | null; load: (path: string) => Promise<Entry[]>; openFile: (path: string) => void } = $props();
  let expanded = $state(false), busy = $state(false);
  let children = $state<Entry[] | null>(null);
  let element: HTMLButtonElement;
  async function toggle() {
    if (!entry.isDir) { if (entry.editable) openFile(entry.path); return; }
    expanded = !expanded;
    if (expanded && children === null) { busy = true; try { children = await load(entry.path); } finally { busy = false; } }
  }
  function keyboard(event: KeyboardEvent) {
    const tree = element.closest('[role="tree"]')!;
    const items = Array.from(tree.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')).filter((item) => !item.disabled && item.getClientRects().length);
    const index = items.indexOf(element);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus(); }
    else if (event.key === 'ArrowRight' && entry.isDir) { event.preventDefault(); if (!expanded) void toggle(); else items[index + 1]?.focus(); }
    else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (expanded) expanded = false;
      else element.parentElement?.parentElement?.parentElement?.querySelector<HTMLButtonElement>(':scope > button[role="treeitem"]')?.focus();
    }
  }
</script>
<div class="explorer-node">
  <button bind:this={element} role="treeitem" aria-level={depth} aria-selected={entry.path === currentPath} aria-expanded={entry.isDir ? expanded : undefined} aria-label={(entry.isDir ? 'Folder: ' : 'Open file: ') + entry.name} disabled={!entry.isDir && !entry.editable} style={'padding-left:' + (depth * 12) + 'px'} onclick={toggle} onkeydown={keyboard} title={entry.path}><span class="explorer-icon">{entry.isDir ? expanded ? '⌄' : '›' : '·'}</span>{entry.name}{#if busy}<span class="explorer-loading">…</span>{/if}</button>
  {#if entry.isDir && expanded}<div role="group">{#each children ?? [] as child (child.path)}<ExplorerNode entry={child} depth={depth + 1} {currentPath} {load} {openFile} />{/each}{#if children?.length === 0}<span class="explorer-empty" style={'padding-left:' + ((depth + 1) * 12) + 'px'}>Empty folder</span>{/if}</div>{/if}
</div>
