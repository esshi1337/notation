// The rendered SQL block: Run, Cancel, the last result of this session.
//
// Nothing here runs a query on its own. `runSql` is reached only from the
// Run button or the block's Ctrl/Cmd+Enter, and `runSql` confirms the first
// run from a note in a native dialog. Every database value is put on the
// page with textContent and never into an attribute, so note-authored CSS
// has nothing to select on. Passwords are never asked for here: a note
// could imitate such a prompt.
import { invoke, isTauri } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { motionMs } from './motion';
import { isMac } from './platform';
import { DESKTOP_ONLY, kindLabels, knownConnection, connectionsLoaded, listConnections, subscribeConnections, sqlFailure } from './sql-connections';
import { cellCut, cellKind, cellText, formatDuration, formatRows, sortedRows, sqlParameters, toCsv, toMarkdownTable, truncationNotice } from './sql-format';
import type { SqlResult } from './sql-format';
import { cancelSql, runSql, sqlKey, sqlResult, sqlState, subscribeSql } from './sql-session';

export type SqlBlockContext = {
  /** The document the block belongs to; results are kept per document. */
  scope: string;
  /** Frontmatter properties, for `:name` parameters. */
  variables: Record<string, unknown>;
  current: () => boolean;
  /** Insert Markdown after the block's fence as one undoable edit. */
  insert?: (markdown: string) => boolean;
  /** Live Preview asks for a new measure when the block's height changes. */
  measure?: () => void;
  /** Shown under a fence that is being edited: the query itself is not repeated. */
  compact?: boolean;
};

const PAGE = 200;
// Column sort per block, kept while the result is.
const sorts = new Map<string, { column: number; descending: boolean }>();
let connectionsRequested = false;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function table(result: SqlResult, key: string, redraw: () => void): HTMLElement {
  const scroll = element('div', 'sql-table-scroll');
  scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Query results');
  const grid = element('table', 'sql-table'), head = element('thead'), header = element('tr'), body = element('tbody');
  const sort = sorts.get(key) ?? null;
  for (const [index, column] of result.columns.entries()) {
    const th = element('th'); th.scope = 'col';
    const active = sort?.column === index;
    th.setAttribute('aria-sort', active ? sort!.descending ? 'descending' : 'ascending' : 'none');
    const button = element('button', 'sql-sort'); button.type = 'button';
    button.append(element('span', 'sql-hidden', 'Sort by '), element('span', 'sql-column-name', column.name || `column ${index + 1}`), element('span', 'sql-sort-mark', active ? sort!.descending ? '▼' : '▲' : ''));
    button.lastElementChild!.setAttribute('aria-hidden', 'true');
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      // Ascending, descending, then back to the order the database returned.
      if (!active) sorts.set(key, { column: index, descending: false });
      else if (!sort!.descending) sorts.set(key, { column: index, descending: true });
      else sorts.delete(key);
      redraw();
    });
    th.append(button); header.append(th);
  }
  head.append(header); grid.append(head, body);
  const order = sortedRows(result, sort);
  let shown = 0;
  const more = element('button', 'sql-more'); more.type = 'button';
  const fill = () => {
    const end = Math.min(order.length, shown + PAGE);
    for (; shown < end; shown++) {
      const tr = element('tr');
      for (const cell of result.rows[order[shown]]) {
        const td = element('td', 'sql-cell-' + cellKind(cell));
        // Text only: a value can never become markup.
        td.textContent = cellText(cell);
        if (cellCut(cell)) td.classList.add('sql-cell-cut');
        tr.append(td);
      }
      body.append(tr);
    }
    more.hidden = shown >= order.length;
    more.textContent = `Show ${Math.min(PAGE, order.length - shown)} more rows (${shown.toLocaleString('en-US')} of ${order.length.toLocaleString('en-US')} shown)`;
  };
  more.addEventListener('click', (event) => { event.stopPropagation(); fill(); });
  fill();
  scroll.append(grid);
  const wrapper = element('div', 'sql-result');
  wrapper.append(scroll, more);
  return wrapper;
}

export function renderSqlBlock(target: HTMLElement, block: { connection: string; sql: string }, context: SqlBlockContext): () => void {
  const key = sqlKey(context.scope, block.connection, block.sql);
  const desktop = isTauri();
  target.classList.toggle('sql-block-compact', !!context.compact);
  target.setAttribute('role', 'region'); target.setAttribute('aria-label', 'SQL query: ' + block.connection);
  const actions = element('div', 'sql-actions');
  const label = element('strong', '', 'SQL');
  const connection = element('span', 'sql-connection');
  const run = element('button', 'sql-run', 'Run'); run.type = 'button'; run.setAttribute('aria-label', 'Run query: ' + block.connection);
  run.title = `Run this query (${isMac ? '⌘↩' : 'Ctrl+Enter'})`;
  const cancel = element('button', 'sql-cancel', 'Cancel'); cancel.type = 'button'; cancel.setAttribute('aria-label', 'Cancel query: ' + block.connection); cancel.hidden = true;
  actions.append(label, connection, run, cancel);
  const output = element('div', 'sql-output');
  target.prepend(actions); target.append(output);

  let timer: ReturnType<typeof setInterval> | undefined, alive = true, drawn = '';
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = undefined; } };
  const start = () => { if (alive && context.current() && !run.disabled) void runSql(context.scope, block.connection, block.sql, sqlParameters(block.sql, context.variables)); };

  const status = (text: string) => { const line = element('p', 'sql-status', text); line.setAttribute('role', 'status'); return line; };
  const failure = (text: string) => { const line = element('div', 'sql-error', text); line.setAttribute('role', 'alert'); return line; };
  const toolbar = (result: SqlResult) => {
    const bar = element('div', 'sql-toolbar');
    const meta = element('span', 'sql-meta', `Ran at ${clock(result.finishedAt)} · ${formatDuration(result.durationMs)} · ${formatRows(result.rowCount)}`);
    const note = element('span', 'sql-note'); note.setAttribute('role', 'status');
    const say = (text: string) => { note.textContent = text; };
    const action = (name: string, handler: () => Promise<void> | void) => {
      const button = element('button', '', name); button.type = 'button';
      button.addEventListener('click', (event) => { event.stopPropagation(); if (!context.current()) return; Promise.resolve().then(handler).catch((cause) => say(sqlFailure(cause).message)); });
      return button;
    };
    bar.append(meta);
    if (result.columns.length) {
      bar.append(action('Copy CSV', async () => {
        if (!navigator.clipboard?.writeText) throw new Error('The clipboard is unavailable.');
        await navigator.clipboard.writeText(toCsv(result)); say('Copied as CSV.');
      }));
      if (desktop) bar.append(action('Export CSV', async () => {
        const path = await save({ defaultPath: block.connection + '-results.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
        if (!path) return;
        await invoke('write_export_file', { path, content: toCsv(result) });
        say('Exported ' + (path.split(/[\\/]/u).pop() || 'results.csv') + '.');
      }));
      if (context.insert) bar.append(action('Insert as table', () => { say(context.insert!(toMarkdownTable(result)) ? 'Inserted below the query. Undo removes it.' : 'The note changed; the table was not inserted.'); }));
    }
    bar.append(note);
    return bar;
  };
  const update = () => {
    if (!alive) return;
    if (!target.isConnected && drawn) { cleanup(); return; }
    const state = sqlState(key), known = knownConnection(block.connection), listed = connectionsLoaded();
    const missing = desktop && listed && !known;
    connection.textContent = known ? `${block.connection} · ${kindLabels[known.kind]}` : block.connection;
    const running = state?.status === 'running';
    run.disabled = !desktop || missing || running;
    run.textContent = running ? 'Running…' : state?.status === 'done' ? 'Run again' : 'Run';
    cancel.hidden = !running; cancel.disabled = running && !!state.cancelling;
    cancel.textContent = running && state.cancelling ? 'Cancelling…' : 'Cancel';
    // Redraw the output only when what it shows changed.
    const signature = [desktop, missing, state?.status, state?.status === 'running' ? state.cancelling : '', state?.status === 'done' ? state.result.finishedAt : state?.status === 'error' ? state.code + state.message : '', JSON.stringify(sorts.get(key) ?? null)].join('|');
    if (signature === drawn) return;
    const first = !drawn; drawn = signature;
    stopTimer(); output.replaceChildren();
    if (!desktop) output.append(status(DESKTOP_ONLY));
    else if (missing) output.append(failure(`No connection named ${block.connection} — add it in Settings → Databases.`));
    else if (!state) output.append(status(`Not run in this session. Press Run${context.compact ? ` or ${isMac ? '⌘↩' : 'Ctrl+Enter'}` : ''}; results are kept until you quit.`));
    else if (state.status === 'running') {
      const line = status('');
      const tick = () => { const seconds = Math.floor((Date.now() - state.startedAt) / 1000); line.textContent = state.cancelling ? 'Cancelling on the server…' : seconds ? `Running… ${seconds} s` : 'Running…'; };
      tick(); timer = setInterval(tick, 1000); output.append(line);
    } else if (state.status === 'error') {
      if (state.code === 'password_required') output.append(status(`${block.connection} asks for its password once per session. Enter it in Settings → Databases, then run again.`));
      else if (state.code === 'cancelled') output.append(status('Query cancelled.'));
      else output.append(failure(state.message));
    } else {
      const result = state.result, notice = truncationNotice(result);
      output.append(toolbar(result));
      if (notice) output.append(status(notice));
      if (!result.columns.length) output.append(status('The statement returned no columns.'));
      else if (!result.rows.length) output.append(table(result, key, update), status('No rows.'));
      else output.append(table(result, key, update));
      // Results settle in; Live Preview widgets are never animated.
      const duration = context.measure || first ? 0 : motionMs('base');
      if (duration) output.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }
    context.measure?.();
  };

  run.addEventListener('click', (event) => { event.stopPropagation(); start(); });
  cancel.addEventListener('click', (event) => { event.stopPropagation(); void cancelSql(key); });
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    event.preventDefault(); event.stopPropagation(); start();
  };
  target.addEventListener('keydown', keydown);
  const unsubscribe = subscribeSql(key, update), unlisten = subscribeConnections(update);
  function cleanup() { if (!alive) return; alive = false; stopTimer(); unsubscribe(); unlisten(); target.removeEventListener('keydown', keydown); }
  // Knowing the connection names is local metadata; it runs no query and reads no password.
  if (desktop && !connectionsLoaded() && !connectionsRequested) { connectionsRequested = true; void listConnections().catch(() => { connectionsRequested = false; }); }
  update();
  return cleanup;
}

/** Run the block at a source position, for the editor's Ctrl/Cmd+Enter. */
export function runSqlBlock(scope: string, block: { connection: string; sql: string }, variables: Record<string, unknown>) {
  void runSql(scope, block.connection, block.sql, sqlParameters(block.sql, variables));
}

export const EXPORT_ROWS = 1000;
function stamp(timestamp: number): string {
  const date = new Date(timestamp), two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
/**
 * For an export: replace a block with the result it produced in this
 * session, as a static table captioned with the connection's name and the
 * time. Nothing is run, and nothing about the connection but its name is
 * written. Returns false when the block was not run, leaving its SQL.
 */
export function renderSqlSnapshot(target: HTMLElement, block: { connection: string; sql: string }, scope: string): boolean {
  const result = sqlResult(scope, block.connection, block.sql);
  if (!result || !result.columns.length) return false;
  const order = sortedRows(result, sorts.get(sqlKey(scope, block.connection, block.sql)) ?? null).slice(0, EXPORT_ROWS);
  const numeric = result.columns.map((_, index) => result.rows.some((row) => row[index] !== null) && result.rows.every((row) => row[index] === null || cellKind(row[index]) === 'number'));
  const grid = element('table', 'sql-snapshot'), head = element('thead'), header = element('tr'), body = element('tbody');
  grid.append(element('caption', '', `Results from ${block.connection} at ${stamp(result.finishedAt)}`));
  for (const [index, column] of result.columns.entries()) { const th = element('th', '', column.name || ' '); if (numeric[index]) th.setAttribute('align', 'right'); header.append(th); }
  head.append(header); grid.append(head, body);
  for (const index of order) {
    const tr = element('tr');
    for (const [column, cell] of result.rows[index].entries()) {
      const td = element('td', cell === null ? 'sql-null' : '');
      td.textContent = cellText(cell);
      if (numeric[column]) td.setAttribute('align', 'right');
      tr.append(td);
    }
    body.append(tr);
  }
  const figure = element('div', 'sql-export');
  figure.append(grid);
  const notes = [order.length < result.rows.length ? `The first ${formatRows(order.length)} of ${formatRows(result.rows.length)} are included.` : '', truncationNotice(result).replace(/^Showing the first/u, 'The query was cut at the first')].filter(Boolean);
  if (notes.length) figure.append(element('p', 'sql-export-note', notes.join(' ')));
  target.replaceWith(figure);
  return true;
}
