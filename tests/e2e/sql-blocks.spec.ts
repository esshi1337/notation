import { expect, test, type Page } from '@playwright/test';
import { openSettings, runCommand } from './commands';

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
      calls: [] as Call[], mode: 'ok' as 'ok' | 'hang' | 'error' | 'locked' | 'truncated' | 'wide', unlocked: false, confirm: true,
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
        // The native confirmation for the first run from a note.
        if (cmd === 'plugin:dialog|message') return state.confirm ? 'Allow and run' : 'Cancel';
        if (cmd === 'read_document_snapshot') return { path: args.path, content };
        if (cmd === 'plugin:dialog|save') return '/exports/report.html';
        if (cmd === 'write_export_file') return { path: args.path, content: args.content };
        if (cmd === 'sql_list_connections') return { connections: connections.map((item: Record<string, unknown>) => state.unlocked && item.passwordStorage === 'session' ? { ...item, passwordState: 'session' } : item), keychainAvailable: true, keychainReason: null, maxRowLimit: 10000, maxTimeoutSeconds: 600 };
        if (cmd === 'sql_unlock_connection') { state.unlocked = true; return null; }
        if (cmd === 'sql_cancel') { const run = state.pending.find(item => item.id === args.id); run?.reject({ code: 'cancelled', message: 'Query cancelled.' }); return !!run; }
        if (cmd === 'sql_run') {
          if (state.mode === 'hang') return new Promise((_, reject) => state.pending.push({ id: args.request.id, reject }));
          if (state.mode === 'error') return Promise.reject({ code: 'query', message: 'Postgres ERROR: relation "customers" does not exist [42P01]' });
          if (state.mode === 'locked' && !state.unlocked) return Promise.reject({ code: 'password_required', message: 'Enter the password for analytics to use it in this session.' });
          if (state.mode === 'truncated') return { ...result, rowCount: 1000, truncated: 'rows' };
          if (state.mode === 'wide') { const extra = Array.from({ length: 12 }, (_, index) => ({ name: 'measurement_' + index, typeName: 'text' })); return { ...result, columns: [...result.columns, ...extra], rows: result.rows.map((row: unknown[]) => [...row, ...extra.map((_, index) => 'value ' + index)]) }; }
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
/** The cells of the first table in an exported page, parsed without running or loading anything. */
class ExportedTable {
  rows: string[][];
  constructor(html: string) {
    const table = /<table class="sql-snapshot">([\s\S]*?)<\/table>/u.exec(html)?.[1] ?? '';
    const decode = (text: string) => text.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&amp;/gu, '&');
    this.rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/gu)].map(row => [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gu)].map(cell => decode(cell[1])));
  }
}
const editorText = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.editor-tab-host:not([hidden]) .cm-line')].map(line => line.textContent).join('\n'));

test('rendering a note runs nothing; Run shows a sortable text-only table', async ({ page }) => {
  await desktop(page);
  const sql = block(page);
  // Before a run: one compact line. The query is in the source, so it is hidden until asked for.
  await expect(sql.getByRole('button', { name: 'Run query: analytics' })).toHaveText('Run query · analytics');
  await expect(sql.locator('pre')).toBeHidden();
  await expect(sql.locator('table')).toHaveCount(0);
  await sql.getByRole('button', { name: 'Show query' }).click();
  await expect(sql.locator('pre')).toContainText('select id, name, note from customers where id >= :min_id');
  await expect(sql.getByRole('button', { name: 'Hide query' })).toBeFocused();
  await sql.getByRole('button', { name: 'Hide query' }).click();
  await expect(sql.locator('pre')).toBeHidden();
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
  // The first run from this note was confirmed once, in a native dialog that names the connection and shows the query.
  const asked = await calls(page, 'plugin:dialog|message');
  expect(asked).toHaveLength(1);
  expect(asked[0].args.message).toContain('Run this query on analytics (Postgres, reader@db.example.test:5432/app)?');
  expect(asked[0].args.message).toContain('select id, name, note from customers where id >= :min_id');
  expect(asked[0].args.message).toContain('read-only');
  // After a run: the table and one caption line; no card, no query, no toolbar.
  await expect(sql.locator('.sql-caption')).toHaveText(/^analytics · 3 rows · 38 ms · \d\d:\d\d$/u);
  await expect(sql.locator('pre')).toBeHidden();
  await expect(sql).toHaveCSS('border-top-width', '0px');
  await expect(sql.getByRole('button', { name: 'Run query: analytics' })).toHaveAttribute('title', /^Run again/u);

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
  // No database value or column name is in an attribute, where note CSS could select on it.
  const attributes = await sql.evaluate((element) => [...element.querySelectorAll('.sql-body *, .sql-line *')].flatMap(node => [...node.attributes].map(attribute => attribute.value)).join('\n'));
  for (const value of ['Linus', 'Grace', 'onerror', 'example.test', 'int4']) expect(attributes.split('\n')).not.toContainEqual(expect.stringContaining(value));
  // Running again asks nothing more for this note and connection.
  await sql.getByRole('button', { name: 'Run query: analytics' }).click();
  await expect.poll(async () => (await calls(page, 'sql_run')).length).toBe(2);
  expect(await calls(page, 'plugin:dialog|message')).toHaveLength(1);

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
  // While running the line is a spinner, the elapsed time and Cancel; there is nothing to press twice.
  await expect(sql.getByRole('button', { name: 'Run query: analytics' })).toHaveCount(0);
  await expect(sql.getByRole('status')).toContainText('Running…');
  await expect(sql.locator('.sql-spinner')).toBeVisible();
  const cancel = sql.getByRole('button', { name: 'Cancel query: analytics' });
  await expect(cancel).toBeVisible();
  // A second press while running starts nothing.
  await cancel.press('Control+Enter');
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
  await expect(sql.getByRole('button', { name: 'Show query' })).toBeVisible();
  await expect(sql.getByRole('button', { name: 'Run query: analytics' })).toHaveText('Retry');
  await mode(page, 'truncated');
  await sql.getByRole('button', { name: 'Run query: analytics' }).click();
  await expect(sql.locator('.sql-caption')).toHaveText(/ · first 1,000 rows$/u);
  await expect(sql.locator('.sql-caption')).toHaveAttribute('title', 'Showing the first 1,000 rows: the connection\'s row limit. The query returned more.');
  await expect(sql.getByRole('alert')).toHaveCount(0);
});

test('an unknown connection is named, with nothing to run', async ({ page }) => {
  await desktop(page, { connections: [] });
  const sql = block(page);
  await expect(sql.getByRole('alert')).toHaveText('No connection named analytics — add it in Settings → Databases.');
  await expect(sql.getByRole('button', { name: 'Run query: analytics' })).toHaveCount(0);
  await expect(sql.getByRole('button', { name: 'Show query' })).toBeVisible();
  await sql.press('Control+Enter');
  expect(await calls(page, 'sql_run')).toHaveLength(0);
});

test('a declined confirmation runs nothing, and note HTML cannot restyle or relabel the Run button', async ({ page }) => {
  // A note from someone else tries to stretch Run over the window and to trigger it from its own label.
  await desktop(page, { content: '<style>.sql-run{position:fixed;inset:0;opacity:0}</style>\n\n<div style="position:fixed;inset:0;pointer-events:none">Click anywhere to continue</div>\n\n<label for="run">Continue</label>\n\n```sql connection:analytics\nselect * from customers\n```\n' });
  const sql = block(page), run = sql.getByRole('button', { name: 'Run query: analytics' });
  await expect(run).toBeVisible();
  const preview = page.getByRole('region', { name: 'Document preview' });
  expect(await preview.locator('style, [style*="fixed"]').count()).toBe(0);
  await expect(run).toHaveCSS('position', 'static');
  await expect(run).toHaveCSS('opacity', '1');
  expect(await run.getAttribute('id')).toBeNull();
  await preview.getByText('Continue', { exact: true }).click();
  expect(await calls(page, 'plugin:dialog|message')).toHaveLength(0);
  // Even a real click on Run starts nothing until the native dialog is accepted.
  await page.evaluate(() => { (window as unknown as { sqlMock: { confirm: boolean } }).sqlMock.confirm = false; });
  await run.click();
  await expect.poll(async () => (await calls(page, 'plugin:dialog|message')).length).toBe(1);
  await run.click();
  await expect.poll(async () => (await calls(page, 'plugin:dialog|message')).length).toBe(2);
  expect(await calls(page, 'sql_run')).toHaveLength(0);
  await expect(sql.locator('table')).toHaveCount(0);
  await expect(run).toHaveText('Run query · analytics');
});

test('an ask-every-session password is entered in Settings, never in the note', async ({ page }) => {
  await desktop(page, { connections: [{ ...analytics, passwordStorage: 'session', passwordState: 'needed' }] });
  await mode(page, 'locked');
  const sql = block(page);
  await sql.getByRole('button', { name: 'Run query: analytics' }).click();
  await expect(sql.getByRole('status')).toHaveText('analytics asks for its password once per session. Enter it in Settings → Databases, then run again.');
  await expect(sql.locator('input')).toHaveCount(0);
  await openSettings(page);
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Databases', exact: true }).click();
  const row = settings.locator('[data-connection="analytics"]');
  await expect(row).toContainText('asked every session');
  await row.getByRole('button', { name: 'Enter password: analytics' }).click();
  const field = row.locator('input[aria-label="Password for analytics"]');
  await expect(field).toHaveAttribute('type', 'password');
  await expect(field).toBeFocused();
  await field.fill(PASSWORD);
  await field.press('Enter');
  await expect(row).toContainText('entered for this session');
  await expect(row.locator('input')).toHaveCount(0);
  expect((await calls(page, 'sql_unlock_connection')).map(call => call.args)).toEqual([{ name: 'analytics', password: PASSWORD }]);
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await sql.getByRole('button', { name: 'Run query: analytics' }).click();
  await expect(sql.locator('tbody tr')).toHaveCount(3);
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
  await sql.getByRole('button', { name: 'More actions: analytics' }).click();
  await sql.getByRole('menuitem', { name: 'Copy CSV' }).click();
  await expect(sql.locator('.sql-note')).toHaveText('Copied as CSV.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('id,name,note\r\n3,Linus,"<img src=x onerror=""window.sqlXss=1"">"\r\n1,Ada,\r\n2,Grace,**bold** [link](http://example.test) <script>window.sqlXss=2</script>\r\n');

  const before = await editorText(page);
  await sql.getByRole('button', { name: 'More actions: analytics' }).click();
  await sql.getByRole('menuitem', { name: 'Insert as table' }).click();
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
  await sql.locator('.sql-caption').dblclick();
  await expect(page.locator('.cm-content')).toContainText('```sql connection:analytics');
  await expect(block(page).locator('tbody tr')).toHaveCount(3);
  await expect(block(page).locator('pre')).toBeHidden();
  // Editing the query starts fresh; Ctrl+Enter runs the edited text.
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.type(' limit 5');
  await expect(block(page).locator('table')).toHaveCount(0);
  await expect(block(page).getByRole('button', { name: 'Run query: analytics' })).toHaveText('Run query · analytics');
  // Under the fence being edited the query is right above, so there is no toggle for it.
  await expect(block(page).getByRole('button', { name: 'Show query' })).toHaveCount(0);
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
  await expect(sql.getByRole('button', { name: 'Run query: analytics' })).toHaveCount(0);
  // A plain sql fence stays an ordinary code block.
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('```sql\nselect 1\n```\n');
  await expect(page.getByRole('region', { name: 'Document preview' }).locator('pre')).toContainText('select 1');
  await expect(page.getByRole('region', { name: /^SQL query/u })).toHaveCount(0);
});

const TWO_BLOCKS = '# Report\n\n```sql connection:analytics\nselect id, name, note from customers\n```\n\nNot run:\n\n```sql connection:analytics\nselect count(*) from orders\n```\n';
async function exportHtml(page: Page) {
  const panel = page.getByRole('region', { name: 'Export', exact: true });
  if (!await panel.isVisible()) await runCommand(page, 'Export');
  await panel.getByRole('combobox', { name: 'Export format' }).selectOption('self-contained');
  const before = (await calls(page, 'write_export_file')).length;
  await panel.getByRole('button', { name: 'Export document', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'write_export_file')).length).toBe(before + 1);
  return String((await calls(page, 'write_export_file')).at(-1)!.args.content);
}

test('an export carries the session result as a captioned table, the SQL of blocks not run, and no connection details', async ({ page }) => {
  await desktop(page, { content: TWO_BLOCKS });
  // Before anything is run, both blocks export as their SQL.
  const unrun = await exportHtml(page);
  expect(unrun).toContain('select id, name, note from customers');
  expect(unrun).toContain('select count(*) from orders');
  expect(unrun).not.toContain('Results from');
  expect(await calls(page, 'sql_run')).toHaveLength(0);

  const first = page.getByRole('region', { name: 'SQL query: analytics', exact: true }).first();
  await first.getByRole('button', { name: 'Run query: analytics' }).click();
  await expect(first.locator('tbody tr')).toHaveCount(3);
  // The export follows the order on screen.
  await first.getByRole('button', { name: 'Sort by id' }).click();
  const html = await exportHtml(page);
  expect(await calls(page, 'sql_run')).toHaveLength(1);
  const exported = new ExportedTable(html);
  expect(html).toMatch(/<caption>Results from analytics at \d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/caption>/u);
  expect(exported.rows).toEqual([['id', 'name', 'note'], ['1', 'Ada', 'NULL'], ['2', 'Grace', '**bold** [link](http://example.test) <script>window.sqlXss=2</script>'], ['3', 'Linus', '<img src=x onerror="window.sqlXss=1">']]);
  // Values are escaped text in the file; the run block's SQL is replaced by its table, the other block keeps its SQL.
  expect(html).toContain('&lt;img src=x onerror="window.sqlXss=1"&gt;');
  expect(html).not.toMatch(/<img|<script/u);
  expect(html).not.toContain('select id, name, note from customers');
  expect(html).toContain('select count(*) from orders');
  // Nothing about the connection but its name, and no controls.
  for (const secret of ['db.example.test', 'reader', '5432', 'Postgres', 'Run again', 'Copy CSV', 'Not run in this session']) expect(html).not.toContain(secret);
  // An export is a plain file write: it is not saved as a document, so results are not copied into revision history.
  expect(await calls(page, 'write_document')).toHaveLength(0);
});

test('result actions stay out of the way until hover or focus, and the menu works from the keyboard', async ({ page }) => {
  await desktop(page);
  const sql = block(page), tools = sql.locator('.sql-tools');
  await sql.getByRole('button', { name: 'Run query: analytics' }).click();
  await expect(sql.locator('tbody tr')).toHaveCount(3);
  // The table reads like any preview table: same cell padding and header fill, no box around the block.
  const cell = sql.locator('tbody td').first();
  await expect(cell).toHaveCSS('padding', '7px 13px');
  await page.mouse.move(5, 5);
  await page.locator('.cm-content').click();
  await expect(tools).toHaveCSS('opacity', '0');
  await sql.locator('.sql-caption').hover();
  await expect(tools).toHaveCSS('opacity', '1');
  // Keyboard: focus alone reveals the actions; the menu opens on its first item and Escape returns to its button.
  await page.mouse.move(5, 5);
  const more = sql.getByRole('button', { name: 'More actions: analytics' });
  await more.focus();
  await expect(tools).toHaveCSS('opacity', '1');
  await expect(more).toHaveAttribute('title', 'More actions');
  await page.keyboard.press('Enter');
  const menu = sql.getByRole('menu', { name: 'Result actions' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Copy CSV', 'Export CSV', 'Insert as table', 'Show query']);
  await expect(menu.getByRole('menuitem', { name: 'Copy CSV' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: 'Show query' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  // Show query from the menu: the query appears above the table, focus stays on the menu button, the table is not rebuilt.
  await sql.locator('.sql-table-scroll').evaluate((element) => { (element as HTMLElement & { marker?: boolean }).marker = true; });
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(sql.locator('pre')).toContainText('select id, name, note from customers');
  await expect(more).toBeFocused();
  expect(await sql.locator('.sql-table-scroll').evaluate((element) => (element as HTMLElement & { marker?: boolean }).marker)).toBe(true);
  await more.click();
  await expect(sql.getByRole('menuitem', { name: 'Hide query' })).toBeVisible();
  // A click elsewhere closes the menu.
  await page.locator('.cm-content').click();
  await expect(menu).toHaveCount(0);
  expect(await calls(page, 'sql_run')).toHaveLength(1);
});

test('in a narrow split pane a wide result scrolls inside the table and the caption line stays within the pane', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 480 });
  await desktop(page);
  await page.evaluate(() => {
    const mock = (window as unknown as { sqlMock: { mode: string } }).sqlMock; mock.mode = 'wide';
  });
  const sql = block(page);
  await sql.getByRole('button', { name: 'Run query: analytics' }).click();
  await expect(sql.locator('tbody tr')).toHaveCount(3);
  const sizes = await sql.evaluate((element) => {
    const pane = element.closest('.preview-scroll')!, scroll = element.querySelector('.sql-table-scroll')!, line = element.querySelector('.sql-line')!;
    return { paneOverflow: pane.scrollWidth - pane.clientWidth, tableOverflow: scroll.scrollWidth - scroll.clientWidth, lineOverflow: line.scrollWidth - line.clientWidth, lineRight: line.getBoundingClientRect().right, paneRight: pane.getBoundingClientRect().right, toolsRight: element.querySelector('.sql-tools')!.getBoundingClientRect().right };
  });
  expect(sizes.tableOverflow).toBeGreaterThan(100);
  expect(sizes.paneOverflow).toBe(0);
  expect(sizes.lineOverflow).toBe(0);
  expect(sizes.toolsRight).toBeLessThanOrEqual(sizes.paneRight);
  await expect(sql.locator('th').first()).toHaveCSS('position', 'sticky');
});
