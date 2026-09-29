// After `vite build`: turn the prerendered output into what GitHub Pages serves.
//   - /not-found/ becomes /404.html, which Pages serves for any path without a page;
//   - every docs page is also published as Markdown at its repository path (/docs/concepts/agent.md), which is what
//     "View as Markdown" and the links in llms.txt point to;
//   - llms.txt and llms-full.txt, generated from docs/ exactly as for the npm package;
//   - robots.txt, pointing at the sitemap.
import { cpSync, existsSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { llmsFullTxt, llmsTxt } from '../../scripts/docs-index.mjs';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(site, 'dist', 'client');
const base = `/${(process.env.SITE_BASE ?? '').replace(/^\/+|\/+$/gu, '')}/`.replace('//', '/');
const origin = (process.env.SITE_ORIGIN ?? 'https://mayurajs.com').replace(/\/+$/u, '');

if (!existsSync(join(output, 'index.html'))) throw new Error(`No prerendered site in ${output}; run vite build first.`);

renameSync(join(output, 'not-found', 'index.html'), join(output, '404.html'));
rmSync(join(output, 'not-found'), { recursive: true });

const docs = resolve(site, '..', 'docs');
cpSync(docs, join(output, 'docs'), { recursive: true });

writeFileSync(join(output, 'llms.txt'), llmsTxt({ full: true }));
writeFileSync(join(output, 'llms-full.txt'), llmsFullTxt());

/** Every prerendered page's route (`docs/concepts/agent/`), from its index.html. */
const pages = (directory, prefix = '') => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? pages(join(directory, entry.name), `${prefix}${entry.name}/`) : entry.name === 'index.html' ? [prefix] : []);
const routes = pages(output).sort();
writeFileSync(join(output, 'sitemap.xml'), [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...routes.map(route => `  <url><loc>${origin}${base}${route}</loc></url>`),
  '</urlset>',
  '',
].join('\n'));
writeFileSync(join(output, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${origin}${base}sitemap.xml\n`);

console.log(JSON.stringify({ status: 'finished', output: 'site/dist/client', base, pages: routes.length }));
