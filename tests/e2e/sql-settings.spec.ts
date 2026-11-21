import { expect, test, type Page } from '@playwright/test';
import { openSettings, setSetting } from './commands';

const PASSWORD = 'dummy-Pa55word-7f3a91-do-not-leak';
type Call = { cmd: string; args: Record<string, unknown> };

/** A desktop backend whose keychain lives only inside this mock. */
async function desktop(page: Page, options: { keychain?: boolean; connections?: Record<string, unknown>[] } = {}) {
  await page.addInitScript(({ keychain, connections }) => {
    const state = {
      calls: [] as { cmd: string; args: Record<string, unknown> }[],
      connections: connections as Record<string, any>[],
      keychain: {} as Record<string, string>, fail: '' as string,
    };
    const fail = (code: string, message: string) => Promise.reject({ code, message });
    const view = (profile: Record<string, any>) => ({ ...profile, passwordState: profile.passwordStorage === 'session' ? 'needed' : profile.passwordStorage });
    Object.assign(window, { sqlMock: state, isTauri: true, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: (path: string) => path,
      async invoke(cmd: string, args: Record<string, any> = {}) {
        state.calls.push({ cmd, args: JSON.parse(JSON.stringify(args)) });
        if (cmd === 'bootstrap_state') return { settings: {}, draft: null, scriptDraft: null, scripts: [], recents: [], workspace: null, workspaceCatalog: { activeId: null, workspaces: [] }, session: null };
        if (cmd === 'launch_ready') return [];
        if (cmd === 'plugin:event|listen') return 1;
        if (cmd === 'sql_list_connections') return { connections: state.connections.map(view), keychainAvailable: keychain, keychainReason: keychain ? null : 'No Secret Service keychain is running (GNOME Keyring, KWallet or KeePassXC provide one).', maxRowLimit: 10000, maxTimeoutSeconds: 600 };
        if (cmd === 'sql_save_connection') {
          if (state.fail) return fail('invalid', state.fail);
          const profile = args.profile;
          if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(profile.name)) return fail('invalid', 'A connection name starts with a letter and uses letters, digits, - or _ (at most 64).');
          if (profile.passwordStorage === 'keychain') {
            if (!keychain) return fail('keychain', 'No keychain.');
            if (args.password) state.keychain[profile.name] = args.password;
            else if (args.original && state.keychain[args.original]) state.keychain[profile.name] = state.keychain[args.original];
            else return fail('invalid', 'Enter the password to store in the keychain.');
          }
          if (args.original && args.original !== profile.name) delete state.keychain[args.original];
          state.connections = [...state.connections.filter(item => item.name !== (args.original ?? profile.name)), profile].sort((a, b) => a.name.localeCompare(b.name));
          return view(profile);
        }
        if (cmd === 'sql_delete_connection') { delete state.keychain[args.name]; state.connections = state.connections.filter(item => item.name !== args.name); return null; }
        if (cmd === 'sql_test_connection') return state.fail ? fail('connect', state.fail) : { server: 'PostgreSQL 17.2', durationMs: 12 };
        return null;
      },
    }, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} } });
  }, { keychain: options.keychain ?? true, connections: options.connections ?? [] });
  await page.goto('/');
}
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
async function databases(page: Page) {
  await openSettings(page);
  await settings(page).getByRole('tab', { name: 'Databases', exact: true }).click();
  await expect(settings(page).getByRole('tabpanel', { name: 'Databases', exact: true })).toBeVisible();
}
const calls = (page: Page, cmd: string) => page.evaluate((name) => (window as unknown as { sqlMock: { calls: Call[] } }).sqlMock.calls.filter(call => call.cmd === name), cmd);
const analytics = { name: 'analytics', kind: 'postgres', path: '', host: 'db.example.test', port: 5432, database: 'app', user: 'reader', tlsMode: 'require', caFile: '', rowLimit: 1000, timeoutSeconds: 30, passwordStorage: 'keychain' };

test('the browser build explains that database queries need the desktop app', async ({ page }) => {
  await page.goto('/');
  await databases(page);
  const panel = settings(page).getByRole('tabpanel', { name: 'Databases', exact: true });
  await expect(panel.getByRole('note')).toHaveText('Database queries require the desktop app.');
  await expect(panel.getByRole('button', { name: 'Add connection' })).toHaveCount(0);
});

test('a connection is added, tested and saved; its password is sent once and never comes back', async ({ page }) => {
  await desktop(page);
  await databases(page);
  const panel = settings(page).getByRole('tabpanel', { name: 'Databases', exact: true });
  await expect(panel.getByRole('region', { name: 'Password storage' })).toContainText('Passwords are kept in the system keychain');
  await expect(panel.getByText('No connections yet.')).toBeVisible();
  await panel.getByRole('button', { name: 'Add connection' }).click();
  const form = panel.getByRole('form', { name: 'New connection' });
  await expect(form.getByLabel('Name', { exact: true })).toBeFocused();
  await form.getByLabel('Name', { exact: true }).fill('analytics');
  await expect(form.getByText('```sql connection:analytics')).toBeVisible();
  await form.getByLabel('Host', { exact: true }).fill('db.example.test');
  await form.getByLabel('Database', { exact: true }).fill('app');
  await form.getByLabel('User', { exact: true }).fill('reader');
  await expect(form.getByRole('combobox', { name: 'Password', exact: true })).toContainText('System keychain');
  const password = form.getByLabel('Password', { exact: true }).and(form.locator('input'));
  await expect(password).toHaveAttribute('type', 'password');
  await password.fill(PASSWORD);
  await setSetting(page, 'TLS', 'Require');
  await expect(form.getByText('Always encrypts, without checking the server’s certificate.')).toBeVisible();

  await form.getByRole('button', { name: 'Test connection' }).click();
  await expect(form.getByRole('status')).toHaveText('Connected to PostgreSQL 17.2 in 12 ms.');
  // Enter in a field saves the form.
  await form.getByLabel('User', { exact: true }).press('Enter');
  await expect(form).toHaveCount(0);
  const row = panel.locator('[data-connection="analytics"]');
  await expect(row).toContainText('reader@db.example.test:5432/app');
  await expect(row).toContainText('stored in keychain · 1000 rows · 30 s');
  await expect(panel.getByRole('status').filter({ hasText: 'Saved analytics.' })).toBeVisible();

  const saved = await calls(page, 'sql_save_connection');
  expect(saved).toHaveLength(1);
  expect(saved[0].args).toEqual({ profile: { ...analytics, tlsMode: 'require' }, password: PASSWORD, original: null });
  expect(JSON.stringify(saved[0].args.profile)).not.toContain(PASSWORD);

  // Nothing the page keeps or persists holds the password.
  const leaks = await page.evaluate((secret) => {
    const mock = (window as unknown as { sqlMock: { calls: Call[] } }).sqlMock;
    const stores = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    const persisted = JSON.stringify(mock.calls.filter(call => !['sql_save_connection', 'sql_test_connection'].includes(call.cmd)));
    return { stores: stores.includes(secret), persisted: persisted.includes(secret), dom: document.documentElement.outerHTML.includes(secret), inputs: [...document.querySelectorAll('input')].some(input => input.value.includes(secret)) };
  }, PASSWORD);
  expect(leaks).toEqual({ stores: false, persisted: false, dom: false, inputs: false });

  // Editing shows that a password is stored, not the password; saving
  // without typing keeps it.
  await row.getByRole('button', { name: 'Edit connection: analytics' }).click();
  const edit = panel.getByRole('form', { name: 'Edit connection' });
  const replace = edit.getByLabel('Replace password', { exact: true });
  await expect(replace).toHaveValue('');
  await expect(replace).toHaveAttribute('placeholder', 'Stored in keychain — type to replace');
  await edit.getByLabel('Name', { exact: true }).fill('warehouse');
  await edit.getByRole('button', { name: 'Save connection' }).click();
  await expect(panel.locator('[data-connection="warehouse"]')).toBeVisible();
  await expect(panel.locator('[data-connection="analytics"]')).toHaveCount(0);
  const renamed = (await calls(page, 'sql_save_connection'))[1];
  expect(renamed.args.password).toBeNull();
  expect(renamed.args.original).toBe('analytics');
  expect(await page.evaluate(() => (window as unknown as { sqlMock: { keychain: Record<string, string> } }).sqlMock.keychain)).toEqual({ warehouse: PASSWORD });
});

test('a connection is deleted only after confirming, with its stored password', async ({ page }) => {
  await desktop(page, { connections: [analytics] });
  await databases(page);
  const panel = settings(page).getByRole('tabpanel', { name: 'Databases', exact: true });
  const row = panel.locator('[data-connection="analytics"]');
  await row.getByRole('button', { name: 'Delete connection: analytics' }).click();
  await expect(row.getByText('Delete, with its stored password?')).toBeVisible();
  await row.getByRole('button', { name: 'Keep' }).click();
  expect(await calls(page, 'sql_delete_connection')).toHaveLength(0);
  await row.getByRole('button', { name: 'Delete connection: analytics' }).click();
  await row.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(panel.getByRole('status').filter({ hasText: 'Deleted analytics and its stored password.' })).toBeVisible();
  expect((await calls(page, 'sql_delete_connection')).map(call => call.args)).toEqual([{ name: 'analytics' }]);
});

test('without a keychain the reason is shown and passwords can only be asked every session', async ({ page }) => {
  await desktop(page, { keychain: false });
  await databases(page);
  const panel = settings(page).getByRole('tabpanel', { name: 'Databases', exact: true });
  const card = panel.getByRole('region', { name: 'Password storage' });
  await expect(card).toContainText('No system keychain is available');
  await expect(card).toContainText('No Secret Service keychain is running');
  await expect(card).toContainText('Passwords are not written to disk instead');
  await panel.getByRole('button', { name: 'Add connection' }).click();
  const form = panel.getByRole('form', { name: 'New connection' });
  const storage = form.getByRole('combobox', { name: 'Password', exact: true });
  await expect(storage).toContainText('Ask every session');
  await storage.click();
  await expect(page.getByRole('option', { name: /System keychain/u })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await expect(form.getByText('Kept in memory until you quit')).toBeVisible();
  await form.getByLabel('Name', { exact: true }).fill('local');
  await form.getByLabel('User', { exact: true }).fill('reader');
  await form.getByRole('button', { name: 'Save connection' }).click();
  await expect(panel.locator('[data-connection="local"]')).toContainText('asked every session');
  const saved = await calls(page, 'sql_save_connection');
  expect(saved[0].args.password).toBeNull();
  expect((saved[0].args.profile as { passwordStorage: string }).passwordStorage).toBe('session');
});

test('SQLite needs only a file, and backend errors are shown in the form', async ({ page }) => {
  await desktop(page);
  await databases(page);
  const panel = settings(page).getByRole('tabpanel', { name: 'Databases', exact: true });
  await panel.getByRole('button', { name: 'Add connection' }).click();
  const form = panel.getByRole('form', { name: 'New connection' });
  await form.getByRole('radiogroup', { name: 'Kind' }).getByRole('radio', { name: 'SQLite' }).click();
  await expect(form.getByLabel('Host', { exact: true })).toHaveCount(0);
  await expect(form.getByRole('combobox', { name: 'Password', exact: true })).toHaveCount(0);
  await expect(form.getByText('Opened read-only. A file that does not exist is never created.')).toBeVisible();
  await form.getByLabel('Name', { exact: true }).fill('bad name');
  await form.getByLabel('Database file', { exact: true }).fill('/data/shop.sqlite3');
  await form.getByRole('button', { name: 'Save connection' }).click();
  await expect(form.getByRole('alert')).toHaveText('A connection name starts with a letter and uses letters, digits, - or _ (at most 64).');
  await form.getByLabel('Name', { exact: true }).fill('shop');
  await page.evaluate(() => { (window as unknown as { sqlMock: { fail: string } }).sqlMock.fail = 'The SQLite file does not exist. It is never created from a SQL block.'; });
  await form.getByRole('button', { name: 'Test connection' }).click();
  await expect(form.getByRole('alert')).toHaveText('The SQLite file does not exist. It is never created from a SQL block.');
  await page.evaluate(() => { (window as unknown as { sqlMock: { fail: string } }).sqlMock.fail = ''; });
  await form.getByRole('button', { name: 'Save connection' }).click();
  const row = panel.locator('[data-connection="shop"]');
  await expect(row).toContainText('/data/shop.sqlite3');
  await expect(row).toContainText('opened read-only');
  expect((await calls(page, 'sql_save_connection')).at(-1)!.args.profile).toMatchObject({ kind: 'sqlite', path: '/data/shop.sqlite3', passwordStorage: 'none', host: '' });
  await panel.getByText('How SQL blocks stay read-only, and where passwords go').click();
  await expect(panel.getByText('Still connect with a read-only database role.')).toBeVisible();
});
