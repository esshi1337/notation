import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  // A sandboxed checkout may share node_modules through a read-only symlink.
  // Keep module and font URLs rooted in this checkout after relocation.
  resolve: { preserveSymlinks: true },
  // Graphviz is loaded on demand; discovering it during a running page reloads
  // other open views after a fresh sandbox starts with an empty Vite cache.
  optimizeDeps: { entries: ['index.html'], include: ['@viz-js/viz'] },
  server: { host: '127.0.0.1', port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/target/**'] } },
  clearScreen: false,
  build: { target: 'es2022', chunkSizeWarningLimit: 1400 },
});
