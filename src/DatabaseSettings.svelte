<script lang="ts">
  import { onMount } from 'svelte';
  import { open } from '@tauri-apps/plugin-dialog';
  import { nativeStore } from './store';
  import SegmentedControl from './SegmentedControl.svelte';
  import SelectControl from './SelectControl.svelte';
  import NumberControl from './NumberControl.svelte';
  import type { IconTheme } from './icons';
  import { DESKTOP_ONLY, connectionSummary, defaultPorts, deleteConnection, kindLabels, listConnections, newProfile, saveConnection, sqlFailure, testConnection } from './sql-connections';
  import type { PasswordStorage, SqlConnection, SqlConnectionList, SqlKind, SqlProfile, TlsMode } from './sql-connections';

  let { theme }: { theme: IconTheme } = $props();

  const instanceId = $props.id();
  const kindOptions = (['sqlite', 'postgres', 'mysql'] as const).map((value) => ({ value, label: kindLabels[value] }));
  const tlsOptions: { value: TlsMode; label: string; hint: string }[] = [
    { value: 'disable', label: 'Disable', hint: 'no encryption' },
    { value: 'prefer', label: 'Prefer', hint: 'encrypt if offered' },
    { value: 'require', label: 'Require', hint: 'always encrypt' },
    { value: 'verify-full', label: 'Verify full', hint: 'encrypt and verify' },
  ];
  const passwordLabels: Record<SqlConnection['passwordState'], string> = { none: 'no password', keychain: 'stored in keychain', session: 'entered for this session', needed: 'asked every session' };

  let list = $state<SqlConnectionList | null>(null);
  let loading = $state(false), loadError = $state('');
  // The profile being edited. The password field is separate, is sent once
  // on save or test, and is cleared afterwards; it is never filled from the
  // backend.
  let form = $state<SqlProfile | null>(null), original = $state<string | null>(null), password = $state('');
  let saving = $state(false), testing = $state(false), formError = $state(''), testMessage = $state('');
  let confirming = $state<string | null>(null), deleting = $state(false), listMessage = $state('');
  let nameInput = $state<HTMLInputElement>();

  let keychain = $derived(list?.keychainAvailable ?? false);
  let editing = $derived(original ? list?.connections.find((connection) => connection.name === original) : undefined);
  let passwordKept = $derived(!!editing && !!form && editing.passwordStorage === form.passwordStorage && form.passwordStorage !== 'none');
  let storageOptions = $derived([
    { value: 'keychain', label: 'System keychain', disabled: !keychain, hint: keychain ? undefined : 'unavailable' },
    { value: 'session', label: 'Ask every session', hint: 'memory only' },
    { value: 'none', label: 'No password' },
  ]);
  let passwordPlaceholder = $derived(!form || form.passwordStorage === 'none' ? '' : passwordKept && editing?.passwordState === 'keychain' ? 'Stored in keychain — type to replace' : passwordKept && editing?.passwordState === 'session' ? 'Entered for this session — type to replace' : form.passwordStorage === 'session' ? 'Optional now; asked when you run a query' : 'Password');

  async function refresh() {
    if (!nativeStore) return;
    loading = true; loadError = '';
    try { list = await listConnections(); }
    catch (cause) { loadError = sqlFailure(cause).message; }
    finally { loading = false; }
  }
  onMount(() => { void refresh(); });

  function focusName() { queueMicrotask(() => nameInput?.focus()); }
  function add() {
    form = newProfile('postgres', keychain); original = null; password = ''; formError = ''; testMessage = ''; listMessage = ''; confirming = null; focusName();
  }
  function edit(connection: SqlConnection) {
    const { passwordState: _state, ...profile } = connection;
    form = { ...profile }; original = connection.name; password = ''; formError = ''; testMessage = ''; listMessage = ''; confirming = null; focusName();
  }
  function closeForm() { form = null; original = null; password = ''; formError = ''; testMessage = ''; }
  function setKind(kind: SqlKind) {
    if (!form || form.kind === kind) return;
    const fresh = newProfile(kind, keychain);
    // Keep what carries over; a default port follows the kind.
    form = { ...fresh, name: form.name, rowLimit: form.rowLimit, timeoutSeconds: form.timeoutSeconds, ...(kind === 'sqlite' ? {} : { host: form.host || fresh.host, database: form.database, user: form.user, port: form.port && form.port !== defaultPorts[form.kind] ? form.port : fresh.port, tlsMode: form.kind === 'sqlite' ? fresh.tlsMode : form.tlsMode, passwordStorage: form.kind === 'sqlite' ? fresh.passwordStorage : form.passwordStorage }) };
    if (kind === 'sqlite') password = '';
    testMessage = '';
  }
  function setStorage(value: string) {
    if (!form) return;
    form.passwordStorage = value as PasswordStorage;
    if (value === 'none') password = '';
  }
  /** The profile as the backend expects it; the port field may be empty. */
  function profile(): SqlProfile {
    const value = $state.snapshot(form) as SqlProfile;
    return { ...value, name: value.name.trim(), host: value.host.trim(), database: value.database.trim(), user: value.user.trim(), path: value.path.trim(), caFile: value.caFile.trim(), port: Number.isInteger(value.port) && value.port > 0 && value.port < 65536 ? value.port : 0 };
  }
  async function save(event: Event) {
    event.preventDefault();
    if (!form || saving) return;
    saving = true; formError = ''; testMessage = '';
    try {
      const saved = await saveConnection(profile(), password || null, original);
      listMessage = `Saved ${saved.name}.`;
      closeForm();
      await refresh();
    } catch (cause) { formError = sqlFailure(cause).message; }
    finally { saving = false; }
  }
  async function test() {
    if (!form || testing) return;
    testing = true; formError = ''; testMessage = '';
    try {
      const result = await testConnection(profile(), password || null, original);
      testMessage = `Connected to ${result.server} in ${result.durationMs} ms.`;
    } catch (cause) { formError = sqlFailure(cause).message; }
    finally { testing = false; }
  }
  async function remove(name: string) {
    if (deleting) return;
    deleting = true; listMessage = '';
    try {
      await deleteConnection(name);
      if (original === name) closeForm();
      listMessage = `Deleted ${name} and its stored password.`;
      await refresh();
    } catch (cause) { listMessage = sqlFailure(cause).message; }
    finally { deleting = false; confirming = null; }
  }
  async function choose(field: 'path' | 'caFile') {
    if (!form) return;
    try {
      const selected = await open({ multiple: false, directory: false, title: field === 'path' ? 'Choose a SQLite database' : 'Choose a CA certificate (PEM)', filters: field === 'path' ? [{ name: 'SQLite database', extensions: ['sqlite', 'sqlite3', 'db', 'db3'] }, { name: 'All files', extensions: ['*'] }] : [{ name: 'PEM certificate', extensions: ['pem', 'crt', 'cer'] }, { name: 'All files', extensions: ['*'] }] });
      if (typeof selected === 'string' && form) form[field] = selected;
    } catch (cause) { formError = 'Could not open the file chooser: ' + String(cause); }
  }
</script>

<div class="settings-intro"><strong>Query your databases.</strong><p>Read-only SQL blocks in notes. A note names a connection; details and passwords stay here.</p></div>
{#if !nativeStore}
  <p class="settings-help" role="note">{DESKTOP_ONLY}</p>
{:else}
  <div class="settings-databases">
    <section class="database-keychain-card" data-state={!list ? 'checking' : keychain ? 'ready' : 'error'} aria-label="Password storage">
      <span class="agent-status-dot" aria-hidden="true"></span>
      <div role="status" aria-live="polite">
        {#if !list}<strong>Checking the system keychain…</strong>
        {:else if keychain}<strong>Passwords are kept in the system keychain</strong><p>Never in notes, settings, drafts or exports.</p>
        {:else}<strong>No system keychain is available</strong><p>{list.keychainReason} Passwords are not written to disk instead: choose “Ask every session” and Notation keeps the password in memory until you quit.</p>{/if}
      </div>
    </section>
    {#if loadError}<div class="script-error" role="alert">{loadError}</div>{/if}

    <section class="database-list" aria-label="Connections">
      {#if list && !list.connections.length}<p class="panel-note">No connections yet. Add one, then use it in a note with a <code>sql connection:name</code> code block.</p>{/if}
      {#each list?.connections ?? [] as connection (connection.name)}
        <div class="database-row" data-connection={connection.name}>
          <div class="database-row-copy">
            <strong>{connection.name}</strong><span class="database-kind">{kindLabels[connection.kind]}</span>
            <p title={connectionSummary(connection)}>{connectionSummary(connection)}</p>
            <p class="database-password-state">{connection.kind === 'sqlite' ? 'opened read-only' : passwordLabels[connection.passwordState]} · {connection.rowLimit} rows · {connection.timeoutSeconds} s</p>
          </div>
          {#if confirming === connection.name}
            <div class="database-row-actions" role="group" aria-label={'Delete ' + connection.name + '?'}>
              <span class="database-confirm">Delete, with its stored password?</span>
              <button type="button" class="database-danger" disabled={deleting} onclick={() => void remove(connection.name)}>{deleting ? 'Deleting…' : 'Delete'}</button>
              <button type="button" disabled={deleting} onclick={() => confirming = null}>Keep</button>
            </div>
          {:else}
            <div class="database-row-actions">
              <button type="button" aria-label={'Edit connection: ' + connection.name} onclick={() => edit(connection)}>Edit</button>
              <button type="button" aria-label={'Delete connection: ' + connection.name} onclick={() => { confirming = connection.name; listMessage = ''; }}>Delete</button>
            </div>
          {/if}
        </div>
      {/each}
      {#if listMessage}<p class="panel-status database-message" role="status">{listMessage}</p>{/if}
      {#if !form}<button type="button" class="database-add" disabled={loading || !list} onclick={add}>Add connection</button>{/if}
    </section>

    {#if form}
      <form class="database-form" aria-label={original ? 'Edit connection' : 'New connection'} onsubmit={save} autocomplete="off" novalidate>
        <strong class="database-form-title">{original ? 'Edit ' + original : 'New connection'}</strong>
        <div class="settings-fields">
          <div class="settings-field"><label class="settings-field-label" for={instanceId + '-name'}>Name</label><input id={instanceId + '-name'} bind:this={nameInput} bind:value={form.name} placeholder="analytics" maxlength="64" spellcheck="false" autocapitalize="off" aria-describedby={instanceId + '-name-help'} /></div>
          <p class="settings-help" id={instanceId + '-name-help'}>Notes refer to the connection by this name: <code>```sql connection:{form.name.trim() || 'name'}</code>. Letters, digits, <code>-</code> and <code>_</code>.</p>
          <SegmentedControl label="Kind" options={kindOptions} value={form.kind} onchange={(value) => setKind(value as SqlKind)} />
          {#if form.kind === 'sqlite'}
            <div class="settings-field"><label class="settings-field-label" for={instanceId + '-path'}>Database file</label><div class="database-file"><input id={instanceId + '-path'} bind:value={form.path} placeholder="/path/to/database.sqlite3" spellcheck="false" /><button type="button" onclick={() => void choose('path')}>Choose…</button></div></div>
            <p class="settings-help">Opened read-only. A file that does not exist is never created.</p>
          {:else}
            <div class="settings-field"><label class="settings-field-label" for={instanceId + '-host'}>Host</label><input id={instanceId + '-host'} bind:value={form.host} placeholder="localhost" spellcheck="false" autocapitalize="off" /></div>
            <div class="settings-field"><label class="settings-field-label" for={instanceId + '-port'}>Port</label><input id={instanceId + '-port'} type="text" inputmode="numeric" value={form.port || ''} placeholder={String(defaultPorts[form.kind])} oninput={(event) => { if (form) form.port = Number((event.currentTarget as HTMLInputElement).value.replace(/\D/gu, '').slice(0, 5)) || 0; }} /></div>
            <div class="settings-field"><label class="settings-field-label" for={instanceId + '-database'}>Database</label><input id={instanceId + '-database'} bind:value={form.database} spellcheck="false" autocapitalize="off" /></div>
            <div class="settings-field"><label class="settings-field-label" for={instanceId + '-user'}>User</label><input id={instanceId + '-user'} bind:value={form.user} spellcheck="false" autocapitalize="off" autocomplete="off" /></div>
            <SelectControl label="Password" options={storageOptions} value={form.passwordStorage} onchange={setStorage} {theme} />
            {#if form.passwordStorage !== 'none'}
              <div class="settings-field"><label class="settings-field-label" for={instanceId + '-password'}>{passwordKept ? 'Replace password' : 'Password'}</label><input id={instanceId + '-password'} type="password" bind:value={password} placeholder={passwordPlaceholder} autocomplete="new-password" spellcheck="false" /></div>
            {/if}
            <p class="settings-help">{form.passwordStorage === 'keychain' ? 'Sent to the system keychain when you save. Notation does not show it again.' : form.passwordStorage === 'session' ? 'Kept in memory until you quit, and asked for again next time. Nothing is written to disk.' : 'For servers that accept this user without a password.'}{#if !keychain && list} The system keychain is unavailable: {list.keychainReason}{/if}</p>
            <SelectControl label="TLS" options={tlsOptions} value={form.tlsMode} onchange={(value) => { if (form) form.tlsMode = value as TlsMode; }} {theme} />
            {#if form.tlsMode === 'verify-full'}
              <div class="settings-field"><label class="settings-field-label" for={instanceId + '-ca'}>CA file</label><div class="database-file"><input id={instanceId + '-ca'} bind:value={form.caFile} placeholder="Optional PEM file" spellcheck="false" /><button type="button" onclick={() => void choose('caFile')}>Choose…</button></div></div>
            {/if}
            <p class="settings-help">{form.tlsMode === 'disable' ? 'The password and data travel unencrypted. Use only on this computer or a trusted network.' : form.tlsMode === 'prefer' ? 'Encrypts when the server offers it and does not check its certificate. Fine for localhost; use Require or Verify full across a network.' : form.tlsMode === 'require' ? 'Always encrypts, without checking the server’s certificate.' : 'Always encrypts and checks the certificate and host name, against the CA file or the public certificate authorities.'}</p>
          {/if}
          <NumberControl label="Row limit" bind:value={form.rowLimit} min={1} max={list?.maxRowLimit ?? 10000} step={100} sliderStep={1} defaultValue={1000} unit="rows" />
          <NumberControl label="Timeout" bind:value={form.timeoutSeconds} min={1} max={list?.maxTimeoutSeconds ?? 600} step={5} sliderStep={1} defaultValue={30} unit="s" />
        </div>
        {#if formError}<div class="script-error" role="alert">{formError}</div>{/if}
        {#if testMessage}<p class="panel-status" role="status">{testMessage}</p>{/if}
        <div class="database-form-actions">
          <button type="submit" class="database-primary" disabled={saving || testing}>{saving ? 'Saving…' : 'Save connection'}</button>
          <button type="button" disabled={saving || testing} onclick={() => void test()}>{testing ? 'Testing…' : 'Test connection'}</button>
          <button type="button" disabled={saving} onclick={closeForm}>Cancel</button>
        </div>
      </form>
    {/if}

    <details class="database-help">
      <summary>How SQL blocks stay read-only, and where passwords go</summary>
      <p><strong>Read-only.</strong> SQLite files are opened read-only. Postgres and MySQL queries run in a read-only transaction that is always rolled back, one statement at a time, with the row limit and timeout above. A query runs only when you press Run; opening, previewing or exporting a note never runs one.</p>
      <p><strong>Still connect with a read-only database role.</strong> A read-only transaction stops changes to tables, but a role with broader rights can still call server functions that have side effects (ending other sessions, reading server files, taking locks). Create a role that can only <code>SELECT</code> what you need and use it here.</p>
      <p><strong>Passwords.</strong> On Linux they are stored through the Secret Service (GNOME Keyring, KWallet or KeePassXC); if the keyring is locked your desktop asks you to unlock it when a query needs the password. On macOS they are stored in your login Keychain. They are never written to notes, settings, recovery drafts, logs or exports, and Notation never shows a stored password. Deleting a connection deletes its entry. Without a keychain, “Ask every session” keeps the password in memory only.</p>
    </details>
  </div>
{/if}
