// Wheel and pinch helpers shared by the canvas and the graph.

type WheelLike = Pick<WheelEvent, 'deltaY' | 'deltaMode'>;

const LINE_PIXELS = 16;
const PAGE_PIXELS = 400;
// A mouse wheel notch arrives as one large step (about 50-120 px, or line or
// page units). Trackpad pinches and two-finger scrolls arrive as a stream of
// small pixel deltas.
const NOTCH_PIXELS = 40;
// Zoom per pixel of continuous input. A pinch reports small deltas (a full
// pinch is around a hundred pixels); a two-finger scroll that zooms covers
// several hundred, so it needs a gentler rate.
export const PINCH_SENSITIVITY = 0.01;
export const SCROLL_ZOOM_SENSITIVITY = 0.002;

export function wheelPixels(event: WheelLike): number {
  if (event.deltaMode === 1) return event.deltaY * LINE_PIXELS;
  if (event.deltaMode === 2) return event.deltaY * PAGE_PIXELS;
  return event.deltaY;
}

/** Both wheel axes in pixels, whatever unit the device reports. */
export function wheelDelta(event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>): { x: number; y: number } {
  const scale = event.deltaMode === 1 ? LINE_PIXELS : event.deltaMode === 2 ? PAGE_PIXELS : 1;
  return { x: event.deltaX * scale, y: event.deltaY * scale };
}

/** True for a stream of small pixel deltas (trackpad, Magic Mouse, pinch). */
export function isContinuousWheel(event: WheelLike): boolean {
  return event.deltaMode === 0 && Math.abs(event.deltaY) < NOTCH_PIXELS;
}

/**
 * Zoom multiplier for one wheel event. A notched wheel keeps a fixed step per
 * notch. Continuous input zooms in proportion to its delta, so a pinch made
 * of dozens of small events is smooth instead of jumping a full step each.
 */
export function wheelZoomFactor(event: WheelLike, step: { in: number; out: number }, sensitivity = PINCH_SENSITIVITY): number {
  if (!event.deltaY) return 1;
  if (!isContinuousWheel(event)) return event.deltaY < 0 ? step.in : step.out;
  return Math.exp(-wheelPixels(event) * sensitivity);
}

type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };

/**
 * WebKit (Safari and the macOS WKWebView) reports a trackpad pinch as
 * gesturestart/gesturechange events carrying a cumulative scale, not as
 * ctrl+wheel. `zoom` receives the incremental factor since the last event.
 */
export function pinchZoom(node: HTMLElement | SVGElement, zoom: (factor: number, clientX: number, clientY: number) => void) {
  let last = 1;
  const start = (event: Event) => { event.preventDefault(); last = 1; };
  const change = (event: Event) => {
    event.preventDefault();
    const gesture = event as GestureEvent;
    if (!Number.isFinite(gesture.scale) || gesture.scale <= 0) return;
    const factor = gesture.scale / last;
    last = gesture.scale;
    if (factor !== 1) zoom(factor, gesture.clientX, gesture.clientY);
  };
  const end = (event: Event) => { event.preventDefault(); last = 1; };
  node.addEventListener('gesturestart', start);
  node.addEventListener('gesturechange', change);
  node.addEventListener('gestureend', end);
  return {
    update(next: (factor: number, clientX: number, clientY: number) => void) { zoom = next; },
    destroy() {
      node.removeEventListener('gesturestart', start);
      node.removeEventListener('gesturechange', change);
      node.removeEventListener('gestureend', end);
    },
  };
}
