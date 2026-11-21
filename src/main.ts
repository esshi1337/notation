import { mount } from 'svelte';
import './style.css';
import './motion.css';
import { isTauri } from '@tauri-apps/api/core';
import { followMotionPreference, trackInputModality } from './motion';
import { markOverlayScrollbars } from './scrollbars';
import { focusButtonsOnClick } from './click-focus';

// Sticky windows and the main window share the pointer/keyboard focus-ring rule.
trackInputModality();
markOverlayScrollbars();
focusButtonsOnClick();

const target = document.getElementById('app')!;
target.textContent = 'Loading Notation…';
// Do not leave the startup snapshot in the top-level await result register.
// Some runtimes retain the module continuation for its whole lifetime.
const query = new URLSearchParams(location.search);
const label = isTauri() ? (await import('@tauri-apps/api/window')).getCurrentWindow().label : '';
if (label.startsWith('sticky-') || query.has('sticky')) {
  const id = query.get('sticky') ?? '';
  if (isTauri() && /^[a-f0-9]{32}$/u.test(id) && label === `sticky-${id}`) {
    const { default: StickyNote } = await import('./StickyNote.svelte');
    // Follow the main window's Reduce motion and Performance mode settings.
    followMotionPreference();
    target.textContent = '';
    mount(StickyNote, { target, props: { id } });
  } else target.textContent = 'Sticky notes require a matching native desktop window.';
} else {
  const { bootstrapMetadata } = await import('./store');
  await bootstrapMetadata().then(() => undefined);
  // The macOS window draws its controls over the app's top bar (overlay
  // title bar); the stylesheet insets the bar under this class.
  const { isMac } = await import('./platform');
  if (isTauri() && isMac) document.documentElement.classList.add('platform-mac');
  const { default: App } = await import('./App.svelte');
  target.textContent = '';
  mount(App, { target });
}
