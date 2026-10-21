import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ root: 'web', plugins: [react()], server: { host: '127.0.0.1', port: 3000, strictPort: true, proxy: { '/api/mayura': 'http://127.0.0.1:3001' } }, build: { outDir: '../dist/client', emptyOutDir: true } });
