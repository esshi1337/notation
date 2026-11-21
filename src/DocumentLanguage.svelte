<script lang="ts">
  import { scrimExit } from './motion';
  import { onMount, onDestroy } from 'svelte';
  import { detectLanguage, languageOptions, type CodeLanguage } from './code-languages';
  import SelectControl from './SelectControl.svelte';
  import Icon from './Icon.svelte';
  let { name, language, theme, change, close }: { name: string; language?: CodeLanguage; theme: 'light' | 'dark'; change: (value: CodeLanguage | undefined) => void; close: () => void } = $props();
  let dialog: HTMLDialogElement;
  let previous: HTMLElement | null = null;
  const automatic = $derived(languageOptions.find(option => option.value === detectLanguage(name))?.label ?? 'Markdown');
  onMount(() => { previous = document.activeElement as HTMLElement; dialog.showModal(); });
  onDestroy(() => { if (dialog?.open) dialog.close(); previous?.focus(); });
</script>
<dialog class="rename-dialog document-language-dialog" use:scrimExit aria-label="Document language" bind:this={dialog} oncancel={(event) => { event.preventDefault(); close(); }}>
  <div class="language-dialog-body">
    <div class="language-dialog-heading"><strong>Document language</strong><button class="settings-close" aria-label="Close document language" onclick={close}><Icon name="close" size={14} {theme} /></button></div>
    <p>New notes use Markdown. Other files choose their editor from the filename. Override this document only when needed.</p>
    <SelectControl label="Language" options={[{ value: 'auto', label: 'Automatic · ' + automatic }, ...languageOptions]} value={language ?? 'auto'} onchange={(value) => change(value === 'auto' ? undefined : value as CodeLanguage)} {theme} />
    <div class="dialog-actions"><button onclick={close}>Done</button></div>
  </div>
</dialog>
