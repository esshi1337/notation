import DOMPurify from 'dompurify';

export const stickyColors = ['yellow', 'green', 'blue', 'pink', 'purple', 'gray'] as const;
export type StickyColor = typeof stickyColors[number];
export type StickyContent = { title: string; text: string; color?: string; html?: string | null };

// Sanitize in an inert document before anything enters the live editor. No
// resource-bearing tags, attributes (including style), SVG, or custom elements.
export function sanitizeSticky(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'div', 'br', 'b', 'strong', 'i', 'em', 'ul', 'li'],
    ALLOWED_ATTR: [], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });
}

export function legacyStickyText(note: StickyContent): string {
  const firstLine = note.text.split(/\r?\n/).find(line => line.trim())?.trim();
  return note.title.trim() && note.title !== 'Untitled sticky' && note.title.trim() !== firstLine
    ? note.title + (note.text ? '\n' + note.text : '') : note.text;
}

export function stickyTitle(text: string): string {
  const first = text.split('\n').find(line => line.trim())?.trim() || 'Untitled sticky';
  const encoder = new TextEncoder();
  let result = '', bytes = 0;
  for (const char of first) {
    bytes += encoder.encode(char).length;
    if (bytes > 256) break;
    result += char;
  }
  return result;
}

export function validateSticky(text: string, html: string) {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length > 65536 || encoder.encode(html).length > 131072) {
    throw new Error('Sticky text must be at most 64 KiB and formatting at most 128 KiB. Nothing was truncated. Shorten the note to save; the original saved note is unchanged.');
  }
}
