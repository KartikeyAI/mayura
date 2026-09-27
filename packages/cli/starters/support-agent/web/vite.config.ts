import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// The chat UI is a static bundle (web/dist). Serve it from any static host on the same origin as the Mayura API, or
// list its origin in MAYURA_ALLOWED_ORIGINS. It holds no secrets: customers authenticate with sessions your backend mints.
export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
