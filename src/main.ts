import { mount } from 'svelte';
import App from './App.svelte';
import './style.css';
import { bootstrapMetadata } from './store';

const target = document.getElementById('app')!;
target.textContent = 'Loading Notation…';
const metadata = await bootstrapMetadata();
target.textContent = '';
mount(App, { target, props: { metadata } });
