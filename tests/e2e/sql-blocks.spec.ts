import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'dummy-Pa55word-7f3a91-do-not-leak';
const NOTE = '---\nmin_id: 2\nlabel: "x\' or 1=1 --"\n---\n# Report\n\n```sql connection:analytics\nselect id, name, note from customers where id >= :min_id\n```\n\nAfter.\n';
type Call = { cmd: string; args: Record<string, any> };
type Options = { layout?: 'split' | 'live' | 'source' | 'preview'; content?: string; connections?: Record<string, unknown>[] };

const analytics = { name: 'analytics', kind: 'postgres', path: '', host: 'db.example.test', port: 5432, database: 'app', user: 'reader', tlsMode: 'require', caFile: '', rowLimit: 1000, timeoutSeconds: 30, passwordStorage: 'keychain', passwordState: 'keychain' };
const rows = [
  [3, 'Linus', '<img src=x onerror="window.sqlXss=1">'],
  [1, 'Ada', null],
  [2, 'Grace', '**bold** [link](http://example.test) <script>window.sqlXss=2</script>'],
];
const result = { connection: 'analytics', kind: 'postgres', columns: [{ name: 'id', typeName: 'int4' }, { name: 'name', typeName: 'text' }, { name: 'note', typeName: 'text' }], rows, rowCount: 3, rowLimit: 1000, truncated: null, durationMs: 38, finishedAt: Date.UTC(2026, 10, 21, 13, 5, 9) };

/** A desktop backend with one note open. `mode` decides what `sql_run` does. */
async function desktop(page: Page, options: Options = {}) {
  await page.addInitScript(({ content, layout, connections, result }) => {
    const state = {
      calls: [] as Call[], mode: 'ok' as 'ok' | 'hang' | 'error' | 'locked' | 'truncated', unlocked: false,
      pending: [] as { id: string; reject: (error: unknown) => void }[],
    };
    const tab = { id: 'note', name: 'report.md', path: '/notes/report.md', content, savedContent: content, savedName: 'report.md', updatedAt: 1 };
    Object.assign(window, { sqlMock: state, isTauri: true, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: (path: string) => path,
      async invoke(cmd: string, args: Record<string, any> = {}) {
        state.calls.push({ cmd, args: JSON.parse(JSON.stringify(args)) });
        if (cmd === 'bootstrap_state') return { settings: { layout }, draft: null, scriptDraft: null, scripts: [], recents: [], workspace: null, workspaceCatalog: { activeId: null, workspaces: [] }, session: { activeTabId: 'note', tabs: [tab], updatedAt: 1 } };
        if (cmd === 'launch_ready') return [];
        if (cmd === 'plugin:event|listen') return 1;
        if (cmd === 'read_document_snapshot') return { path: args.path, content };
        if (cmd === 'sql_list_connections') return { connections, keychainAvailable: true, keychainReason: null, maxRowLimit: 10000, maxTimeoutSeconds: 600 };
        if (cmd === 'sql_unlock_connection') { state.unlocked = true; return null; }
        if (cmd === 'sql_cancel') { const run = state.pending.find(item => item.id === args.id); run?.reject({ code: 'cancelled', message: 'Query cancelled.' }); return !!run; }
        if (cmd === 'sql_run') {
          if (state.mode === 'hang') return new Promise((_, reject) => state.pending.push({ id: args.request.id, reject }));
          if (state.mode === 'error') return Promise.reject({ code: 'query', message: 'Postgres ERROR: relation "customers" does not exist [42P01]' });
          if (state.mode === 'locked' && !state.unlocked) return Promise.reject({ code: 'password_required', message: 'Enter the password for analytics to use it in this session.' });
          if (state.mode === 'truncated') return { ...result, rowCount: 1000, truncated: 'rows' };
          return result;
        }
        return null;
      },
    }, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} } });
  }, { content: options.content ?? NOTE, layout: options.layout ?? 'split', connections: options.connections ?? [analytics], result });
  await page.goto('/');
}
const calls = (page: Page, cmd: string) => page.evaluate((name) => (window as unknown as { sqlMock: { calls: Call[] } }).sqlMock.calls.filter(call => call.cmd === name), cmd);
const mode = (page: Page, value: string) => page.evaluate((next) => { (window as unknown as { sqlMock: { mode: string } }).sqlMock.mode = next; }, value);
const block = (page: Page) => page.getByRole('region', { name: 'SQL query: analytics', exact: true });
const editorText = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.editor-tab-host:not([hidden]) .cm-line')].map(line => line.textContent).join('\n'));

test('rendering a note runs nothing; Run shows a sortable text-only table', async ({ page }) => {
  await desktop(page);
  const sql = block(page);
  await expect(sql.getByRole('button', { name: 'Run query: analytics' })).toHaveText('Run');
  await expect(sql.locator('pre')).toContainText('select id, name, note from customers where id >= :min_id');
  await expect(sql.getByRole('status')).toContainText('Not run in this session.');
  await expect(sql.locator('.sql-connection')).toHaveText('analytics · Postgres');
  // Editing re-renders the preview several times; still no query.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End'); await page.keyboard.type('More text.');
  await expect(page.getByRole('region', { name: 'Document preview' })).toContainText('More text.');
  expect(await calls(page, 'sql_run')).toHaveLength(0);

  await sql.getByRole('button', { name: 'Run query: analytics' }).click();
  const table = sql.getByRole('region', { name: 'Query results' }).locator('table');
  await expect(table.locator('tbody tr')).toHaveCount(3);
  const runs = await calls(page, 'sql_run');
  expect(runs).toHaveLength(1);
  // The property is sent as a parameter beside the SQL, never pasted into it.
  expect(runs[0].args.request).toMatchObject({ connection: 'analytics', sql: 'select id, name, note from customers where id >= :min_id', parameters: { min_id: 2 } });
  expect(Object.keys(runs[0].args.request)).toEqual(['id', 'connection', 'sql', 'parameters']);
  await expect(sql.locator('.sql-meta')).toHaveText(/^Ran at .+ · 38 ms · 3 rows$/u);
  await expect(sql.getByRole('button', { name: 'Run query: analytics' })).toHaveText('Run again');

  // Values are text: markup in data creates no elements and runs nothing.
  await expect(table.locator('tbody tr').first().locator('td').nth(2)).toHaveText('<img src=x onerror="window.sqlXss=1">');
  await expect(table.locator('img, script, a, strong, b')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { sqlXss?: number }).sqlXss)).toBeUndefined();
  // NULL is shown as such; numbers align right; the header sticks.
  const nullCell = table.locator('tbody tr').nth(1).locator('td').nth(2);
  await expect(nullCell).toHaveText('NULL');
  await expect(nullCell).toHaveClass(/sql-cell-null/u);
  await expect(table.locator('tbody tr').first().locator('td').first()).toHaveCSS('text-align', 'right');
  await expect(table.locator('th').first()).toHaveCSS('position', 'sticky');

  // Sorting is client-side: ascending, descending, back to the returned order.
  const ids = () => table.locator('tbody tr td:first-child').allTextContents();
  expect(await ids()).toEqual(['3', '1', '2']);
  await table.getByRole('button', { name: 'Sort by id' }).click();
  expect(await ids()).toEqual(['1', '2', '3']);
  await expect(table.locator('th').first()).toHaveAttribute('aria-sort', 'ascending');
  await table.getByRole('button', { name: 'Sort by id' }).click();
  expect(await ids()).toEqual(['3', '2', '1']);
  await table.getByRole('button', { name: 'Sort by note' }).click();
  expect((await table.locator('tbody tr td:nth-child(3)').allTextContents()).at(-1)).toBe('NULL');
  await table.getByRole('button', { name: 'Sort by note' }).click();
  expect((await table.locator('tbody tr td:nth-child(3)').allTextContents()).at(-1)).toBe('NULL');
  expect(await calls(page, 'sql_run')).toHaveLength(1);

  // The result survives a re-render of the preview and is not written anywhere.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End'); await page.keyboard.type(' Again.');
  await expect(page.getByRole('region', { name: 'Document preview' })).toContainText('Again.');
  await expect(block(page).locator('tbody tr')).toHaveCount(3);
  const kept = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify((window as unknown as { sqlMock: { calls: Call[] } }).sqlMock.calls.filter(call => call.cmd === 'persist_state')));
  expect(kept).not.toContain('Linus');
  expect(await editorText(page)).not.toContain('Linus');
});

test('Cancel stops the query on the backend and says so', async ({ page }) => {
  await desktop(page);
  await mode(page, 'hang');
  const sql = block(page);
  await sql.getByRole('button', { name: 'Run query: analytics' }).click();
  await expect(sql.getByRole('button', { name: 'Run query: analytics' })).toBeDisabled();
  await expect(sql.getByRole('status')).toContainText('Running…');
  const cancel = sql.getByRole('button', { name: 'Cancel query: analytics' });
  await expect(cancel).toBeVisible();
  // A second press while running starts nothing.
  await sql.getByRole('button', { name: 'Run query: analytics' }).click({ force: true });
  await cancel.click();
  await expect(sql.getByRole('status')).toHaveText('Query cancelled.');
  await expect(cancel).toBeHidden();
  const runs = await calls(page, 'sql_run'), cancels = await calls(page, 'sql_cancel');
  expect(runs).toHaveLength(1);
  expect(cancels.map(call => call.args.id)).toEqual([runs[0].args.request.id]);
  await expect(sql.getByRole('button', { name: 'Run query: analytics' })).toBeEnabled();
});

test('database errors show inline, and a cut result says how much is shown', async ({ page }) => {
  await desktop(page);
  await mode(page, 'error');
  const sql = block(page);
  await sql.getByRole('button', { name: 'Run query: analytics' }).click();
  await expect(sql.getByRole('alert')).toHaveText('Postgres ERROR: relation "customers" does not exist [42P01]');
  await mode(page, 'truncated');
  await sql.getByRole('button', { name: 'Run query: analytics' }).click();
  await expect(sql.getByText('Showing the first 1,000 rows: the connection\'s row limit. The query returned more.')).toBeVisible();
  await expect(sql.getByRole('alert')).toHaveCount(0);
});

test('an unknown connection is named, with nothing to run', async ({ page }) => {
  await desktop(page, { connections: [] });
  const sql = block(page);
  await expect(sql.getByRole('alert')).toHaveText('No connection named analytics — add it in Settings → Databases.');
  await expect(sql.getByRole('button', { name: 'Run query: analytics' })).toBeDisabled();
  await sql.press('Control+Enter');
  expect(await calls(page, 'sql_run')).toHaveLength(0);
});

test('an ask-every-session connection takes its password inline and passes it straight to the backend', async ({ page }) => {
  await desktop(page, { connections: [{ ...analytics, passwordStorage: 'session', passwordState: 'needed' }] });
  await mode(page, 'locked');
  const sql = block(page);
  await sql.getByRole('button', { name: 'Run query: analytics' }).click();
  await expect(sql.getByRole('status')).toHaveText('Enter the password for analytics to use it in this session.');
  const field = sql.getByLabel('Password for analytics');
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill(PASSWORD);
  await field.press('Enter');
  await expect(sql.locator('tbody tr')).toHaveCount(3);
  expect((await calls(page, 'sql_unlock_connection')).map(call => call.args)).toEqual([{ name: 'analytics', password: PASSWORD }]);
  expect(await calls(page, 'sql_run')).toHaveLength(2);
  const leaks = await page.evaluate((secret) => {
    const mock = (window as unknown as { sqlMock: { calls: Call[] } }).sqlMock;
    return { dom: document.documentElement.outerHTML.includes(secret), inputs: [...document.querySelectorAll('input')].some(input => input.value.includes(secret)), storage: (JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })).includes(secret), other: JSON.stringify(mock.calls.filter(call => call.cmd !== 'sql_unlock_connection')).includes(secret) };
  }, PASSWORD);
  expect(leaks).toEqual({ dom: false, inputs: false, storage: false, other: false });
});

test('a result is inserted as an escaped Markdown table in one undoable edit, and copied as CSV', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await desktop(page);
  const sql = block(page);
  await sql.getByRole('button', { name: 'Run query: analytics' }).click();
  await expect(sql.locator('tbody tr')).toHaveCount(3);
  await sql.getByRole('button', { name: 'Copy CSV' }).click();
  await expect(sql.locator('.sql-note')).toHaveText('Copied as CSV.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('id,name,note\r\n3,Linus,"<img src=x onerror=""window.sqlXss=1"">"\r\n1,Ada,\r\n2,Grace,**bold** [link](http://example.test) <script>window.sqlXss=2</script>\r\n');

  const before = await editorText(page);
  await sql.getByRole('button', { name: 'Insert as table' }).click();
  await expect.poll(() => editorText(page)).toContain('| id | name | note |');
  const after = await editorText(page);
  expect(after).toContain('```\n\n| id | name | note |\n| ---: | --- | --- |\n| 3 | Linus | \\<img src\\=x onerror\\="window.sqlXss\\=1"\\> |\n| 1 | Ada |   |\n');
  expect(after).toContain('After.');
  // The inserted table renders as text in the preview: no image, script or link from the data.
  const preview = page.getByRole('region', { name: 'Document preview' });
  await expect(preview.getByRole('region', { name: 'Markdown table' })).toContainText('<img src=x onerror="window.sqlXss=1">');
  await expect(preview.getByRole('region', { name: 'Markdown table' }).locator('img, script, strong')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { sqlXss?: number }).sqlXss)).toBeUndefined();
  // One undo removes the whole table.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  await expect.poll(() => editorText(page)).toBe(before);
});

test('Live Preview renders the block, and Ctrl+Enter inside the fence runs it with the result below', async ({ page }) => {
  await desktop(page, { layout: 'live' });
  const sql = block(page);
  await expect(sql.getByRole('button', { name: 'Run query: analytics' })).toBeVisible();
  expect(await calls(page, 'sql_run')).toHaveLength(0);
  await sql.getByRole('button', { name: 'Run query: analytics' }).click();
  await expect(sql.locator('tbody tr')).toHaveCount(3);
  // Put the cursor in the query: the fence shows as source, the result stays below it.
  await sql.locator('pre').dblclick();
  await expect(page.locator('.cm-content')).toContainText('```sql connection:analytics');
  await expect(block(page).locator('tbody tr')).toHaveCount(3);
  await expect(block(page).locator('pre')).toBeHidden();
  // Editing the query starts fresh; Ctrl+Enter runs the edited text.
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.type(' limit 5');
  await expect(block(page).getByRole('status')).toContainText('Not run in this session.');
  await page.keyboard.press('Control+Enter');
  await expect(block(page).locator('tbody tr')).toHaveCount(3);
  const runs = await calls(page, 'sql_run');
  expect(runs).toHaveLength(2);
  expect(runs[1].args.request.sql).toBe('select id, name, note from customers where id >= :min_id limit 5');
  expect(await editorText(page)).toContain('limit 5\n```');
});

test('Source view highlights the query and its Ctrl+Enter runs only inside a SQL fence', async ({ page }) => {
  await desktop(page, { layout: 'source' });
  const keyword = page.locator('.cm-content .cm-line', { hasText: 'select id, name' }).locator('span', { hasText: /^select$/u });
  await expect(keyword).toHaveCount(1);
  await page.locator('.cm-line', { hasText: '# Report' }).click();
  await page.keyboard.press('Control+Enter');
  expect(await calls(page, 'sql_run')).toHaveLength(0);
  await page.locator('.cm-line', { hasText: 'select id, name' }).click();
  await page.keyboard.press('Control+Enter');
  await expect.poll(async () => (await calls(page, 'sql_run')).length).toBe(1);
  expect(await editorText(page)).toContain('select id, name, note from customers where id >= :min_id\n```');
});

test('the browser build says SQL blocks need the desktop app', async ({ page }) => {
  await page.goto('/');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('```sql connection:analytics\nselect 1\n```\n');
  const sql = block(page);
  await expect(sql.getByRole('status')).toHaveText('Database queries require the desktop app.');
  await expect(sql.getByRole('button', { name: 'Run query: analytics' })).toBeDisabled();
  // A plain sql fence stays an ordinary code block.
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('```sql\nselect 1\n```\n');
  await expect(page.getByRole('region', { name: 'Document preview' }).locator('pre')).toContainText('select 1');
  await expect(page.getByRole('region', { name: /^SQL query/u })).toHaveCount(0);
});
