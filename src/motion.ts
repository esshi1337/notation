// Scripted motion reads the same tokens as motion.css, so reduced motion
// (system setting, Performance mode or the Appearance toggle) applies to both.
export type MotionToken = 'fast' | 'base' | 'slow';

const FALLBACK: Record<MotionToken, number> = { fast: 120, base: 180, slow: 240 };

export function motionMs(token: MotionToken): number {
  if (typeof document === 'undefined') return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--motion-' + token).trim();
  const value = raw.endsWith('ms') ? Number.parseFloat(raw) : raw.endsWith('s') ? Number.parseFloat(raw) * 1000 : Number.NaN;
  return Number.isFinite(value) ? value : FALLBACK[token];
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn']);

/** Record whether the last input came from a pointer or the keyboard on the
    root element. motion.css uses it to hide focus rings that WebKit draws when
    a script moves focus after a click. Returns a function that stops tracking. */
export function trackInputModality(root: HTMLElement = document.documentElement): () => void {
  const set = (value: 'pointer' | 'keyboard') => { if (root.dataset.input !== value) root.dataset.input = value; };
  const pointer = () => set('pointer');
  const keyboard = (event: KeyboardEvent) => { if (!MODIFIER_KEYS.has(event.key)) set('keyboard'); };
  const options = { capture: true, passive: true } as const;
  window.addEventListener('pointerdown', pointer, options);
  window.addEventListener('keydown', keyboard, options);
  return () => {
    window.removeEventListener('pointerdown', pointer, options);
    window.removeEventListener('keydown', keyboard, options);
  };
}
