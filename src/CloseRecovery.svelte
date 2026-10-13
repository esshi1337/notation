<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  let { decide }: { decide: (discard: boolean) => void } = $props();
  let dialog: HTMLDialogElement;
  let keepOpen: HTMLButtonElement;
  let discard: HTMLButtonElement;
  function keyboard(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    if (event.shiftKey && document.activeElement === keepOpen) { event.preventDefault(); discard.focus(); }
    else if (!event.shiftKey && document.activeElement === discard) { event.preventDefault(); keepOpen.focus(); }
  }
  onMount(() => { dialog.showModal(); keepOpen.focus(); });
  onDestroy(() => { if (dialog?.open) dialog.close(); });
</script>

<dialog class="settings-dialog close-recovery-dialog" aria-label="Unsaved recovery" bind:this={dialog} onkeydown={keyboard} oncancel={(event) => { event.preventDefault(); decide(false); }}>
  <strong>App state could not be saved</strong>
  <p class="panel-note">Keep this window open to save your files or retry app-state saving. Closing can discard unsaved recovery data.</p>
  <div class="panel-actions"><button bind:this={keepOpen} onclick={() => decide(false)}>Keep open</button><button bind:this={discard} onclick={() => decide(true)}>Discard and close</button></div>
</dialog>
