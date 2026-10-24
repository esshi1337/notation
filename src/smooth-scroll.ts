/**
 * Optional smooth wheel scrolling for the app's primary scroll regions.
 *
 * The action owns vertical wheel events inside the listed containers,
 * including small/fractional steps from high-resolution mice. Modified/horizontal wheels,
 * native controls, graphs/canvases, and nested scroll owners keep browser
 * behavior. Animation is a bounded, short requestAnimationFrame loop that
 * stops as soon as it settles.
 */

const SCROLL_CONTAINERS = '.preview-scroll, .cm-scroller, .settings-content, .shortcut-list, .sidebar-panel';
const SIDEBAR = '.sidebar-panel';
const NATIVE_OWNERS = '.graph-canvas, .graph-viewport, .canvas-viewport, canvas, video, audio, input[type="range"], input[type="number"], select, textarea, [role="slider"]';
const NESTED_SCROLLERS = 'pre, code, table, .markdown-table-scroll, .query-table-scroll, .diagram, .git-diff, .unified-diff, .revision-content, .cell-output, .database-view, .cm-live-math-block, .rendered-math, .callout';
const DURATION_MS = 180;
const FRAME_BUDGET_MS = 40;
const RECOVERY_IDLE_MS = 500;
const LINE_HEIGHT_PIXELS = 16;

type Animation = {
  element: HTMLElement;
  from: number;
  to: number;
  started: number;
  lastFrame: number;
};

export type SmoothScrollingAction = {
  update: (enabled: boolean) => void;
  destroy: () => void;
};

function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function isSupportedContainer(element: Element): boolean {
  return element.matches(SCROLL_CONTAINERS);
}

function isScrollableVertically(element: Element): boolean {
  const style = getComputedStyle(element);
  const overflow = style.overflowY;
  if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'overlay') return false;
  return element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 1;
}

function isNativeOwner(target: Element): boolean {
  if (target.closest(NATIVE_OWNERS)) return true;
  const editable = target.closest('[contenteditable]:not([contenteditable="false"])');
  // CodeMirror's editable surface is the scrolling editor. Other editable
  // controls keep their own wheel behavior.
  return Boolean(editable && !editable.closest('.cm-scroller'));
}

function findScrollTarget(target: Element, actionNode: HTMLElement): HTMLElement | null {
  const sidebar = target.closest(SIDEBAR);
  let element: Element | null = target;

  while (element) {
    if (isScrollableVertically(element)) {
      if (isSupportedContainer(element)) return element as HTMLElement;
      // A panel inside .sidebar-panel performs the actual scrolling. Keep
      // nested code/table/diagram scrollers native.
      if (sidebar && sidebar.contains(element) && !element.closest(NESTED_SCROLLERS)) {
        return element as HTMLElement;
      }
      // The nearest scroll owner is nested content, not an app scroll region.
      return null;
    }
    if (element === actionNode) break;
    element = element.parentElement;
  }

  return null;
}

function wheelPixels(event: WheelEvent, scroller: HTMLElement): number {
  if (event.deltaMode === 0) return event.deltaY;
  if (event.deltaMode === 1) return event.deltaY * LINE_HEIGHT_PIXELS;
  if (event.deltaMode === 2) return event.deltaY * Math.max(1, scroller.clientHeight);
  return 0;
}

export function smoothScrolling(node: HTMLElement, enabled: boolean): SmoothScrollingAction {
  let active = Boolean(enabled);
  let destroyed = false;
  let wheelListening = false;
  let frame = 0;
  let animation: Animation | null = null;
  let immediateUntil = 0;

  const motion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
  const reducedMotion = () => motion?.matches === true;

  function cancelAnimation() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    animation = null;
  }

  function tick(now: number) {
    frame = 0;
    const current = animation;
    if (!current) return;
    if (!current.element.isConnected) { cancelAnimation(); return; }

    const elapsed = Math.max(0, now - current.started);
    // WebKit (or a busy host) can miss frames during animated scrolling.
    // Finish this step immediately and keep the rest of this wheel gesture
    // native-speed. Retry animation only after the wheel has been idle.
    if (now - current.lastFrame > FRAME_BUDGET_MS) {
      current.element.scrollTop = current.to;
      animation = null;
      immediateUntil = performance.now() + RECOVERY_IDLE_MS;
      return;
    }
    current.lastFrame = now;
    const progress = elapsed >= DURATION_MS ? 1 : elapsed / DURATION_MS;
    if (progress >= 1) {
      current.element.scrollTop = current.to;
      animation = null;
      return;
    }

    const eased = 1 - Math.pow(1 - progress, 3);
    current.element.scrollTop = current.from + (current.to - current.from) * eased;
    frame = requestAnimationFrame(tick);
  }

  function startAnimation(element: HTMLElement, to: number) {
    // Rebase from the current position so repeated events coalesce into a
    // single bounded target instead of queuing animations.
    const now = performance.now();
    animation = { element, from: element.scrollTop, to, started: now, lastFrame: now };
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function onWheel(event: WheelEvent) {
    if (!active || reducedMotion() || event.defaultPrevented) return;
    if (!event.cancelable || event.ctrlKey || event.metaKey || event.shiftKey
      || !event.deltaY || (event.deltaX !== 0 && Math.abs(event.deltaX) >= Math.abs(event.deltaY))) {
      cancelAnimation();
      return;
    }

    const target = eventElement(event.target);
    if (!target || isNativeOwner(target)) return;
    const scroller = findScrollTarget(target, node);
    if (!scroller) return;

    const delta = wheelPixels(event, scroller);
    if (!delta) return;

    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (!max) return;

    const currentTop = scroller.scrollTop;
    const activeAnimation = animation?.element === scroller ? animation : null;
    // Reversing the wheel must reverse immediately, rather than first paying
    // off movement accumulated in the opposite direction.
    const reversing = activeAnimation && Math.sign(delta) !== Math.sign(activeAnimation.to - currentTop);
    const base = activeAnimation && !reversing ? activeAnimation.to : currentTop;
    const next = Math.min(max, Math.max(0, base + delta));

    if (next === base) {
      // Already at the relevant end: let the event chain to the parent.
      if ((delta > 0 && currentTop >= max - 1) || (delta < 0 && currentTop <= 1)) return;
      // The pending animation is still travelling to that end.
      if (activeAnimation) event.preventDefault();
      return;
    }
    if (next === currentTop) {
      // A reversal clamped back to the current position: stop the old
      // animation and let the browser scroll natively.
      cancelAnimation();
      return;
    }

    event.preventDefault();
    if (performance.now() < immediateUntil) {
      cancelAnimation();
      scroller.scrollTop = next;
      immediateUntil = performance.now() + RECOVERY_IDLE_MS;
      return;
    }
    startAnimation(scroller, next);
  }

  function syncWheelListener() {
    const shouldListen = active && !reducedMotion();
    if (shouldListen && !wheelListening) {
      node.addEventListener('wheel', onWheel, { passive: false });
      wheelListening = true;
    } else if (!shouldListen && wheelListening) {
      node.removeEventListener('wheel', onWheel);
      wheelListening = false;
    }
    if (!shouldListen) cancelAnimation();
  }

  function onInteraction() {
    cancelAnimation();
  }

  function onMotionChange() {
    syncWheelListener();
  }

  window.addEventListener('keydown', onInteraction, true);
  window.addEventListener('pointerdown', onInteraction, true);
  motion?.addEventListener('change', onMotionChange);
  syncWheelListener();

  return {
    update(next: boolean) {
      if (destroyed) return;
      active = Boolean(next);
      syncWheelListener();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      active = false;
      cancelAnimation();
      if (wheelListening) {
        node.removeEventListener('wheel', onWheel);
        wheelListening = false;
      }
      window.removeEventListener('keydown', onInteraction, true);
      window.removeEventListener('pointerdown', onInteraction, true);
      motion?.removeEventListener('change', onMotionChange);
    },
  };
}
