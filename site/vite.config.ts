import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { content } from './plugins/content.ts';
import { docs } from './plugins/docs.ts';

// The path the site is served under: "/" on mayurajs.com, "/mayura/" on kartikeyai.github.io. The Pages workflow sets
// SITE_BASE from the repository's Pages settings, so the same build works before and after the custom domain.
const base = `/${(process.env['SITE_BASE'] ?? '').replace(/^\/+|\/+$/gu, '')}/`.replace('//', '/');
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const origin = (process.env['SITE_ORIGIN'] ?? 'https://mayurajs.com').replace(/\/+$/u, '');

export default defineConfig({
  base,
  define: {
    'import.meta.env.SITE_ORIGIN': JSON.stringify(origin),
    'import.meta.env.MAYURA_VERSION': JSON.stringify(version),
  },
  plugins: [
    docs({ base }),
    content({ base }),
    tailwindcss(),
    // Every page is prerendered to static HTML, starting from "/" and following links; GitHub Pages serves the result.
    tanstackStart({
      prerender: {
        enabled: true, crawlLinks: true, failOnError: true,
        // Links to files that scripts/finish.mjs adds after the build (llms.txt, docs/*.md) aren't pages, and a link
        // to a section (#anchor) is the page it's on.
        filter: ({ path }) => !path.includes('#') && !/\.(?:txt|md|xml)$/u.test(path),
      },
      pages: [{ path: '/' }, { path: '/not-found' }],
    }),
    react(),
  ],
});
