<script lang="ts">
  import { onDestroy } from 'svelte';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { save as saveDialog } from '@tauri-apps/plugin-dialog';
  import type { UIPreferences } from './preferences';
  import { compileThemeCSS, exportTheme, importTheme, MAX_THEME_FILE_BYTES, normalizeTheme, normalizeThemeLibrary, STARTER_CSS, THEME_BASES } from './themes';
  import type { UserTheme } from './themes';

  let { prefs = $bindable(), base, onpreview, disable, themeImportReset }: { prefs: UIPreferences; base: string; onpreview: (theme: UserTheme | null) => void; disable: () => void; themeImportReset: { generation: number } } = $props();
  let editing = $state(false), draftId = $state(''), name = $state(''), draftBase = $state('dark/midnight'), css = $state(STARTER_CSS);
  let error = $state(''), message = $state('');
  let exporting = $state(false);
  let fileInput: HTMLInputElement;
  let importGeneration = 0;
  let exportGeneration = 0, alive = true;
  const desktop = isTauri();
  let selected = $derived(prefs.userThemes.find(item => item.id === prefs.selectedThemeId));
  const newId = () => 'theme-' + crypto.randomUUID();
  function attempt(action: () => void) {
    error = ''; message = '';
    try { action(); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  }
  function begin(theme?: UserTheme, duplicate = false) {
    importGeneration++;
    onpreview(null); error = ''; message = '';
    draftId = theme && !duplicate ? theme.id : newId();
    name = theme ? theme.name.slice(0, duplicate ? 55 : 60) + (duplicate ? ' copy' : '') : 'My theme';
    draftBase = theme?.base ?? base;
    css = theme?.css ?? STARTER_CSS;
    editing = true;
  }
  function draft() {
    const value = normalizeTheme({ id: draftId, name, base: draftBase, css });
    compileThemeCSS(value.css);
    return value;
  }
  function cancel() { importGeneration++; onpreview(null); editing = false; error = ''; }
  function save() {
    importGeneration++;
    attempt(() => {
      const value = draft();
      const library = normalizeThemeLibrary([...prefs.userThemes.filter(item => item.id !== value.id), value]);
      prefs.userThemes = library; prefs.selectedThemeId = value.id;
      onpreview(null); editing = false; message = 'Theme saved and applied.';
    });
  }
  function select(id: string) {
    importGeneration++;
    attempt(() => {
      const theme = prefs.userThemes.find(item => item.id === id);
      if (theme) compileThemeCSS(theme.css);
      onpreview(null); prefs.selectedThemeId = theme?.id ?? ''; editing = false;
    });
  }
  function remove() {
    if (!selected) return;
    prefs.userThemes = prefs.userThemes.filter(item => item.id !== selected!.id);
    prefs.selectedThemeId = ''; cancel(); message = 'Theme deleted. Built-in theme restored.';
  }
  async function download() {
    if (!selected || exporting) return;
    const theme = selected;
    const generation = ++exportGeneration;
    exporting = true; error = ''; message = '';
    try {
      const text = exportTheme(theme);
      if (desktop) {
        const path = await saveDialog({ defaultPath: 'notation-theme.json', filters: [{ name: 'Notation theme', extensions: ['json'] }] });
        if (!path || !alive || generation !== exportGeneration) return;
        await invoke('write_document', { path, content: text });
        if (!alive || generation !== exportGeneration) return;
        message = 'Theme exported as JSON.';
      } else {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        // The timer holds only the URL, so it still revokes after an unmount.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        const anchor = document.createElement('a');
        anchor.href = url; anchor.download = 'notation-theme.json'; anchor.click();
        if (alive && generation === exportGeneration) message = 'Theme exported as JSON.';
      }
    } catch (cause) {
      if (alive && generation === exportGeneration) error = 'Could not export theme: ' + (cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (alive && generation === exportGeneration) exporting = false;
    }
  }
  async function loadFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0]; input.value = '';
    if (!file) return;
    const generation = ++importGeneration;
    const resetGeneration = themeImportReset.generation;
    const isCurrent = () => generation === importGeneration && resetGeneration === themeImportReset.generation;
    error = ''; message = '';
    try {
      if (file.size > MAX_THEME_FILE_BYTES) throw new Error('Theme file exceeds 12 KiB. Choose a smaller standalone theme JSON file.');
      const text = await file.text();
      if (!isCurrent()) return;
      const value = importTheme(text, newId());
      compileThemeCSS(value.css);
      const library = normalizeThemeLibrary([...prefs.userThemes, value]);
      prefs.userThemes = library; prefs.selectedThemeId = value.id;
      onpreview(null); editing = false; message = 'Theme imported and applied with a new local ID.';
    } catch (cause) { if (isCurrent()) error = cause instanceof Error ? cause.message : String(cause); }
  }
  onDestroy(() => { alive = false; exportGeneration++; importGeneration++; onpreview(null); });
</script>

<section class="theme-editor" aria-label="User themes">
  <label>User theme
    <select aria-label="User theme" value={prefs.selectedThemeId} onchange={(event) => select(event.currentTarget.value)}>
      <option value="">Off — built-in theme</option>
      {#each prefs.userThemes as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
    </select>
  </label>
  <div class="theme-actions">
    <button type="button" onclick={() => begin()}>Create theme</button>
    <button type="button" disabled={!selected} onclick={() => begin(selected)}>Edit theme</button>
    <button type="button" disabled={!selected} onclick={() => begin(selected, true)}>Duplicate theme</button>
    <button type="button" disabled={!selected} onclick={remove}>Delete theme</button>
    <button type="button" onclick={() => { cancel(); disable(); }}>Disable custom theme</button>
    <button type="button" onclick={() => fileInput.click()}>Import theme</button>
    <button type="button" disabled={!selected || exporting} onclick={download}>Export theme</button>
    <input bind:this={fileInput} type="file" accept=".json,application/json" aria-label="Import theme JSON" onchange={loadFile} hidden />
  </div>
  <p class="settings-help">Local only. Up to 8 themes; CSS 4096 bytes each; library 24 KiB. A user theme uses its own built-in base; the controls above apply when User theme is Off. Recovery: Ctrl/Cmd+Shift+F12 always disables custom styling, even if CSS hides the UI. Saved themes are kept.</p>
  {#if editing}
    <label>Theme name<input aria-label="Theme name" bind:value={name} maxlength="60" /></label>
    <label>Built-in base<select aria-label="Built-in base" bind:value={draftBase}>{#each THEME_BASES as value}<option {value}>{value}</option>{/each}</select></label>
    <label>Theme CSS<textarea aria-label="Theme CSS" bind:value={css} rows="9" spellcheck="false"></textarea></label>
    <p class="settings-help">Use flat ASCII selector &#123; property: value; &#125; rules. No comments, escapes, @ rules, nesting, quoted values, URLs, fonts or images. Functions: rgb/rgba, hsl/hsla, calc/min/max/clamp, var. var() supports built-in color and layout tokens only (not icon/resource tokens). Put theme variables in a standalone :root rule: overrides also reach app inline preferences. Example: <code>:root &#123; --bg: #202838; --bar: #283448; --accent: #a6d8ff; &#125;</code></p>
    <div class="theme-actions">
      <button type="button" onclick={() => attempt(() => { onpreview(draft()); message = 'Temporary preview. Cancel or close Settings to restore the saved theme.'; })}>Preview theme</button>
      <button type="button" onclick={save}>Save and apply theme</button>
      <button type="button" onclick={cancel}>Cancel theme edit</button>
    </div>
  {/if}
  {#if error}<p role="alert" class="script-error">{error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
</section>

<style>
  .theme-editor { display: grid; gap: 12px; margin: 20px 0; padding-top: 16px; border-top: 1px solid var(--border); }
  label { display: grid; gap: 6px; color: var(--text); }
  input, select, textarea { width: 100%; min-width: 0; padding: 8px; border: 1px solid var(--border); border-radius: 6px; color: var(--text); background: var(--bar); font: inherit; }
  textarea { resize: vertical; font-family: monospace; }
  .theme-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  button { padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bar); }
  button:disabled { opacity: .5; }
</style>
