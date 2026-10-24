import { mount } from 'svelte';
import App from './App.svelte';
import './style.css';
import { bootstrapMetadata } from './store';

const target = document.getElementById('app')!;
target.textContent = 'Loading Notation…';
// Do not leave the startup snapshot in the top-level await result register.
// Some runtimes retain the module continuation for its whole lifetime.
await bootstrapMetadata().then(() => undefined);
target.textContent = '';
mount(App, { target });
