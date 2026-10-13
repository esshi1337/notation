<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { open, save } from '@tauri-apps/plugin-dialog';
  import { exportCSV, markdownTables, replaceTable, serializeTable, sortTableRows, tableFromCSV } from './tables';
  import type { Alignment, MarkdownTable } from './tables';
  type Snapshot = { text: string; documentId: number };
  let { content, documentId, cursor = 0, standalone = false, apply, close }: { content: string; documentId: number; cursor?: number; standalone?: boolean; apply: (text: string, source: Snapshot) => boolean; close: () => void } = $props();
  let tables = $state<MarkdownTable[]>([]), table = $state<MarkdownTable | null>(null);
  let snapshot = $state(''), dirty = $state(false), stale = $state(false), error = $state(''), message = $state(''), busy = $state(false);
  let selectedRow = $state(0), selectedColumn = $state(0);
  let loadedId = -1, loadedCursor = 0, alive = true;
  let fileInput: HTMLInputElement;
  let grid = $state<HTMLDivElement>();
  const desktop = isTauri();
  const clone = (value: MarkdownTable) => ({ ...value, rows: value.rows.map((row) => row.map((cell) => ({ ...cell }))), alignments: [...value.alignments] });
  function load(text: string, position: number) {
    tables = markdownTables(text); snapshot = text; stale = false; dirty = false; error = ''; message = '';
    const selected = tables.find((item) => position >= item.from && position <= item.to);
    table = selected ? clone(selected) : null; selectedRow = 0; selectedColumn = 0;
  }
  $effect(() => {
    const text = content, identity = documentId, position = cursor;
    untrack(() => {
      if (identity !== loadedId) { loadedId = identity; loadedCursor = position; load(text, position); }
      else if (text !== snapshot) {
        if (dirty) { stale = true; error = 'Document changed. Reload the table before applying edits.'; }
        else load(text, position);
      } else if (position !== loadedCursor && !dirty) { loadedCursor = position; load(text, position); }
    });
  });
  onDestroy(() => alive = false);
  function pick(value: MarkdownTable) { table = clone(value); dirty = false; stale = content !== snapshot; error = ''; selectedRow = 0; selectedColumn = 0; }
  function changed() { dirty = true; message = ''; }
  async function focusCell(row: number, column: number) {
    selectedRow = row; selectedColumn = column; await tick();
    grid?.querySelector<HTMLTextAreaElement>('[data-row="' + row + '"][data-column="' + column + '"]')?.focus();
  }
  function keyCell(event: KeyboardEvent, row: number, column: number) {
    if (event.key !== 'Tab' || !table) return;
    const width = table.rows[0].length, index = row * width + column + (event.shiftKey ? -1 : 1);
    // Let Tab leave the grid at its first/last boundary rather than trapping it.
    if (index < 0 || index >= table.rows.length * width) return;
    event.preventDefault(); void focusCell(Math.floor(index / width), index % width);
  }
  function addRow() { if (table) { table.rows.splice(selectedRow + 1, 0, table.rows[0].map(() => ({ value: '' }))); changed(); void focusCell(selectedRow + 1, selectedColumn); } }
  function removeRow() { if (table && selectedRow > 0) { table.rows.splice(selectedRow, 1); changed(); void focusCell(Math.max(0, selectedRow - 1), selectedColumn); } }
  function addColumn() { if (table) { for (const row of table.rows) row.splice(selectedColumn + 1, 0, { value: '' }); table.alignments.splice(selectedColumn + 1, 0, 'default'); changed(); void focusCell(selectedRow, selectedColumn + 1); } }
  function removeColumn() { if (table && table.rows[0].length > 1) { for (const row of table.rows) row.splice(selectedColumn, 1); table.alignments.splice(selectedColumn, 1); changed(); void focusCell(selectedRow, Math.max(0, selectedColumn - 1)); } }
  function sort(direction: 'ascending' | 'descending') { if (table) { table.rows = sortTableRows(table, selectedColumn, direction); changed(); } }
  function fresh() {
    table = { from: cursor, to: cursor, rows: [[{ value: 'Column 1' }, { value: 'Column 2' }], [{ value: '' }, { value: '' }]], alignments: ['default', 'default'], eol: snapshot.includes('\r\n') ? '\r\n' : '\n' }; changed();
  }
  function commit() {
    if (!table || table.error || stale || content !== snapshot) { error = 'Document changed or the table is invalid. Reload before applying.'; return; }
    try {
      let next: string;
      if (table.from === table.to) {
        const before = snapshot.slice(0, table.from), after = snapshot.slice(table.to), eol = table.eol;
        next = before + (before && !before.endsWith(eol + eol) ? before.endsWith(eol) ? eol : eol + eol : '') + serializeTable(table) + (after && !after.startsWith(eol + eol) ? after.startsWith(eol) ? eol : eol + eol : '') + after;
      } else next = replaceTable(snapshot, table);
      if (new TextEncoder().encode(next).length > 4 * 1024 * 1024) throw new Error('Applying this table would exceed the 4 MiB document limit.');
      if (!apply(next, { text: snapshot, documentId: loadedId })) { stale = true; error = 'Document changed. Reload the table before applying edits.'; return; }
      const at = table.from; load(next, at); message = 'Table updated in the editor. Save to update the Markdown file.';
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  }
  async function importText(text: string, identity: number, original: string) {
    if (!alive) return;
    if (identity !== loadedId || original !== snapshot || original !== content) { error = 'Document changed during CSV import. Import the file again for the current document.'; return; }
    try {
      const parsed = tableFromCSV(text, snapshot.includes('\r\n') ? '\r\n' : '\n');
      parsed.from = table?.from ?? cursor; parsed.to = table?.to ?? cursor;
      table = parsed; selectedRow = 0; selectedColumn = 0; stale = false; error = ''; changed(); message = 'CSV loaded into the table editor. Apply table to change the document.';
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  }
  async function importCSV() {
    if (!desktop) { fileInput.value = ''; fileInput.click(); return; }
    const identity = loadedId, original = snapshot; busy = true; error = '';
    try {
      const path = await open({ directory: false, multiple: false, filters: [{ name: 'CSV', extensions: ['csv'] }] });
      if (typeof path === 'string') { const result = await invoke<{ content: string }>('read_document', { path }); await importText(result.content, identity, original); }
    } catch (cause) { if (alive) error = 'Could not import CSV: ' + String(cause); }
    finally { if (alive) busy = false; }
  }
  async function upload(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0]; if (!file) return;
    const identity = loadedId, original = snapshot;
    if (file.size > 4 * 1024 * 1024) { error = 'CSV exceeds the 4 MiB import limit.'; return; }
    try { await importText(await file.text(), identity, original); } catch (cause) { error = 'Could not import CSV: ' + String(cause); }
  }
  async function download() {
    if (!table) return;
    const csv = exportCSV(table.rows); busy = true; error = '';
    try {
      if (desktop) {
        const path = await save({ defaultPath: 'table.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
        if (!path) return;
        if (!path.toLowerCase().endsWith('.csv')) throw new Error('Choose a .csv filename for the exported table.');
        await invoke('write_document', { path, content: csv });
      } else {
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = 'table.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      if (alive) message = 'CSV exported. The Markdown document is unchanged.';
    } catch (cause) { if (alive) error = 'Could not export CSV: ' + String(cause); }
    finally { if (alive) busy = false; }
  }
</script>

<section class="utility-panel table-panel" aria-label="Table editor">
  <div class="scripts-heading"><strong>Table editor</strong><button aria-label="Close table editor" onclick={close}>×</button></div>
  {#if standalone}<p class="panel-note">Tables apply to Markdown documents. Mermaid source remains unchanged.</p>
  {:else}
    <p class="panel-note">Edit cells, then apply. Tab moves between cells.</p>
    {#if error}<div class="script-error" role="alert">{error}</div>{/if}
    {#if message}<p class="panel-status" role="status">{message}</p>{/if}
    {#if stale}<button onclick={() => load(content, cursor)}>Reload table</button>{/if}
    <details class="table-csv"><summary>CSV files</summary><p class="panel-note">The first row becomes the header. Multiline cells use &lt;br&gt;; CSV line endings are normalized.</p><div class="panel-actions"><button disabled={busy || stale || !!table?.error} onclick={importCSV}>Import CSV</button><button disabled={busy || !table || !!table.error} onclick={download}>Export CSV</button></div></details>
    {#if !table}
      <p class="panel-note">Place the caret inside a Markdown table, choose one below, or insert a new table.</p>
      <button onclick={fresh}>Insert table</button>
      {#each tables as candidate, index}<button class="table-choice" onclick={() => pick(candidate)} aria-label={'Edit table ' + (index + 1)}>Table {index + 1} · {candidate.rows[0].map((cell) => cell.value).join(' / ')}</button>{/each}
    {:else if table.error}<div class="script-error" role="alert">{table.error}</div>
    {:else}
      <div class="table-grid-scroll" bind:this={grid}>
        <table class="smart-table" aria-label="Editable Markdown table"><tbody>{#each table.rows as row, rowIndex}<tr>{#each row as cell, columnIndex}<td class:table-header={rowIndex === 0} class:selected-cell={selectedRow === rowIndex && selectedColumn === columnIndex}><textarea aria-label={'Cell row ' + (rowIndex + 1) + ' column ' + (columnIndex + 1)} data-row={rowIndex} data-column={columnIndex} bind:value={cell.value} oninput={changed} onfocus={() => { selectedRow = rowIndex; selectedColumn = columnIndex; }} onkeydown={(event) => keyCell(event, rowIndex, columnIndex)} rows="1" spellcheck="false"></textarea></td>{/each}</tr>{/each}</tbody></table>
      </div>
      <details class="table-structure"><summary>Rows and columns</summary><div class="panel-actions"><button disabled={stale || table.rows.length >= 1000 || (table.rows.length + 1) * table.rows[0].length > 10000} onclick={addRow}>Add row</button><button disabled={stale || selectedRow === 0} onclick={removeRow}>Delete row</button><button disabled={stale || table.rows[0].length >= 100 || table.rows.length * (table.rows[0].length + 1) > 10000} onclick={addColumn}>Add column</button><button disabled={stale || table.rows[0].length <= 1} onclick={removeColumn}>Delete column</button></div></details>
      <div class="table-column-settings"><label>Column<select aria-label="Sort column" value={selectedColumn} onchange={(event) => selectedColumn = Number(event.currentTarget.value)}>{#each table.rows[0] as cell, index}<option value={index}>{cell.value || 'Column ' + (index + 1)}</option>{/each}</select></label>
      <label>Alignment<select aria-label="Column alignment" value={table.alignments[selectedColumn] ?? 'default'} disabled={stale} onchange={(event) => { if (table) { table.alignments[selectedColumn] = event.currentTarget.value as Alignment; changed(); } }}><option value="default">Default</option><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label></div>
      <div class="panel-actions"><button disabled={stale} onclick={() => sort('ascending')}>Sort ascending</button><button disabled={stale} onclick={() => sort('descending')}>Sort descending</button></div>
      <div class="table-footer"><span>{dirty ? 'Pending edits' : 'No pending edits'}</span><button class="table-apply" disabled={!dirty || stale || busy} onclick={commit}>Apply table</button></div>
    {/if}
  {/if}
  <input class="file-input" type="file" accept=".csv,text/csv" aria-label="Import CSV file" bind:this={fileInput} onchange={upload} />
</section>

<style>
  .table-grid-scroll { max-width: 100%; min-height: 112px; max-height: min(46vh, 360px); flex-shrink: 0; overflow: auto; margin: 12px 0; border: 1px solid var(--border); }
  .smart-table { border-collapse: collapse; min-width: 100%; width: max-content; }
  .smart-table td { min-width: 105px; padding: 0; border: 1px solid var(--border); vertical-align: top; }
  .smart-table tr:first-child td { border-top: 0; }
  .smart-table td:first-child { border-left: 0; }
  .smart-table textarea { display: block; min-width: 105px; width: 100%; min-height: 32px; height: 32px; resize: vertical; border: 0; border-radius: 0; background: var(--bg); color: var(--text); padding: 6px; font: 11px/1.5 'Geist',sans-serif; }
  .smart-table .table-header textarea { font-weight: 600; background: var(--code); }
  .smart-table .selected-cell { outline: 1px solid var(--muted); outline-offset: -1px; }
  .table-choice { display: block; width: 100%; margin-top: 7px; text-align: left; white-space: normal; overflow-wrap: anywhere; }
  .table-footer { position: sticky; bottom: -24px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 16px; margin: 4px -16px -24px; background: var(--bar); border-top: 1px solid var(--border); z-index: 2; }
  .table-footer span { color: var(--muted); font-size: 10px; }
  .table-apply { border-color: var(--border); font-size: 10px; padding: 5px 7px; }
  .table-csv summary,.table-structure summary { cursor: pointer; color: var(--muted); font-size: 10px; }
  .table-csv .panel-note,.table-csv .panel-actions,.table-structure .panel-actions { margin-top: 8px; }
  .table-column-settings { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .table-column-settings label { display: grid; min-width: 0; gap: 5px; color: var(--muted); }
  .table-column-settings select { min-width: 0; text-overflow: ellipsis; }
  .table-panel button:disabled { cursor: default; }
</style>
