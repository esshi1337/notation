import { invoke, isTauri } from '@tauri-apps/api/core';
import { parseQuery, queryValue } from './database-query';
import type { QueryResult } from './database-query';
export async function renderQuery(target: HTMLElement, source: string, current: () => boolean, open?: (path: string) => void) {
  const body = document.createElement('div'), actions = document.createElement('div'); actions.className = 'query-actions';
  const label = document.createElement('strong'); label.textContent = 'Query';
  const refresh = document.createElement('button'); refresh.textContent = 'Refresh'; refresh.setAttribute('aria-label','Refresh query');
  actions.append(label, refresh); target.replaceChildren(actions,body); target.setAttribute('role','region'); target.setAttribute('aria-label','Database view');
  let serial = 0;
  const run = async () => {
    const ticket = ++serial; refresh.disabled = true; body.textContent = 'Loading…';
    try {
      const query = parseQuery(source);
      if (!isTauri()) throw new Error('Workspace queries require the desktop app.');
      const result = await invoke<QueryResult>('search_workspace_advanced', { request: query.request });
      if (!current() || ticket !== serial) return;
      body.replaceChildren();
      const summary = document.createElement('p'); summary.className = 'query-summary'; summary.textContent = `${result.results.length} of ${result.total} notes · Saved metadata`; body.append(summary);
      const link = (path: string, title: string) => { const a = document.createElement('button'); a.className = 'query-note'; a.textContent = title; a.addEventListener('click', event => { event.stopPropagation(); if (current()) open?.(path); }); return a; };
      if (query.view === 'list') {
        const list = document.createElement('ul'); for (const note of result.results) { const li = document.createElement('li'); li.append(link(note.path, note.title || note.name)); const fields = query.columns.filter(c => c !== 'title').map(c => queryValue(note,c)).filter(Boolean); if (fields.length) li.append(document.createTextNode(' · ' + fields.join(' · '))); list.append(li); } body.append(list);
      } else {
        const scroll = document.createElement('div'); scroll.className = 'query-table-scroll';
        const table = document.createElement('table'), head = document.createElement('thead'), header = document.createElement('tr'), tbody = document.createElement('tbody');
        for (const column of query.columns) { const th = document.createElement('th'); th.textContent = column; header.append(th); } head.append(header); table.append(head,tbody);
        for (const note of result.results) { const tr = document.createElement('tr'); for (const [index,column] of query.columns.entries()) { const td = document.createElement('td'); if (column === 'title' || index === 0) td.append(link(note.path, queryValue(note,column) || note.name)); else td.textContent = queryValue(note,column); tr.append(td); } tbody.append(tr); } scroll.append(table); body.append(scroll);
      }
      if (!result.results.length) { const empty = document.createElement('p'); empty.textContent = 'No matching notes.'; body.append(empty); }
      if (result.hasMore) { const more = document.createElement('p'); more.textContent = 'More results exist. Narrow the query or increase limit (up to 200).'; body.append(more); }
    } catch (error) { if (current() && ticket === serial) { body.textContent = error instanceof Error ? error.message : String(error); body.setAttribute('role','alert'); } }
    finally { if (current() && ticket === serial) refresh.disabled = false; }
  };
  refresh.addEventListener('click', event => { event.stopPropagation(); if (current()) void run(); }); await run();
}
