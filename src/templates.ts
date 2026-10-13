export type SavedTemplate = { id: string; name: string; content: string; updatedAt: number };
export const TEMPLATE_LIBRARY_BYTES = 32 * 1024;
export function resolveVariable(name: string, values: Record<string, unknown>, documentName?: string): string | null {
  name = name.trim();
  let value: unknown;
  if (Object.hasOwn(values, name)) value = values[name];
  else {
    value = values;
    for (const part of name.split('.')) { if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) { value = undefined; break; } value = (value as Record<string, unknown>)[part]; }
    if (value === undefined && name === 'document.name' && documentName !== undefined) value = documentName;
  }
  if (value === undefined) return null;
  if (value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return Array.isArray(value) ? value.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join(', ') : JSON.stringify(value); }
  catch { return '[complex value]'; }
}
export function substituteVariables(text: string, values: Record<string, unknown>, documentName?: string) {
  const missing = new Set<string>();
  let length = text.length;
  const result = text.replace(/\{\{([^{}\r\n]{1,256})\}\}/gu, (marker, name: string) => { const value = resolveVariable(name, values, documentName); if (value === null) { missing.add(name.trim()); return marker; } length += value.length - marker.length; if (length > 4 * 1024 * 1024) throw new Error('Resolved template exceeds the 4 MiB document limit. Use a smaller template or fewer repeated properties.'); return value; });
  return { text: result, missing: [...missing] };
}
export function readTemplateLibrary(value: unknown): SavedTemplate[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => !item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || typeof item.content !== 'string')) throw new Error('The saved template library is invalid. Its stored data has been retained.');
  const library = value as SavedTemplate[];
  if (new Set(library.map((item) => item.id)).size !== library.length) throw new Error('The saved template library contains duplicate IDs. Its stored data has been retained.');
  validateTemplateLibrary(library);
  return library.map((item) => ({ ...item }));
}
export function validateTemplateLibrary(library: SavedTemplate[]) {
  if (library.length > 100) throw new Error('The template library supports up to 100 templates. Delete or export a template before adding another.');
  if (new TextEncoder().encode(JSON.stringify(library)).length > TEMPLATE_LIBRARY_BYTES) throw new Error('The template library exceeds 32 KiB. Save larger templates as separate Markdown files; no templates were discarded.');
}
export function insertTemplate(text: string, from: number, to: number, template: string) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > to || to > text.length) throw new Error('The document selection is no longer valid. Preview the template again.');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const next = text.slice(0, from) + template.replace(/\r\n?|\n/gu, eol) + text.slice(to);
  if (new TextEncoder().encode(next).length > 4 * 1024 * 1024) throw new Error('Inserting this template would exceed the 4 MiB document limit.');
  return next;
}
