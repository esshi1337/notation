import type { Text } from '@codemirror/state';

// Conservative UTF-16 code-unit thresholds, not a timing or memory guarantee.
// Classification is bounded; a synchronous parser cannot be interrupted later.
export const REDUCED_FORMATTING_SIZE = 256 * 1024;
export const REDUCED_FORMATTING_MIN = 64 * 1024;
const RESTORE_SIZE = 192 * 1024, RESTORE_MIN = 48 * 1024;
export type FormattingReason = 'size' | 'density' | null;
export type FormattingStatus = { reduced: boolean; reason: FormattingReason; size: number };
type Measurement = { size: number; density: number; longest: number };
const measurements = new WeakMap<Text, Measurement>();

function inspect(text: string, size = text.length): Measurement {
  let syntax = 0, run = 0, longest = 0, previous = -1;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if ('!#$()*+-=>[\\]_`|~'.includes(text[at])) {
      syntax++;
      run = code === previous ? run + 1 : 1; previous = code;
      longest = Math.max(longest, run);
    } else { previous = -1; run = 0; }
  }
  return { size, density: syntax / Math.max(1, size), longest };
}
function classify({ size, density, longest }: Measurement, previous?: FormattingStatus): FormattingStatus {
  if (size >= REDUCED_FORMATTING_SIZE) return { reduced: true, reason: 'size', size };
  if (size >= REDUCED_FORMATTING_MIN && (density >= 0.35 || longest >= 256)) return { reduced: true, reason: 'density', size };
  // Restore at a lower threshold, so typing/backspace at the boundary cannot
  // repeatedly rebuild language and widget state. Small replacements restore.
  if (previous?.reduced && size >= RESTORE_MIN && (size >= RESTORE_SIZE || density >= 0.28 || longest >= 192))
    return { reduced: true, reason: previous.reason, size };
  return { reduced: false, reason: null, size };
}
function measure(text: string): Measurement {
  return text.length < RESTORE_MIN || text.length >= REDUCED_FORMATTING_SIZE
    ? { size: text.length, density: 0, longest: 0 } : inspect(text);
}
export function reducedFormatting(text: string, previous?: FormattingStatus): FormattingStatus {
  return classify(measure(text), previous);
}
export function formattingStatus(doc: Text, previous?: FormattingStatus): FormattingStatus {
  let measurement = measurements.get(doc);
  if (!measurement) {
    measurement = doc.length < RESTORE_MIN || doc.length >= REDUCED_FORMATTING_SIZE
      ? { size: doc.length, density: 0, longest: 0 } : inspect(doc.toString());
    measurements.set(doc, measurement);
  }
  return classify(measurement, previous);
}
