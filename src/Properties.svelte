<script lang="ts">
  import { untrack } from 'svelte';
  import { parseFrontmatter, parsePropertyInput, propertyFields, updateFrontmatter } from './frontmatter';
  import type { PropertyField, PropertyMutation, PropertyType } from './frontmatter';
  type Row = PropertyField & { dirty: boolean };
  type Snapshot = { text: string; documentId: number };
  let { content, documentId, standalone = false, apply, editSource, close }: { content: string; documentId: number; standalone?: boolean; apply: (text: string, source: Snapshot) => boolean; editSource: () => void; close: () => void } = $props();
  const types: { value: PropertyType; label: string }[] = [{ value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'boolean', label: 'Boolean' }, { value: 'date', label: 'Date' }, { value: 'list', label: 'List' }, { value: 'yaml', label: 'YAML' }];
  let rows = $state<Row[]>([]), snapshot = $state(''), stale = $state(false);
  let sourceError = $state(''), error = $state(''), message = $state('');
  let newName = $state(''), newType = $state<PropertyType>('text'), newInput = $state('');
  let loadedId = -1;
  function refresh(text: string, except?: string) {
    const pending = new Map(rows.filter((row) => row.dirty && row.key !== except).map((row) => [row.key, row]));
    snapshot = text; stale = false; sourceError = ''; error = '';
    try { rows = propertyFields(text).map((field) => pending.get(field.key) ?? { ...field, dirty: false }); }
    catch (cause) { rows = []; sourceError = String(cause instanceof Error ? cause.message : cause); }
  }
  $effect(() => {
    const text = content, identity = documentId, isStandalone = standalone;
    untrack(() => {
      if (loadedId !== identity) { loadedId = identity; rows = []; newName = ''; newInput = ''; newType = 'text'; message = ''; refresh(text); }
      else if (text !== snapshot && !isStandalone) {
        if (rows.some((row) => row.dirty) || newName || newInput) { stale = true; error = 'Document changed. Reload properties before applying.'; }
        else refresh(text);
      }
    });
  });
  function changeType(row: Row, event: Event) {
    row.type = (event.currentTarget as HTMLSelectElement).value as PropertyType;
    if (row.type === 'boolean' && !['true', 'false'].includes(row.input)) row.input = 'false';
    row.dirty = true;
  }
  function mutate(mutation: PropertyMutation) {
    error = ''; message = '';
    if (stale || content !== snapshot) { error = 'Document changed. Reload properties before applying.'; return false; }
    try {
      const next = updateFrontmatter(snapshot, mutation);
      if (!apply(next, { text: snapshot, documentId: loadedId })) { stale = true; error = 'Document changed. Reload properties before applying.'; return false; }
      refresh(next, mutation.key); message = 'Properties updated in the editor. Save to update the file.'; return true;
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); return false; }
  }
  function save(row: Row) {
    try { mutate({ kind: 'set', key: row.key, value: parsePropertyInput(row.type, row.input) }); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  }
  function add() {
    try {
      if (mutate({ kind: 'add', key: newName, value: parsePropertyInput(newType, newInput) })) { newName = ''; newInput = ''; newType = 'text'; }
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  }
  function reload() { rows = []; newName = ''; newInput = ''; newType = 'text'; refresh(content); }
</script>

<section class="utility-panel properties-panel" aria-label="Properties">
  <div class="scripts-heading"><strong>Properties</strong><button aria-label="Close properties" onclick={close}>×</button></div>
  {#if standalone}<p class="panel-note">Properties apply to Markdown documents. Mermaid source remains unchanged.</p>
  {:else if sourceError}<div class="script-error" role="alert">{sourceError}</div>{#if stale}<button onclick={reload}>Reload properties</button>{/if}<button onclick={editSource}>Edit properties source</button>
  {:else}
    {#if error}<div class="script-error" role="alert">{error}</div>{/if}
    {#if stale}<button onclick={reload}>Reload properties</button>{/if}
    {#if message}<p class="panel-status" role="status">{message}</p>{/if}
    {#if !rows.length}<p class="panel-note">{parseFrontmatter(content) ? 'No properties yet.' : 'Add a property to create YAML frontmatter. No dates or fields are added automatically.'}</p>{/if}
    <div class="property-list">{#each rows as row (row.key)}
      <div class="property-row">
        <div class="property-heading"><strong>{row.key}</strong><select aria-label={'Property type: ' + row.key} value={row.type} onchange={(event) => changeType(row, event)}>{#each types as type}<option value={type.value}>{type.label}</option>{/each}</select></div>
        {#if row.type === 'boolean'}<label class="property-boolean"><input type="checkbox" aria-label={'Property value: ' + row.key} checked={row.input === 'true'} onchange={(event) => { row.input = event.currentTarget.checked ? 'true' : 'false'; row.dirty = true; }} />{row.input === 'true' ? 'True' : 'False'}</label>
        {:else if row.type === 'list' || row.type === 'yaml'}<textarea aria-label={'Property value: ' + row.key} bind:value={row.input} oninput={() => row.dirty = true} spellcheck="false"></textarea>
        {:else}<input aria-label={'Property value: ' + row.key} type={row.type === 'number' ? 'number' : row.type === 'date' ? 'date' : 'text'} value={row.input} oninput={(event) => { row.input = event.currentTarget.value; row.dirty = true; }} />{/if}
        <div class="property-actions"><button aria-label={'Apply property: ' + row.key} disabled={stale || !row.dirty} onclick={() => save(row)}>Apply</button><button aria-label={'Delete property: ' + row.key} disabled={stale} onclick={() => mutate({ kind: 'delete', key: row.key })}>Delete</button></div>
      </div>
    {/each}</div>
    <div class="property-add">
      <label>Property name<input aria-label="Property name" bind:value={newName} /></label>
      <label>Property type<select aria-label="Property type" bind:value={newType} onchange={(event) => { if (event.currentTarget.value === 'boolean' && !['true', 'false'].includes(newInput)) newInput = 'false'; }}>{#each types as type}<option value={type.value}>{type.label}</option>{/each}</select></label>
      {#if newType === 'boolean'}<label class="property-boolean"><input type="checkbox" aria-label="Property value" checked={newInput === 'true'} onchange={(event) => newInput = event.currentTarget.checked ? 'true' : 'false'} /> Property value</label>
      {:else if newType === 'list' || newType === 'yaml'}<label>Property value<textarea aria-label="Property value" bind:value={newInput} placeholder={newType === 'list' ? '[work, personal]' : 'YAML value'} spellcheck="false"></textarea></label>
      {:else}<label>Property value<input aria-label="Property value" type={newType === 'number' ? 'number' : newType === 'date' ? 'date' : 'text'} value={newInput} oninput={(event) => newInput = event.currentTarget.value} /></label>{/if}
      <button onclick={add} disabled={stale || !newName.trim()}>Add property</button>
    </div>
    <button class="property-edit-source" onclick={editSource}>Edit properties source</button>
  {/if}
</section>
