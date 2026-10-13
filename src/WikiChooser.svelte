<script lang="ts">
  import { onMount } from 'svelte';
  import type { WikiResolution } from './wiki-navigation';
  let { resolution, busy, error = '', choose, create, close }: { resolution: WikiResolution; busy: boolean; error?: string; choose: (path: string) => void; create: () => void; close: () => void } = $props();
  let dialog: HTMLDialogElement;
  onMount(() => { dialog.showModal(); });
</script>
<dialog class="wiki-dialog" bind:this={dialog} aria-label={resolution.status === 'ambiguous' ? 'Choose note' : 'Create note'} oncancel={(event) => { event.preventDefault(); if (!busy) close(); }}>
  <div class="scripts-heading"><strong>{resolution.status === 'ambiguous' ? 'Choose note' : 'Note not found'}</strong><button aria-label="Close note navigation" disabled={busy} onclick={close}>×</button></div>
  {#if error}<div class="script-error" role="alert">{error}</div>{/if}
  {#if resolution.status === 'ambiguous'}<p class="panel-note">Choose a note for [[{resolution.target}]].</p><div class="wiki-candidates">{#each resolution.candidates as candidate}<button disabled={busy} aria-label={'Open ' + candidate.relativePath} onclick={() => choose(candidate.path)}><strong>{candidate.title || candidate.name}</strong><span>{candidate.relativePath}</span></button>{/each}</div>
  {:else}<p class="panel-note">Create an empty Markdown note at the following path? Existing files are never overwritten.</p><code class="wiki-create-path">{resolution.createPath || 'No valid creation path is available.'}</code><button disabled={busy || !resolution.createPath} onclick={create}>Create note</button>{/if}
  <button disabled={busy} onclick={close}>Cancel</button>
</dialog>
