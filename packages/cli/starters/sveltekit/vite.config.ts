import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
export default defineConfig({ plugins: [sveltekit({ adapter: adapter(), preprocess: vitePreprocess() })], server: { port: 3000, strictPort: true }, ssr: { external: ['mayura', 'better-sqlite3', 'pg'] } });
