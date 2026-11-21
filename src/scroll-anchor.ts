// Keeps the reading position when the view mode changes. The anchor is the
// source line at the top of the viewport. The editor maps lines exactly; the
// rendered preview has no per-block source positions, so it interpolates
// between its top-level headings, which do have known source lines.

export type Anchor = { line: number; offset: number };

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/u;

/** One-based lines of the headings that render as top-level preview headings. */
export function sourceHeadingLines(text: string): number[] {
  const lines = text.split('\n');
  const result: number[] = [];
  let index = 0;
  if (/^---[ \t]*\r?$/u.test(lines[0] ?? '')) {
    const end = lines.findIndex((line, at) => at > 0 && /^(?:---|\.\.\.)[ \t]*\r?$/u.test(line));
    if (end > 0) index = end + 1;
  }
  let fence: string | null = null;
  let paragraph = false;
  for (; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/u, '');
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = null;
      continue;
    }
    if (marker) { fence = marker; paragraph = false; continue; }
    if (ATX.test(line)) { result.push(index + 1); paragraph = false; continue; }
    // Setext: a paragraph line underlined with = or -.
    if (paragraph && /^ {0,3}(?:=+|-+)[ \t]*$/u.test(line)) { result.push(index); paragraph = false; continue; }
    paragraph = !!line.trim() && !/^ {0,3}(?:[-*+>|]|\d+[.)]|\t| {4})/u.test(line);
  }
  return result;
}

/**
 * Anchors from line 1 at offset 0 to one past the last line at `height`, with
 * one anchor per heading when the rendered headings match the source ones.
 * Without a match the two ends still give a proportional mapping.
 */
export function buildAnchors(lineCount: number, height: number, headingLines: number[], headingOffsets: number[]): Anchor[] {
  const anchors: Anchor[] = [{ line: 1, offset: 0 }];
  if (headingLines.length === headingOffsets.length) {
    for (let index = 0; index < headingLines.length; index++) {
      const previous = anchors[anchors.length - 1];
      const line = headingLines[index], offset = headingOffsets[index];
      // Keep the mapping monotonic even for unexpected layouts.
      if (line > previous.line && offset >= previous.offset && offset <= height) anchors.push({ line, offset });
    }
  }
  const last = anchors[anchors.length - 1];
  const end = Math.max(lineCount + 1, last.line + 1);
  anchors.push({ line: end, offset: Math.max(height, last.offset) });
  return anchors;
}

export function offsetForLine(anchors: Anchor[], line: number): number {
  if (!anchors.length) return 0;
  if (line <= anchors[0].line) return anchors[0].offset;
  for (let index = 1; index < anchors.length; index++) {
    const from = anchors[index - 1], to = anchors[index];
    if (line <= to.line) return from.offset + (to.offset - from.offset) * (line - from.line) / (to.line - from.line);
  }
  return anchors[anchors.length - 1].offset;
}

export function lineForOffset(anchors: Anchor[], offset: number): number {
  if (!anchors.length) return 1;
  if (offset <= anchors[0].offset) return anchors[0].line;
  for (let index = 1; index < anchors.length; index++) {
    const from = anchors[index - 1], to = anchors[index];
    if (offset <= to.offset) {
      if (to.offset === from.offset) return from.line;
      return Math.floor(from.line + (to.line - from.line) * (offset - from.offset) / (to.offset - from.offset));
    }
  }
  return anchors[anchors.length - 1].line - 1;
}
