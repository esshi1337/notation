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
import { cellCut, cellKind, cellText, formatRows, resultCaption, sortedRows, sqlParameters, toCsv, toMarkdownTable, truncationNotice } from './sql-format';
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
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
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

// Blocks whose query is shown. The query is in the source, so it is hidden
// by default; the choice lasts for the session.
const shownQueries = new Set<string>();
const EASE = 'cubic-bezier(.2, .8, .2, 1)';

function icon(paths: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  // Fixed markup from this file, never data.
  svg.innerHTML = paths;
  return svg;
}
const ICONS = {
  play: '<path d="M5 3.5v9l7-4.5Z" fill="currentColor" stroke="none"/>',
  again: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/>',
  more: '<circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none"/>',
};

/**
 * A SQL block in Preview and Live Preview. The result table is the content:
 * before a run there is one line with Run; after it, the table and one quiet
 * caption line whose actions appear on hover or focus.
 */
export function renderSqlBlock(target: HTMLElement, block: { connection: string; sql: string }, context: SqlBlockContext): () => void {
  const key = sqlKey(context.scope, block.connection, block.sql);
  const desktop = isTauri(), shortcut = isMac ? '⌘↩' : 'Ctrl+Enter';
  target.classList.toggle('sql-block-compact', !!context.compact);
  target.setAttribute('role', 'region'); target.setAttribute('aria-label', 'SQL query: ' + block.connection);
  const query = target.querySelector<HTMLElement>(':scope > pre');
  const body = element('div', 'sql-body'), line = element('div', 'sql-line');
  target.append(body, line);

  let timer: ReturnType<typeof setInterval> | undefined, alive = true, drawnBody = '', drawnLine = '', canRun = false;
  let closeMenu: (() => void) | undefined;
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = undefined; } };
  const start = () => { if (alive && context.current() && canRun) void runSql(context.scope, block.connection, block.sql, sqlParameters(block.sql, context.variables)); };

  const control = <T extends HTMLElement>(node: T, name: string, handler: () => void): T => {
    node.dataset.sqlControl = name;
    node.addEventListener('click', (event) => { event.stopPropagation(); if (context.current()) handler(); });
    return node;
  };
  const runButton = (text: string) => {
    const button = element('button', 'sql-run'); button.type = 'button';
    button.append(icon(ICONS.play), element('span', '', text), element('span', 'sql-run-target', ' · ' + block.connection));
    button.setAttribute('aria-label', 'Run query: ' + block.connection); button.title = `Run this query (${shortcut})`;
    return control(button, 'run', start);
  };
  const link = (text: string, name: string, handler: () => void) => { const button = element('button', 'sql-link', text); button.type = 'button'; return control(button, name, handler); };
  const toggleQuery = () => { if (shownQueries.has(key)) shownQueries.delete(key); else shownQueries.add(key); update(); };
  const queryLabel = () => shownQueries.has(key) ? 'Hide query' : 'Show query';
  // Under a fence that is being edited the query is right above: no toggle.
  const queryToggle = () => { if (context.compact || !query) return []; const button = link(queryLabel(), 'query', toggleQuery); button.setAttribute('aria-expanded', String(shownQueries.has(key))); return [button]; };
  const message = (className: string, role: string, text: string) => { const node = element('span', className, text); node.setAttribute('role', role); return node; };

  const tools = (result: SqlResult, say: (text: string) => void) => {
    const box = element('div', 'sql-tools');
    const again = element('button', 'sql-icon'); again.type = 'button'; again.append(icon(ICONS.again));
    again.setAttribute('aria-label', 'Run query: ' + block.connection); again.title = `Run again (${shortcut})`;
    const more = element('button', 'sql-icon'); more.type = 'button'; more.append(icon(ICONS.more));
    more.setAttribute('aria-label', 'More actions: ' + block.connection); more.title = 'More actions'; more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
    const act = (handler: () => Promise<void> | void) => () => { Promise.resolve().then(handler).catch((cause) => say(sqlFailure(cause).message)); };
    const entries: [string, () => void][] = [];
    if (result.columns.length) {
      entries.push(['Copy CSV', act(async () => {
        if (!navigator.clipboard?.writeText) throw new Error('The clipboard is unavailable.');
        await navigator.clipboard.writeText(toCsv(result)); say('Copied as CSV.');
      })]);
      if (desktop) entries.push(['Export CSV', act(async () => {
        const path = await save({ defaultPath: block.connection + '-results.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
        if (!path) return;
        await invoke('write_export_file', { path, content: toCsv(result) });
        say('Exported ' + (path.split(/[\\/]/u).pop() || 'results.csv') + '.');
      })]);
      if (context.insert) entries.push(['Insert as table', () => say(context.insert!(toMarkdownTable(result)) ? 'Inserted below the query. Undo removes it.' : 'The note changed; the table was not inserted.')]);
    }
    if (!context.compact && query) entries.push([queryLabel(), toggleQuery]);
    // The same menu surface and keys as the app's other menus.
    let menu: HTMLElement | undefined;
    const outside = (event: PointerEvent) => { if (menu && !box.contains(event.target as Node)) close(false); };
    function close(refocus: boolean) {
      if (!menu) return;
      menu.remove(); menu = undefined; closeMenu = undefined;
      more.setAttribute('aria-expanded', 'false'); box.classList.remove('sql-tools-open');
      document.removeEventListener('pointerdown', outside, true);
      if (refocus) more.focus();
    }
    const open = (viaPointer: boolean) => {
      const list = menu = element('div', 'compact-menu sql-menu'); list.setAttribute('role', 'menu'); list.setAttribute('aria-label', 'Result actions'); list.tabIndex = -1;
      for (const [label, handler] of entries) {
        const item = element('button'); item.type = 'button'; item.setAttribute('role', 'menuitem'); item.append(element('span', 'menu-item-label', label));
        item.addEventListener('click', (event) => { event.stopPropagation(); close(true); if (context.current()) handler(); });
        list.append(item);
      }
      list.addEventListener('keydown', (event) => {
        const items = [...list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')], at = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); items[at < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
        else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); items[event.key === 'Home' ? 0 : items.length - 1]?.focus(); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === 'Tab') close(true);
      });
      list.addEventListener('click', (event) => event.stopPropagation());
      box.append(list); box.classList.add('sql-tools-open'); more.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', outside, true); closeMenu = () => close(false);
      const duration = motionMs('base');
      if (duration) list.animate([{ opacity: 0, transform: 'translateY(4px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration, easing: EASE });
      (viaPointer ? list : list.querySelector<HTMLElement>('[role="menuitem"]') ?? list).focus();
    };
    control(again, 'run', start);
    more.dataset.sqlControl = 'more';
    more.addEventListener('click', (event) => { event.stopPropagation(); if (menu) close(true); else if (context.current()) open(event.detail > 0); });
    box.append(again, more);
    return box;
  };

  const update = () => {
    if (!alive) return;
    if (!target.isConnected && drawnLine) { cleanup(); return; }
    const state = sqlState(key), known = knownConnection(block.connection), listed = connectionsLoaded();
    const missing = desktop && listed && !known, running = state?.status === 'running';
    canRun = desktop && !missing && !running;
    const showQuery = shownQueries.has(key) && !context.compact;
    if (query) query.hidden = !showQuery;
    target.dataset.state = state?.status ?? 'idle';

    // The table: rebuilt only for a new result or sort order, so toggling the query keeps its scroll position.
    const result = state?.status === 'done' ? state.result : undefined;
    const bodySignature = result ? [result.finishedAt, JSON.stringify(sorts.get(key) ?? null)].join('|') : '';
    if (bodySignature !== drawnBody) {
      const fresh = !!result && !!drawnLine && !drawnBody;
      drawnBody = bodySignature;
      body.replaceChildren(...(result?.columns.length ? [table(result, key, update)] : []));
      // A new result settles in; Live Preview widgets are never animated.
      const duration = fresh && !context.measure ? motionMs('base') : 0;
      if (duration) body.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: EASE });
    }

    const lineSignature = [desktop, missing, showQuery, known?.kind, state?.status, running ? state.cancelling : '', result ? result.finishedAt : state?.status === 'error' ? state.code + state.message : ''].join('|');
    if (lineSignature !== drawnLine) {
      drawnLine = lineSignature;
      // Keep keyboard focus on the control that was used.
      const focused = line.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.sqlControl : undefined;
      closeMenu?.(); stopTimer(); line.replaceChildren();
      if (!desktop) line.append(message('sql-status', 'status', DESKTOP_ONLY), ...queryToggle());
      else if (missing) line.append(message('sql-error', 'alert', `No connection named ${block.connection} — add it in Settings → Databases.`), ...queryToggle());
      else if (!state) line.append(runButton('Run query'), ...queryToggle());
      else if (state.status === 'running') {
        const text = message('sql-status', 'status', '');
        const tick = () => { const seconds = Math.floor((Date.now() - state.startedAt) / 1000); text.textContent = `${state.cancelling ? 'Cancelling on the server…' : seconds ? `Running… ${seconds} s` : 'Running…'} · ${block.connection}`; };
        tick(); timer = setInterval(tick, 1000);
        const cancel = element('button', 'sql-link sql-cancel', state.cancelling ? 'Cancelling…' : 'Cancel'); cancel.type = 'button'; cancel.disabled = !!state.cancelling;
        cancel.setAttribute('aria-label', 'Cancel query: ' + block.connection);
        const spinner = element('span', 'sql-spinner'); spinner.setAttribute('aria-hidden', 'true');
        line.append(spinner, text, control(cancel, 'cancel', () => void cancelSql(key)));
      } else if (state.status === 'error') {
        if (state.code === 'cancelled') line.append(runButton('Run query'), ...queryToggle(), message('sql-status', 'status', 'Query cancelled.'));
        else {
          const text = state.code === 'password_required' ? `${block.connection} asks for its password once per session. Enter it in Settings → Databases, then run again.` : state.message;
          const retry = link('Retry', 'run', start); retry.classList.add('sql-retry'); retry.setAttribute('aria-label', 'Run query: ' + block.connection); retry.title = `Run again (${shortcut})`;
          line.append(message(state.code === 'password_required' ? 'sql-status' : 'sql-error', state.code === 'password_required' ? 'status' : 'alert', text), ...queryToggle(), retry);
        }
      } else {
        const done = state.result;
        const caption = element('span', 'sql-caption', resultCaption(done, clock(done.finishedAt)));
        const notice = truncationNotice(done);
        if (notice) caption.title = notice;
        const note = message('sql-note', 'status', '');
        line.append(caption, note, tools(done, (text) => { note.textContent = text; }));
      }
      if (focused) (line.querySelector<HTMLElement>(`[data-sql-control="${focused}"]`) ?? line.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
    }
    context.measure?.();
  };

  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    event.preventDefault(); event.stopPropagation(); start();
  };
  target.addEventListener('keydown', keydown);
  const unsubscribe = subscribeSql(key, update), unlisten = subscribeConnections(update);
  function cleanup() { if (!alive) return; alive = false; closeMenu?.(); stopTimer(); unsubscribe(); unlisten(); target.removeEventListener('keydown', keydown); }
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
