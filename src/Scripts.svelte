<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { isTauri } from '@tauri-apps/api/core';
  import { invoke } from '@tauri-apps/api/core';
  import { runScript } from './script-runner';
  import type { ScriptDocument, ScriptResult } from './script-runner';
  import { currentMetadata, deleteScript, flushPersistence, nativeStore, persistMetadata, savedScripts, saveScript } from './store';
  import type { SavedScript } from './store';

  type Snapshot = { document: ScriptDocument; documentId: number };
  let { snapshot, apply, close, lockedReason = '' }: { snapshot: () => Snapshot; apply: (text: string, source: Snapshot) => boolean; close: () => void; lockedReason?: string } = $props();
  const metadata = currentMetadata();
  const stored = metadata.scriptDraft;
  const activeId = typeof metadata.settings.activeScriptId === 'string' ? metadata.settings.activeScriptId : stored?.id ?? '';
  const initialRecord = metadata.scripts.find((script) => script.id === activeId) ?? (!stored ? metadata.scripts[0] : undefined);
  let library = $state<SavedScript[]>(metadata.scripts);
  let selectedId = $state(activeId || initialRecord?.id || '');
  let scriptName = $state(stored?.name ?? initialRecord?.name ?? 'Document transform');
  let code = $state(stored?.code ?? initialRecord?.code ?? 'console.log(api.context.document.name);\nreturn api.context.document.text;');
  let cwd = $state(stored?.cwd ?? initialRecord?.cwd ?? '');
  let saving = $state(false);
  let canApply = $state(false);
  type Run = ScriptResult & { scriptId: string | null; startedAt: number; finishedAt: number };
  let runs = $state<Run[]>([]);
  let running = $state(false);
  let output = $state<ScriptResult | null>(null);
  let error = $state('');
  let message = $state('Ready');
  let runSnapshot: Snapshot | null = null;
  let active: ReturnType<typeof runScript> | null = null;
  let serial = 0;
  const desktop = isTauri();
  let textResult = $derived(typeof output?.result === 'string' ? output.result : output?.result && typeof output.result === 'object' && 'text' in output.result && typeof output.result.text === 'string' ? output.result.text : null);
  $effect(() => {
    persistMetadata({ scriptDraft: { id: selectedId || null, name: scriptName, code, cwd: cwd || null }, settings: { activeScriptId: selectedId || null } });
  });

  function selectScript(event: Event) {
    selectedId = (event.currentTarget as HTMLSelectElement).value;
    const script = library.find((item) => item.id === selectedId);
    if (script) { scriptName = script.name; code = script.code; cwd = script.cwd || ''; output = null; canApply = false; message = 'Loaded saved script'; }
    void loadRuns();
  }
  function newScript() {
    selectedId = ''; scriptName = 'Untitled script'; code = ''; cwd = ''; output = null; error = ''; canApply = false; message = 'New script draft';
  }
  async function save() {
    if (saving) return;
    saving = true; error = '';
    try {
      const result = await saveScript({ id: selectedId || crypto.randomUUID(), name: scriptName.trim() || 'Untitled script', code, cwd: cwd.trim() || null });
      selectedId = result.id; scriptName = result.name; library = await savedScripts(); message = 'Script saved';
    } catch (cause) { error = 'Could not save script: ' + String(cause); }
    finally { saving = false; }
  }
  async function remove() {
    if (!selectedId || saving) return;
    saving = true; error = '';
    try { await deleteScript(selectedId); library = await savedScripts(); newScript(); message = 'Script deleted'; }
    catch (cause) { error = 'Could not delete script: ' + String(cause); }
    finally { saving = false; }
  }
  async function loadRuns() {
    if (!nativeStore) return;
    try { runs = await invoke<Run[]>('list_script_runs', { scriptId: selectedId || null }); }
    catch (cause) { error = 'Could not load script run history: ' + String(cause); }
  }
  onMount(() => {
    void savedScripts().then((items) => library = items).catch((cause: unknown) => error = 'Could not load saved scripts: ' + String(cause));
    void loadRuns();
  });

  async function run() {
    if (running) return;
    running = true; output = null; canApply = false; error = ''; message = 'Running…';
    runSnapshot = snapshot();
    const ticket = ++serial;
    const request = { id: crypto.randomUUID(), scriptId: selectedId || null, code, cwd: cwd.trim() || null, document: runSnapshot.document };
    await flushPersistence();
    if (ticket !== serial) return;
    active = runScript(request);
    const result = await active.result;
    if (ticket !== serial) return;
    output = result; running = false; active = null;
    canApply = result.ok;
    message = result.ok ? 'Script finished' : 'Script failed';
    if (!result.ok) error = result.error || 'Script failed.';
    void loadRuns();
  }
  async function stop() {
    if (!active) { if (running) { serial++; running = false; message = 'Script stopped.'; } return; }
    message = 'Stopping…';
    try { await active.stop(); } catch (cause) { error = 'Could not stop script: ' + String(cause); }
  }
  function applyResult() {
    if (lockedReason) { error = lockedReason; return; }
    if (textResult === null || !runSnapshot) return;
    if (!apply(textResult, runSnapshot)) error = 'Document changed since the script ran. Run it again before applying.';
    else { error = ''; message = 'Applied to document'; }
  }
  onDestroy(() => { serial++; if (active) void active.stop().catch(() => {}); });
</script>

<div class="scripts-panel" role="dialog" aria-label="Scripts" aria-modal="false" tabindex="-1">
  <div class="scripts-heading"><strong>Scripts</strong><button aria-label="Close scripts" onclick={close}>×</button></div>
  <p class="script-permission">Scripts can read/write files and run commands as your user.</p>
  {#if !desktop}<p class="script-browser-note">Browser mode runs document transforms. Local files and system commands require the desktop app.</p>{/if}
  <label>Saved script<select aria-label="Saved script" bind:value={selectedId} onchange={selectScript}><option value="">Unsaved draft</option>{#each library as script}<option value={script.id}>{script.name}</option>{/each}</select></label>
  <div class="panel-actions"><button onclick={newScript} disabled={running || saving}>New script</button><button onclick={save} disabled={saving}>Save script</button><button onclick={remove} disabled={!selectedId || saving}>Delete script</button></div>
  <label>Script name<input aria-label="Script name" bind:value={scriptName} /></label>
  <label>Working directory<input aria-label="Working directory" placeholder="Document folder or home" bind:value={cwd} spellcheck="false" /></label>
  <label class="script-code-label">JavaScript<textarea aria-label="Script code" bind:value={code} spellcheck="false"></textarea></label>
  <details class="script-api"><summary>Script API</summary><code>api.context.document: name, path, text, selection, from, to<br />api.context.cwd<br />api.readText(path) / api.writeText(path, text)<br />api.listDir(path)<br />api.run(program, args, &#123; cwd, timeoutMs &#125;)<br />return text or &#123; text &#125; to apply manually.</code><p>Synchronous JavaScript · 15-second limit · no automatic execution.</p></details>
  {#if lockedReason}<p class="panel-note" role="status">{lockedReason}</p>{/if}
  <div class="script-actions"><button class="save-button" onclick={run} disabled={running}>Run script</button><button onclick={stop} disabled={!running}>Stop script</button><button onclick={applyResult} disabled={!!lockedReason || running || textResult === null || !output?.ok || !canApply}>Apply to document</button></div>
  <div class="script-status" role="status">{message}</div>
  {#if error}<div class="script-error" role="alert">{error}</div>{/if}
  <div class="script-log" role="log" aria-label="Script log">{#each output?.logs ?? [] as entry}<div class:log-error={entry.level === 'error'}><span>{entry.level}</span> {entry.message}</div>{/each}</div>
  {#if output?.ok}<pre class="script-output" aria-label="Script output">{typeof output.result === 'string' ? output.result : JSON.stringify(output.result, null, 2)}</pre>{/if}
  {#if desktop}<details class="script-runs"><summary>Script runs</summary><button onclick={loadRuns}>Refresh script runs</button>{#each runs.slice(0, 12) as run}<button aria-label={'Run result ' + new Date(run.startedAt).toLocaleString()} onclick={() => { output = run; canApply = false; runSnapshot = null; error = run.error || ''; message = run.ok ? 'Previous run succeeded' : 'Previous run failed'; }}>{new Date(run.startedAt).toLocaleString()} · {run.ok ? 'Succeeded' : 'Failed'}</button>{/each}{#if !runs.length}<p class="panel-note">No runs recorded.</p>{/if}</details>{/if}
</div>
