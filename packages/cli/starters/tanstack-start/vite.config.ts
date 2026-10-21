import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';
export default defineConfig({ plugins: [tanstackStart(), react(), nitro({ rollupConfig: { external: [/^mayura(?:\/|$)/, /^@mayura\//] }, rolldownConfig: { external: [/^mayura(?:\/|$)/, /^@mayura\//] } })], server: { port: 3000, strictPort: true }, ssr: { external: ['mayura', 'better-sqlite3', 'pg'] } });
