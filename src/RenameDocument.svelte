<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  let { name, rename, close }: { name: string; rename: (name: string) => void; close: () => void } = $props();
  let value = $state(untrack(() => name)), error = $state('');
  let dialog: HTMLDialogElement, input: HTMLInputElement;
  let previous: HTMLElement | null = null;
  function submit(event: SubmitEvent) { event.preventDefault(); if (!value.trim()) { error = 'Enter a document name.'; return; } dialog.close(); rename(value.trim()); close(); }
  function keyboard(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('input, button'));
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
  }
  onMount(() => { previous = document.activeElement as HTMLElement; dialog.showModal(); input.focus(); input.select(); });
  onDestroy(() => { if (dialog?.open) dialog.close(); previous?.focus(); });
</script>
<dialog class="rename-dialog" aria-label="Rename document" bind:this={dialog} onkeydown={keyboard} oncancel={(event) => { event.preventDefault(); close(); }}>
  <form onsubmit={submit}><strong>Rename document</strong><input bind:this={input} aria-label="Document name" bind:value={value} spellcheck="false" />{#if error}<div role="alert" class="script-error">{error}</div>{/if}<div class="dialog-actions"><button type="button" onclick={close}>Cancel</button><button type="submit">Rename</button></div></form>
</dialog>
