<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { save } from '@tauri-apps/plugin-dialog';
  import { prepareConverterHtml } from './export-converter';
  import { buildHtmlExport, exportFilename } from './export-html';
  import type { HtmlExportFormat, HtmlExportSource } from './export-html';
  import type { EmbedDocument } from './render-content';
  let { snapshot, theme, loadEmbed, close }: { snapshot: () => HtmlExportSource; theme: 'dark' | 'light'; loadEmbed?: (target: string, sourcePath?: string) => Promise<EmbedDocument>; close: () => void } = $props();
  type Format = HtmlExportFormat | 'pdf' | 'docx' | 'pptx';
  let engines = $state<{ available: boolean; error?: string; engines?: { pandoc: boolean; typst: boolean } } | null>(null), conversionId: string | null = null;
  let format = $state<Format>('html'), busy = $state(false), error = $state(''), message = $state(''), warnings = $state<string[]>([]), progress = $state('');
  let abort: AbortController | undefined, alive = true;
  const desktop = isTauri();
  async function cancel() { abort?.abort(); if (alive) message = 'Export canceled.'; if (conversionId) await invoke('cancel_export', { id: conversionId }).catch(() => {}); }
  onMount(() => { if (desktop) void invoke<typeof engines>('engine_status').then((value) => { if (alive) engines = value; }).catch((cause) => { if (alive) engines = { available: false, error: String(cause) }; }); });
  onDestroy(() => { alive = false; void cancel(); });
  async function run() {
    if (busy) return;
    const source = snapshot(), selected = format;
    busy = true; error = ''; message = ''; warnings = []; progress = 'Preparing export…'; abort = new AbortController();
    try {
      const converting = ['pdf','docx','pptx'].includes(selected);
      if (converting && !desktop) throw new Error('PDF, DOCX, and PPTX exports require the desktop app with its bundled conversion engines.');
      if (converting && engines && (engines.engines ? !engines.engines.pandoc || selected === 'pdf' && !engines.engines.typst : !engines.available)) throw new Error('Bundled export engines are unavailable. Reinstall the complete desktop package. ' + (engines.error || ''));
      const result = await buildHtmlExport(source, { format: converting ? 'self-contained' : selected as HtmlExportFormat, theme: converting ? 'light' : theme, loadEmbed, signal: abort.signal, progress: stage => { if (alive) progress = stage; } });
      if (!alive || abort.signal.aborted) return;
      warnings = result.warnings;
      const name = converting ? exportFilename(source.name).replace(/\.html$/u, '.' + selected) : exportFilename(source.name);
      if (converting) {
        progress = 'Choose a destination…';
        const path = await save({ defaultPath: name, filters: [{ name: selected.toUpperCase(), extensions: [selected] }] });
        if (!path || !alive || abort.signal.aborted) return;
        if (!path.toLowerCase().endsWith('.' + selected)) throw new Error('Choose a .' + selected + ' filename for this export.');
        progress = 'Converting to ' + selected.toUpperCase() + '…';
        const prepared = prepareConverterHtml(result.html); conversionId = crypto.randomUUID();
        const saved = await invoke<{ warning?: string }>('export_document', { request: { id: conversionId, content: prepared.content, inputFormat: 'html', format: selected, outputPath: path, sourcePath: source.path, assets: prepared.assets, title: source.name } });
        if (!alive || abort.signal.aborted) return;
        if (saved.warning) warnings = [...warnings, saved.warning];
        message = 'Exported ' + (path.split(/[\\/]/u).pop() || name) + '. The source document is unchanged.'; return;
      }
      if (desktop) {
        progress = 'Choose a destination…';
        const path = await save({ defaultPath: name, filters: [{ name: 'HTML webpage', extensions: ['html'] }] });
        if (!path || !alive || abort.signal.aborted) return;
        if (!/\.html?$/iu.test(path)) throw new Error('Choose an .html filename for this export.');
        progress = 'Writing HTML…';
        const saved = await invoke<{ warning?: string }>('write_document', { path, content: result.html });
        if (saved.warning) warnings = [...warnings, saved.warning];
        message = 'Exported ' + (path.split(/[\\/]/u).pop() || name) + '. The source document is unchanged.';
      } else {
        const url = URL.createObjectURL(new Blob([result.html], { type: 'text/html;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        message = 'Downloaded ' + name + '. The source document is unchanged.';
      }
    } catch (cause) { if (alive && !abort.signal.aborted) error = cause instanceof Error ? cause.message : String(cause); }
    finally { conversionId = null; if (alive) { busy = false; progress = ''; } }
  }
</script>

<section class="utility-panel export-panel" aria-label="Export">
  <div class="scripts-heading"><strong>Export</strong><button aria-label="Close export" onclick={close}>×</button></div>
  <label>Export format<select aria-label="Export format" bind:value={format} disabled={busy}><option value="html">HTML with linked images</option><option value="self-contained">Self-contained webpage</option><option value="pdf">PDF</option><option value="docx">DOCX</option><option value="pptx">PPTX</option></select></label>
  <p class="panel-note">{['pdf','docx','pptx'].includes(format) ? 'Export this note with its rendered diagrams, math, and embedded content.' : 'A static webpage with rendered diagrams, math, and embedded content.'}</p>
  {#if ['pdf','docx','pptx'].includes(format)}<p class="panel-note">{desktop ? 'Uses bundled conversion engines. Remote resources are not fetched.' : 'PDF, DOCX, and PPTX are available in the desktop app.'}</p>{:else if format === 'self-contained'}<p class="panel-note">Styles, fonts, and local media are bundled. Unsupported resources are reported.</p>{:else}<p class="panel-note">Styles and fonts are included. Images remain linked.</p>{/if}
  <details class="export-help"><summary>Export details</summary><p class="panel-note">Exports a snapshot; editing the note later does not change the file. Checkboxes are static and callouts are expanded. Existing destinations are replaced only after a successful export.</p></details>
  {#if busy && progress}<p class="panel-status" role="status">{progress}</p>{/if}
  {#if error}<div class="script-error" role="alert">{error}</div>{/if}
  {#if message}<p class="panel-status" role="status">{message}</p>{/if}
  {#each warnings as warning}<p class="panel-note" role="status">{warning}</p>{/each}
  <div class="panel-actions"><button aria-label="Export document" disabled={busy} onclick={run}>{busy ? 'Exporting…' : 'Export document'}</button>{#if busy}<button onclick={() => void cancel()}>Cancel export</button>{/if}</div>
</section>

<style>.export-help summary{cursor:pointer;font-size:10px;color:var(--muted)}.export-help p{margin-top:8px}.export-panel button:disabled{cursor:default}</style>
