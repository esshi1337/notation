<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { nativeStore } from './store';
  type Status = { available: boolean; root: string | null; branch: string | null; detached: boolean; changes: { path: string; index: string; worktree: string; originalPath?: string }[]; branches: { name: string; current: boolean; commit: string }[]; error?: string };
  type Commit = { hash: string; shortHash: string; parents: string[]; author: string; date: string; subject: string; refs: string[] };
  let { close }: { close: () => void } = $props();
  let status = $state<Status | null>(null), commits = $state<Commit[]>([]), error = $state(''), busy = $state(false);
  let selectedPath = $state(''), staged = $state(false), diff = $state(''), diffTruncated = $state(false), selectedCommit = $state<Commit | null>(null);
  let serial = 0;
  let graph = $derived.by(() => {
    const lanes = new Map<string, number>(); let nextLane = 1;
    commits.forEach((commit) => { const lane = lanes.get(commit.hash) ?? 0; lanes.set(commit.hash, lane); commit.parents.forEach((parent, index) => { if (!lanes.has(parent)) lanes.set(parent, index === 0 ? lane : nextLane++ % 5); }); });
    const positions = new Map(commits.map((commit, index) => [commit.hash, { x: 10 + (lanes.get(commit.hash) ?? 0) * 12, y: index * 38 + 18 }]));
    return { nodes: commits.map((commit) => positions.get(commit.hash)!), edges: commits.flatMap((commit) => commit.parents.flatMap((parent) => positions.has(parent) ? [{ from: positions.get(commit.hash)!, to: positions.get(parent)! }] : [])) };
  });
  async function refresh() {
    if (!nativeStore) return;
    busy = true; error = '';
    try {
      status = await invoke<Status>('git_status'); commits = status.available ? await invoke<Commit[]>('git_history', { limit: 35 }) : [];
      if (status.error) error = status.error;
      if (selectedPath && status.changes.some((change) => change.path === selectedPath)) await showDiff(selectedPath, staged);
      else { serial++; selectedPath = ''; diff = ''; }
    }
    catch (cause) { error = 'Could not read Git state: ' + String(cause); }
    finally { busy = false; }
  }
  async function showDiff(path: string, indexDiff: boolean) {
    const ticket = ++serial; selectedPath = path; diff = ''; error = '';
    try { const result = await invoke<{ diff: string; truncated: boolean }>('git_diff', { path, staged: indexDiff }); if (ticket === serial) { diff = result.diff; diffTruncated = result.truncated; } }
    catch (cause) { if (ticket === serial) error = 'Could not read diff: ' + String(cause); }
  }
  onMount(() => { void refresh(); });
</script>
<section class="utility-panel git-panel" aria-label="Git">
  <div class="scripts-heading"><strong>Git</strong><div><button aria-label="Refresh Git" onclick={refresh} disabled={!nativeStore || busy}>↻</button><button aria-label="Close Git" onclick={close}>×</button></div></div>
  <p class="panel-note">{!nativeStore ? 'Git visualization requires the desktop app.' : 'Read-only repository view. Files and Git history are unchanged.'}</p>
  {#if error}<div class="script-error" role="alert">{error}</div>{/if}
  {#if status?.available}
    <div class="git-current-branch">⎇ {status.branch || (status.detached ? 'Detached HEAD' : 'No branch')}</div>
    <details><summary>Branches ({status.branches.length})</summary><div class="git-branches">{#each status.branches as branch}<div class:current={branch.current}>{branch.current ? '●' : '○'} {branch.name}</div>{/each}</div></details>
    <h3 class="panel-subheading">Changes ({status.changes.length})</h3>
    <div class="git-changes">{#each status.changes as change}<button aria-label={'View diff: ' + change.path} onclick={() => showDiff(change.path, staged)}><span>{change.index}{change.worktree}</span>{change.path}</button>{/each}{#if !status.changes.length}<p class="panel-note">Working tree clean.</p>{/if}</div>
    {#if selectedPath}<label class="git-staged"><input type="checkbox" bind:checked={staged} onchange={(event) => { staged = event.currentTarget.checked; void showDiff(selectedPath, staged); }} /> Staged diff</label><div class="result-path">{selectedPath}</div><pre class="git-diff" aria-label="Git diff">{diff || 'No diff for this view. Try Staged diff for index changes.'}</pre>{#if diffTruncated}<p class="panel-note">Diff truncated to the display limit.</p>{/if}{/if}
    <h3 class="panel-subheading">Recent commits</h3>
    <div class="git-history"><svg width="72" height={commits.length * 38} aria-label="Commit parent graph" role="img">{#each graph.edges as edge}<path d={'M' + edge.from.x + ',' + edge.from.y + ' C' + edge.from.x + ',' + (edge.from.y + 18) + ' ' + edge.to.x + ',' + (edge.to.y - 18) + ' ' + edge.to.x + ',' + edge.to.y} fill="none" stroke="currentColor" stroke-width="1" />{/each}{#each graph.nodes as node}<circle cx={node.x} cy={node.y} r="3" fill="var(--bar)" stroke="currentColor" stroke-width="1.5" />{/each}</svg><div>{#each commits as commit}<button aria-label={'Commit: ' + commit.shortHash} onclick={() => selectedCommit = commit} title={commit.hash + ' · ' + commit.author}><span>{commit.shortHash}</span><strong>{commit.subject}</strong></button>{/each}</div></div>
    {#if selectedCommit}<div class="git-commit-detail">{selectedCommit.hash}<br />{selectedCommit.author} · {selectedCommit.date}{#if selectedCommit.refs.length}<br />{selectedCommit.refs.join(', ')}{/if}</div>{/if}
  {:else if nativeStore && !busy}<p class="panel-note">Select a Git workspace to view branches, history, and changes.</p>{/if}
</section>
