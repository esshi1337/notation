import type { Extension } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { rust } from '@codemirror/lang-rust';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import { svelte } from '@replit/codemirror-lang-svelte';

import type { CodeLanguage } from './code-languages';

export function languageExtensions(language: CodeLanguage): Extension {
  switch (language) {
    case 'typescript': return javascript({ typescript: true });
    case 'typescriptreact': return javascript({ typescript: true, jsx: true });
    case 'javascript': return javascript();
    case 'javascriptreact': return javascript({ jsx: true });
    case 'svelte': return svelte();
    case 'rust': return rust();
    case 'json': return json();
    case 'html': return html();
    case 'css': return css();
    case 'python': return python();
    case 'yaml': return yaml();
    default: return [];
  }
}
