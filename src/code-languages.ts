export const languageOptions = [
  { value: 'markdown', label: 'Markdown' }, { value: 'plaintext', label: 'Plain text' },
  { value: 'typescript', label: 'TypeScript' }, { value: 'typescriptreact', label: 'TSX' },
  { value: 'javascript', label: 'JavaScript' }, { value: 'javascriptreact', label: 'JSX' },
  { value: 'svelte', label: 'Svelte' }, { value: 'rust', label: 'Rust' },
  { value: 'json', label: 'JSON' }, { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' }, { value: 'python', label: 'Python' }, { value: 'yaml', label: 'YAML' },
] as const;
export type CodeLanguage = typeof languageOptions[number]['value'];
export function validLanguage(value: unknown): value is CodeLanguage { return languageOptions.some(option => option.value === value); }
export function detectLanguage(name: string, override?: unknown): CodeLanguage {
  if (validLanguage(override)) return override;
  const extension = name.toLowerCase().split('.').pop()!;
  const types: Record<string, CodeLanguage> = { md: 'markdown', markdown: 'markdown', mmd: 'markdown', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact', svelte: 'svelte', rs: 'rust', json: 'json', jsonc: 'json', html: 'html', htm: 'html', css: 'css', py: 'python', yaml: 'yaml', yml: 'yaml' };
  return types[extension] ?? 'plaintext';
}
export function intelligenceLanguage(language: CodeLanguage) { return ['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'svelte', 'rust'].includes(language); }
export function documentFileName(name: string, markdown = true) {
  const clean = name.trim().replace(/[\\/:*?"<>|]/gu, '-');
  if (!clean) return 'untitled.md';
  // Explicit extensions, dotfiles, and conventional extensionless code files
  // must survive Rename/Save As without acquiring a Markdown extension.
  return !markdown || clean.includes('.') || /^(Dockerfile|Makefile|Justfile|LICENSE|README)$/u.test(clean) ? clean : clean + '.md';
}
