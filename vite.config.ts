import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  optimizeDeps: { entries: ['index.html'] },
  server: { host: '127.0.0.1', port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/target/**'] } },
  clearScreen: false,
  build: { target: 'es2022', chunkSizeWarningLimit: 1400 },
});
