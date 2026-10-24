import assert from 'node:assert/strict';
import { documentCounts } from '../src/document-counts.ts';
for (const text of ['', '  ', '\r\n', 'a\nb\n', '\talpha\r\nbeta\t', 'α\u00a0β\u2003γ\ufeffδ', '😀 hello', 'line '.repeat(300000)]) {
  assert.deepEqual(documentCounts(text), { lines: text.split('\n').length, words: text.trim() ? text.trim().split(/\s+/).length : 0 });
}
console.log('Document count parity passed, including large text and Unicode whitespace.');
