import { invoke, isTauri } from '@tauri-apps/api/core';

/** `rgb(r, g, b)` (what computed styles report) as `#rrggbb`; null for anything else. */
export function hexColor(value: string): string | null {
  const match = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/u.exec(value);
  if (!match) return null;
  return '#' + match.slice(1, 4).map((channel) => Math.min(255, Number(channel)).toString(16).padStart(2, '0')).join('');
}

let pending: 'dark' | 'light' | null = null;
/**
 * The desktop main window starts hidden. Once the theme's styles are in the
 * document, hand the backend the page's actual background and the light/dark
 * appearance: it gives the native window the same colour (what shows before
 * the first paint and along the edges while resizing) and shows the window.
 * Called again whenever the theme changes.
 *
 * This deliberately does not wait for an animation frame: a hidden webview
 * may not produce frames at all, and the window would stay hidden.
 */
export function presentWindow(theme: 'dark' | 'light') {
  if (!isTauri()) return;
  const scheduled = pending !== null;
  pending = theme;
  if (scheduled) return;
  // After the current reactive update has written the theme to the document.
  queueMicrotask(() => {
    const appearance = pending ?? theme;
    pending = null;
    // Reading the computed style resolves the theme's variables now.
    const background = hexColor(getComputedStyle(document.body).backgroundColor) ?? (appearance === 'light' ? '#ffffff' : '#000000');
    void invoke('present_main_window', { background, theme: appearance }).catch(() => undefined);
  });
}
