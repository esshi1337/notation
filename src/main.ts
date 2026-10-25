import { mount } from 'svelte';
import './style.css';
import { isTauri } from '@tauri-apps/api/core';

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
    target.textContent = '';
    mount(StickyNote, { target, props: { id } });
  } else target.textContent = 'Sticky notes require a matching native desktop window.';
} else {
  const { bootstrapMetadata } = await import('./store');
  await bootstrapMetadata().then(() => undefined);
  const { default: App } = await import('./App.svelte');
  target.textContent = '';
  mount(App, { target });
}
