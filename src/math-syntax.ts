// Which language a `$…$` expression is written in. Typst is the default; the
// detector only has to recognise LaTeX, and it does so conservatively: a note
// written before Typst support must keep rendering through KaTeX unchanged.
import { scanFrontmatter } from './frontmatter';

export const MATH_MODES = ['auto', 'typst', 'latex'] as const;
/** `auto`: Typst first, LaTeX fallback. `typst` / `latex`: that engine only. */
export type MathMode = typeof MATH_MODES[number];
export type MathEngine = 'typst' | 'latex';

export function readMathMode(value: unknown): MathMode | null {
  if (typeof value !== 'string') return null;
  const mode = value.trim().toLowerCase();
  if (mode === 'katex' || mode === 'tex') return 'latex';
  return (MATH_MODES as readonly string[]).includes(mode) ? mode as MathMode : null;
}

let fallbackMode: MathMode = 'auto';
/** The Settings → Editor default, used by documents without a `math:` property. */
export function setDefaultMathMode(mode: MathMode): void { fallbackMode = readMathMode(mode) ?? 'auto'; }
export function defaultMathMode(): MathMode { return fallbackMode; }

let scanned: { source: string; mode: MathMode | null } | undefined;
/** The document's own `math: typst|latex|auto` frontmatter property, if any. */
export function documentMathMode(source: string | undefined): MathMode | null {
  if (!source || !source.startsWith('---') && !source.startsWith('﻿---')) return null;
  if (scanned?.source === source) return scanned.mode;
  const frontmatter = scanFrontmatter(source);
  // A top-level scalar is all this property can be, so a line match avoids a
  // full YAML parse for every render of a large properties block.
  const line = frontmatter?.closed ? /^math[ \t]*:[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^#\r\n]*?))[ \t]*(?:#.*)?\r?$/mu.exec(frontmatter.raw) : null;
  const mode = line ? readMathMode(line[1] ?? line[2] ?? line[3]) : null;
  scanned = { source, mode };
  return mode;
}
export function resolveMathMode(source?: string, fallback?: MathMode | null): MathMode {
  return documentMathMode(source) ?? fallback ?? fallbackMode;
}

// LaTeX markers that mean nothing, or something no one writes, in Typst math:
//   \frac \alpha \begin …   a backslash command (`\u{…}` is Typst's escape)
//   \\                      a TeX line break; Typst uses a single backslash
//   \, \; \: \! \> \{ \} \| \%  TeX spacing, delimiter and percent escapes
//   x^{…} x_{…}             brace-grouped scripts; Typst groups with (…)
//   a\ b                    a TeX control space glued to its neighbours
const LATEX = /\\(?!u\{)[A-Za-z]|\\\\|\\[,;:!>{}|%]|[\^_][ \t]*\{|\S\\ \S/u;
export function looksLikeLatex(content: string): boolean { return LATEX.test(content); }

/** The engine to try first. In `auto`, Typst unless the source is recognisably LaTeX. */
export function mathEngineFor(content: string, mode: MathMode): MathEngine {
  if (mode !== 'auto') return mode;
  return looksLikeLatex(content) ? 'latex' : 'typst';
}

function unescapedDollar(content: string): boolean {
  for (let at = 0; at < content.length; at++) {
    if (content[at] === '\\') { at++; continue; }
    if (content[at] === '$') return true;
  }
  return false;
}
/** A reason this source can never be one Typst equation, or null. */
export function typstMathProblem(content: string): string | null {
  if (!content.trim()) return 'the equation is empty';
  if (content.length > 16 * 1024) return 'the equation exceeds 16 KiB';
  if (unescapedDollar(content)) return 'an unescaped $ would end the equation early; write \\$';
  return null;
}
/** The equation as Typst markup: `$x$` inline, `$ x $` display. */
export function typstEquation(content: string, display: boolean): string {
  const body = content.trim();
  // A trailing backslash is a line break; keep it from escaping the delimiter.
  return display ? '$ ' + body + ' $' : '$' + body + (body.endsWith('\\') ? ' ' : '') + '$';
}

/** Sentinel text colour, swapped for `currentColor` so equations follow the theme. */
export const TYPST_INK = '#0102fe';
export const TYPST_METRICS_LABEL = 'notation-math';
/** Typst text size of the compiled equation; SVG lengths divide by it to become em. */
export const TYPST_TEXT_PT = 10;
/**
 * A one-equation Typst document sized to its content. The metadata carries the
 * exact width, height and (inline) descent below the baseline in pt: zero
 * paragraph leading removes the slack Typst otherwise trims from inline
 * equations, and the tall zero-width box pins the line's ascent so the
 * measured remainder is the descent.
 */
export function typstMathDocument(content: string, display: boolean): string {
  return '#set page(width: auto, height: auto, margin: 0pt, fill: none)\n'
    + '#set par(leading: 0pt)\n'
    + `#set text(size: ${TYPST_TEXT_PT}pt, fill: rgb("${TYPST_INK}"))\n`
    + '#let notation-eq = ' + typstEquation(content, display) + '\n'
    + '#context { let size = measure(notation-eq); let line = measure([#notation-eq#box(width: 0pt, height: 1000pt)]); '
    + `[#metadata((size.width.pt(), size.height.pt(), ${display ? '0' : '(line.height - 1000pt).pt()'})) <${TYPST_METRICS_LABEL}>] }#notation-eq\n`;
}
/** First error of a Typst diagnostics list as one readable sentence. */
export function typstDiagnostic(diagnostics: unknown): string {
  const list = Array.isArray(diagnostics) ? diagnostics : [];
  const first = list.find((item) => item && typeof item === 'object' && (item as { severity?: unknown }).severity === 'error') ?? list[0];
  const message = first && typeof first === 'object' ? String((first as { message?: unknown }).message ?? '') : typeof first === 'string' ? first : '';
  const text = message.replace(/, hints?: /u, '. Hint: ').replace(/\s+/gu, ' ').trim() || 'the equation did not compile';
  return text.length > 320 ? text.slice(0, 319) + '…' : text;
}
