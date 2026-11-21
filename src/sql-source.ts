// Where the SQL blocks of a Markdown document are.
import { featureParser, markdownSource } from './markdown-features';
import { sqlConnection } from './sql-format';
import type { SqlBlock } from './sql-format';

/** Every SQL block of a document, in source order. */
export function sqlBlocks(text: string): SqlBlock[] {
  if (!/connection:/iu.test(text)) return [];
  const blocks: SqlBlock[] = [];
  let nested = 0;
  featureParser.parse(markdownSource(text)).iterate({
    enter(node) {
      if (node.name === 'Blockquote' || node.name === 'ListItem') nested++;
      if (node.name !== 'FencedCode') return;
      const info = node.node.getChild('CodeInfo'), body = node.node.getChild('CodeText');
      const connection = info ? sqlConnection(text.slice(info.from, info.to)) : null;
      if (connection) blocks.push({ connection, sql: body ? text.slice(body.from, body.to) : '', from: node.from, to: node.to, top: nested === 0 });
      return false;
    },
    leave(node) { if (node.name === 'Blockquote' || node.name === 'ListItem') nested--; },
  });
  return blocks;
}
