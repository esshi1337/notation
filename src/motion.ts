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

/** JavaScript twin of a CSS cubic-bezier() curve, for Svelte transitions. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const sample = (a: number, b: number, t: number) => ((1 - 3 * b + 3 * a) * t + (3 * b - 6 * a)) * t * t + 3 * a * t;
  const slope = (a: number, b: number, t: number) => 3 * (1 - 3 * b + 3 * a) * t * t + 2 * (3 * b - 6 * a) * t + 3 * a;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let step = 0; step < 6; step++) {
      const gradient = slope(x1, x2, t);
      if (Math.abs(gradient) < 1e-6) break;
      t = Math.min(1, Math.max(0, t - (sample(x1, x2, t) - x) / gradient));
    }
    return sample(y1, y2, t);
  };
}
export const easeOut = cubicBezier(.2, .8, .2, 1);
export const easeIn = cubicBezier(.4, 0, 1, 1);

/** Share of the enter duration an exit takes: leaving is quicker than arriving. */
export const EXIT_RATIO = .7;

type PopOptions = { token?: MotionToken; x?: number; y?: number; scale?: number; origin?: string; exit?: boolean };

/** Fade with a small offset and scale from the anchor. Use as `in:pop` and
    `out:pop={{ exit: true }}`; Svelte marks a leaving element inert. */
export function pop(_node: Element, { token = 'base', x = 0, y = -4, scale = .98, origin = 'top left', exit = false }: PopOptions = {}) {
  return {
    duration: motionMs(token) * (exit ? EXIT_RATIO : 1),
    easing: exit ? easeIn : easeOut,
    css: (t: number) => `opacity:${t};transform-origin:${origin};transform:translate(${(1 - t) * x}px,${(1 - t) * y}px) scale(${scale + (1 - scale) * t})`,
  };
}

/** Svelte action for modal dialogs. A dialog leaves at once so focus and input
    are never delayed; only its backdrop dim fades out, on a click-through
    element that removes itself. */
export function scrimExit(_node: HTMLElement) {
  return {
    destroy() {
      const duration = motionMs('base') * EXIT_RATIO;
      if (!duration || typeof document === 'undefined') return;
      const scrim = document.createElement('div');
      scrim.className = 'modal-scrim-exit';
      scrim.setAttribute('aria-hidden', 'true');
      document.body.append(scrim);
      const animation = scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: 'cubic-bezier(.4, 0, 1, 1)' });
      const remove = () => scrim.remove();
      animation.onfinish = remove;
      animation.oncancel = remove;
      // A hidden window can defer animation events; never leave the dim behind.
      setTimeout(remove, duration + 250);
    },
  };
}

/** Svelte action: fade the element's content in whenever `key` changes, for
    surfaces that swap what they show in place (the sidebar tool panel). */
export function fadeOnChange(node: HTMLElement, key: unknown) {
  let current = key;
  return {
    update(next: unknown) {
      if (next === current) return;
      current = next;
      const duration = motionMs('fast');
      if (duration) node.firstElementChild?.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    },
  };
}

/** Grow or shrink an element along the inline axis while fading it, for items
    entering or leaving a row (document tabs). Only that item's width animates;
    its neighbours follow through normal layout. `gap` is the row gap to absorb. */
export function collapseX(node: Element, { token = 'base', gap = 0, exit = false }: { token?: MotionToken; gap?: number; exit?: boolean } = {}) {
  const width = node.getBoundingClientRect().width;
  return {
    duration: motionMs(token) * (exit ? EXIT_RATIO : 1),
    easing: exit ? easeIn : easeOut,
    css: (t: number) => `overflow:hidden;min-width:0;max-width:${t * width}px;margin-inline-end:${-(1 - t) * gap}px;opacity:${t}`,
  };
}
