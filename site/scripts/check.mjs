// Checks the built site in dist/client the way GitHub Pages will serve it:
//   - every docs page in docs/README.md's navigation, the home page and 404.html were prerendered;
//   - every link, script, stylesheet and image on every page resolves to a file under the base path, and every
//     #anchor exists on the page it points to;
//   - every link in llms.txt resolves.
// Build with the same SITE_BASE first: `pnpm build && pnpm check`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { navigation } from '../../scripts/docs-index.mjs';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(site, 'dist', 'client');
const base = `/${(process.env.SITE_BASE ?? '').replace(/^\/+|\/+$/gu, '')}/`.replace('//', '/');
const problems = [];

/** The file GitHub Pages serves for a path under the base, or undefined. */
function fileFor(pathname) {
  if (!pathname.startsWith(base)) return undefined;
  const path = join(output, decodeURIComponent(pathname.slice(base.length)));
  if (pathname.endsWith('/')) return existsSync(join(path, 'index.html')) ? join(path, 'index.html') : undefined;
  return existsSync(path) && statSync(path).isFile() ? path : undefined;
}

const ids = new Map();
const idsOf = file => {
  if (!ids.has(file)) ids.set(file, new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/gu)].map(match => match[1])));
  return ids.get(file);
};

const htmlFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? htmlFiles(join(directory, entry.name)) : entry.name.endsWith('.html') ? [join(directory, entry.name)] : []);
const pages = htmlFiles(output);

// Every section of site/content and every article in it (site/content/guides/x.md is guides/x/).
const contentRoot = join(site, 'content');
const articles = ['guides', 'integrations', 'compare', 'research'].flatMap(section => [`${section}/`,
  ...(existsSync(join(contentRoot, section)) ? readdirSync(join(contentRoot, section)).filter(name => name.endsWith('.md')).map(name => `${section}/${name.slice(0, -3)}/`) : [])]);
const required = ['', 'docs/', '404.html', 'llms.txt', 'llms-full.txt', 'sitemap.xml', 'robots.txt', ...articles,
  ...navigation().flatMap(section => section.pages.map(page => `${page.relative.replace(/\.md$/u, '')}/`)),
  ...navigation().flatMap(section => section.pages.map(page => page.relative))];
for (const path of required) if (!fileFor(base + path)) problems.push(`missing: ${base}${path}`);

let links = 0;
for (const file of pages) {
  const html = readFileSync(file, 'utf8');
  // The page's own URL, so relative references resolve as they will in the browser.
  const route = relative(output, file).split('\\').join('/').replace(/(^|\/)index\.html$/u, '$1');
  const self = new URL(base + route, 'https://site.invalid');
  for (const [, attribute, value] of html.matchAll(/\s(href|src)="([^"]*)"/gu)) {
    const url = new URL(value.replaceAll('&amp;', '&'), self);
    if (url.origin !== self.origin) continue;
    links++;
    const target = url.pathname === self.pathname ? file : fileFor(url.pathname);
    const where = `${relative(site, file)}: ${attribute}="${value}"`;
    if (!target) { problems.push(`${where} does not resolve`); continue; }
    const anchor = decodeURIComponent(url.hash.slice(1));
    if (anchor && target.endsWith('.html') && !idsOf(target).has(anchor)) problems.push(`${where}: no #${anchor} on that page`);
  }
}

const llms = readFileSync(join(output, 'llms.txt'), 'utf8');
for (const [, href] of llms.matchAll(/\]\(([^)]+)\)/gu)) {
  if (/^https?:/u.test(href)) continue;
  links++;
  if (!fileFor(base + href)) problems.push(`llms.txt: ${href} does not resolve`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s) in the built site.`);
  process.exit(1);
}
console.log(JSON.stringify({ status: 'ok', base, pages: pages.length, links }));
