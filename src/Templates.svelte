<script module lang="ts">
  const workingDrafts = new Map<string, { name: string; content: string }>();
  let lastTemplate = '';
</script>
<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { open, save } from '@tauri-apps/plugin-dialog';
  import { currentMetadata, persistMetadata, flushPersistence, observePersistence } from './store';
  import { parseFrontmatter } from './frontmatter';
  import { insertTemplate, readTemplateLibrary, substituteVariables, validateTemplateLibrary } from './templates';
  import type { SavedTemplate } from './templates';
  type Snapshot = { document: { name: string; path: string | null; text: string; selection: string; from: number; to: number }; documentId: number };
  type Prepared = { text: string; next: string; source: { text: string; documentId: number }; missing: string[] };
  let { snapshot, apply, close }: { snapshot: () => Snapshot; apply: (next: string, source: { text: string; documentId: number }) => boolean; close: () => void } = $props();
  let library = $state<SavedTemplate[]>([]), id = $state(''), name = $state('Untitled template'), content = $state('');
  let prepared = $state<Prepared | null>(null), error = $state(''), message = $state(''), invalidLibrary = $state(false), busy = $state(false);
  let fileInput: HTMLInputElement, alive = true, editVersion = 0;
  const desktop = isTauri();
  try { library = readTemplateLibrary(currentMetadata().settings.templates); } catch (cause) { error = String(cause); invalidLibrary = true; }
  const selectedSaved = $derived(library.find(template => template.id === id));
  const draftDirty = $derived(name !== (selectedSaved?.name ?? 'Untitled template') || content !== (selectedSaved?.content ?? ''));
  function keepDraft() { workingDrafts.set(id,{name,content}); lastTemplate = id; }
  untrack(() => { if (!invalidLibrary) { id = library.some(template => template.id === lastTemplate) ? lastTemplate : ''; const current = workingDrafts.get(id) ?? library.find(template => template.id === id); if (current) { name = current.name; content = current.content; } } });
  onDestroy(() => { keepDraft(); alive = false; });
  function changed() { prepared = null; message = ''; editVersion++; }
  function pick(value: string) { keepDraft(); id = value; const saved = workingDrafts.get(id) ?? library.find((item) => item.id === id); name = saved?.name ?? 'Untitled template'; content = saved?.content ?? ''; changed(); }
  async function persist(next: SavedTemplate[]) { validateTemplateLibrary(next); persistMetadata({ settings: { templates: next } }); await flushPersistence(); let failure = ''; const unobserve = observePersistence((status) => { if (status.state === 'error') failure = status.error; }); unobserve(); if (failure) throw new Error('The template library could not be saved. Keep this panel open or export the template, then retry saving app state. ' + failure); library = next; }
  async function saveTemplate() {
    busy = true;
    try {
      if (invalidLibrary) throw new Error('Repair or explicitly reset the invalid template library before saving.');
      if (!name.trim()) throw new Error('Enter a template name.');
      const saved = { id: id || crypto.randomUUID(), name: name.trim(), content, updatedAt: Date.now() };
      await persist(library.some((item) => item.id === saved.id) ? library.map((item) => item.id === saved.id ? saved : item) : [...library, saved]);
      if (!id) workingDrafts.delete(''); id = saved.id; name = saved.name; keepDraft(); error = ''; message = 'Template saved to the library.';
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { if (alive) busy = false; }
  }
  async function remove() { if (!id) return; busy = true; try { await persist(library.filter((item) => item.id !== id)); workingDrafts.delete(id); id = ''; const draft = workingDrafts.get(''); name = draft?.name ?? 'Untitled template'; content = draft?.content ?? ''; changed(); error = ''; message = 'Template deleted from the library.'; } catch (cause) { error = String(cause); } finally { if (alive) busy = false; } }
  function preview() {
    error = ''; message = '';
    try {
      const source = snapshot(), frontmatter = parseFrontmatter(source.document.text);
      if (frontmatter?.error) throw new Error('Repair the document frontmatter before resolving template variables: ' + frontmatter.error);
      const resolved = substituteVariables(content, frontmatter?.values ?? {}, source.document.name);
      prepared = { text: resolved.text, next: insertTemplate(source.document.text, source.document.from, source.document.to, resolved.text), source: { text: source.document.text, documentId: source.documentId }, missing: resolved.missing };
      if (resolved.missing.length) error = 'Missing properties: ' + resolved.missing.join(', ') + '. Markers remain unchanged in the preview.';
    } catch (cause) { prepared = null; error = cause instanceof Error ? cause.message : String(cause); }
  }
  function insert() {
    if (!prepared || prepared.missing.length) return;
    if (!apply(prepared.next, prepared.source)) { error = 'The document changed after preview. Preview the template again before inserting.'; return; }
    prepared = null; error = ''; message = 'Template inserted as one undoable edit. Save to update the document file.';
  }
  async function importText(text: string, filename: string, version: number) {
    if (!alive) return;
    if (version !== editVersion) { error = 'The template changed during import. Import the file again.'; return; }
    // The full file remains untouched; large imports can still be reviewed and
    // inserted, but Save template enforces the bounded metadata library.
    if (new TextEncoder().encode(text).length > 4 * 1024 * 1024) throw new Error('Template exceeds the 4 MiB import limit.');
    id = ''; name = filename.replace(/\.(?:md|markdown|txt)$/iu, ''); content = text; changed(); error = ''; message = 'Markdown template imported. Save template to add it to the library.';
  }
  async function importFile() {
    if (!desktop) { fileInput.value = ''; fileInput.click(); return; }
    const version = editVersion; busy = true;
    try { const path = await open({ multiple: false, directory: false, filters: [{ name: 'Markdown template', extensions: ['md','markdown','txt'] }] }); if (typeof path === 'string') { const result = await invoke<{ content: string }>('read_document', { path }); await importText(result.content, path.split(/[\\/]/u).pop() || 'Template', version); } }
    catch (cause) { if (alive) error = 'Could not import template: ' + String(cause); }
    finally { if (alive) busy = false; }
  }
  async function upload(event: Event) { const file = (event.currentTarget as HTMLInputElement).files?.[0]; if (!file) return; try { if (file.size > 4 * 1024 * 1024) throw new Error('Template exceeds the 4 MiB import limit.'); const version = editVersion; await importText(await file.text(),file.name,version); } catch (cause) { if (alive) error = String(cause); } }
  async function exportFile() {
    const text = content, filename = (name.trim().replace(/[\\/:*?"<>|]/gu, '-') || 'template') + '.md'; busy = true; error = '';
    try {
      if (desktop) { const path = await save({ defaultPath: filename, filters: [{ name: 'Markdown template', extensions: ['md'] }] }); if (!path || !alive) return; await invoke('write_document', { path, content: text }); }
      else { const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }
      if (alive) message = 'Template exported as Markdown.';
    } catch (cause) { if (alive) error = 'Could not export template: ' + String(cause); }
    finally { if (alive) busy = false; }
  }
</script>

<section class="utility-panel templates-panel" aria-label="Templates">
  <div class="scripts-heading"><strong>Templates</strong><button aria-label="Close templates" onclick={close}>×</button></div>
  <label>Saved templates<select aria-label="Saved templates" value={id} disabled={busy} onchange={(event) => pick(event.currentTarget.value)}><option value="">Unsaved template</option>{#each library as template}<option value={template.id}>{template.name}</option>{/each}</select></label>
  <div class="panel-actions"><button disabled={busy || !id} onclick={() => pick('')}>New template</button><button disabled={busy || invalidLibrary} onclick={saveTemplate}>Save template</button><button disabled={busy || !id || invalidLibrary} onclick={remove}>Delete template</button></div>
  <label>Template name<input aria-label="Template name" bind:value={name} disabled={busy} oninput={changed} /></label>
  <label>Template content<textarea aria-label="Template content" bind:value={content} disabled={busy} oninput={changed} spellcheck="false"></textarea></label>
  {#if draftDirty}<span class="template-draft-label" title="Kept while the app is open. Save template to keep it after restart.">Unsaved edits</span>{/if}
  <details class="template-help"><summary>Variables</summary><p class="panel-note">Use &#123;&#123;property&#125;&#125; for frontmatter values, nested fields such as &#123;&#123;project.name&#125;&#125;, and &#123;&#123;document.name&#125;&#125; for the filename. Values are text; expressions and JavaScript never run.</p></details>
  {#if error}<div class="script-error" role="alert">{error}</div>{/if}
  {#if invalidLibrary}<button disabled={busy} onclick={async () => { busy = true; try { await persist([]); invalidLibrary = false; error = ''; } catch (cause) { error = String(cause); } finally { busy = false; } }}>Reset invalid template library</button>{/if}
  {#if message}<p class="panel-status" role="status">{message}</p>{/if}
  <details class="template-files"><summary>Template files</summary><div class="panel-actions"><button disabled={busy} onclick={importFile}>Import template</button><button disabled={busy} onclick={exportFile}>Export template</button></div></details>
  {#if prepared}<pre class="template-preview" aria-label="Template preview">{prepared.text}</pre>{/if}
  <div class="panel-actions template-footer"><button disabled={busy || !content} onclick={preview}>Preview template</button><button disabled={busy || !prepared || !!prepared.missing.length} onclick={insert}>Insert template</button></div>
  <input class="file-input" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" aria-label="Import template file" bind:this={fileInput} onchange={upload} />
</section>
<style>.templates-panel textarea{min-height:160px;font:11px/1.6 'Geist Mono',monospace;resize:vertical}.template-preview{white-space:pre-wrap;overflow-wrap:anywhere;border-top:1px solid var(--border);padding-top:12px;font:11px/1.6 'Geist Mono',monospace;color:var(--text)}.template-draft-label{color:var(--muted);font-size:10px}.template-help summary,.template-files summary{cursor:pointer;color:var(--muted);font-size:10px}.template-help p,.template-files .panel-actions{margin-top:8px}.template-footer{position:sticky;bottom:-24px;padding:10px 16px;margin:4px -16px -24px;background:var(--bar);border-top:1px solid var(--border);z-index:2}.template-preview{max-height:180px;overflow:auto}.templates-panel button:disabled{cursor:default}</style>
