import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// The console is served by @mayura/server at /inspector with fixed, unhashed asset names so the server can embed
// them and pin a strict CSP. Nothing is loaded from a CDN.
export default defineConfig({
  base: '/inspector/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'dist', emptyOutDir: true, modulePreload: false, cssCodeSplit: false, sourcemap: false, assetsInlineLimit: 0,
    rollupOptions: { output: { entryFileNames: 'app.js', chunkFileNames: 'app-[name].js', assetFileNames: 'app.[ext]', inlineDynamicImports: true } },
  },
});
