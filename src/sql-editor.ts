// Editor side of SQL blocks: Ctrl/Cmd+Enter inside a fence, inserting a
// result as a Markdown table, and SQL highlighting for the fence body.
import { Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import type { Language } from '@codemirror/language';
import { MySQL, PostgreSQL, SQLite, StandardSQL, sql } from '@codemirror/lang-sql';
import { parseFrontmatter } from './frontmatter';
import { knownConnection } from './sql-connections';
import { sqlConnection } from './sql-format';
import { sqlBlocks } from './sql-source';
import type { SqlBlock } from './sql-format';
import { runSqlBlock } from './render-sql';

const unix = (text: string) => text.replace(/\r\n?/gu, '\n');

/** Ctrl/Cmd+Enter with the cursor inside a SQL fence runs that block: an explicit action, like its Run button. */
export function sqlRunKeymap(scope: () => string | undefined): Extension {
  return Prec.highest(keymap.of([{
    key: 'Mod-Enter',
    run(view) {
      const text = view.state.doc.toString(), head = view.state.selection.main.head;
      const block = sqlBlocks(text).find((candidate) => head >= candidate.from && head <= candidate.to);
      if (!block) return false;
      runSqlBlock(scope() ?? '', block, parseFrontmatter(text)?.values ?? {});
      return true;
    },
  }]));
}

function insertAfter(view: EditorView, block: SqlBlock | undefined, markdown: string): boolean {
  // Inside a list or quote the table would need that block's prefix on every line.
  if (!block || !block.top || view.state.readOnly) return false;
  view.dispatch({ changes: { from: block.to, insert: '\n\n' + markdown + '\n' }, userEvent: 'input.sql-table' });
  return true;
}
/** Insert a table after the n-th block with this connection and query: one transaction, one undo step. */
export function insertSqlTable(view: EditorView, request: { connection: string; sql: string; occurrence: number; markdown: string }): boolean {
  const wanted = unix(request.sql);
  const matches = sqlBlocks(view.state.doc.toString()).filter((block) => block.connection === request.connection && unix(block.sql) === wanted);
  return insertAfter(view, matches[request.occurrence], request.markdown);
}
/** The same for a Live Preview widget, which knows where its fence starts. */
export function insertSqlTableAt(view: EditorView, from: number, request: { connection: string; sql: string; markdown: string }): boolean {
  const block = sqlBlocks(view.state.doc.toString()).find((candidate) => candidate.from === from && candidate.connection === request.connection && unix(candidate.sql) === unix(request.sql));
  return insertAfter(view, block, request.markdown);
}

const dialects = { postgres: PostgreSQL, mysql: MySQL, sqlite: SQLite } as const;
const languages = new Map<string, Language>();
/** Highlighting for a ```sql fence in Source view; the dialect follows the connection's kind when it is known. */
export function sqlFenceLanguage(info: string): Language | null {
  if (info.trim().split(/\s+/u)[0]?.toLowerCase() !== 'sql') return null;
  const connection = sqlConnection(info), kind = connection ? knownConnection(connection)?.kind : undefined;
  const name = kind ?? 'standard';
  let language = languages.get(name);
  if (!language) languages.set(name, language = sql({ dialect: kind ? dialects[kind] : StandardSQL }).language);
  return language;
}
