// A Vite plugin that serves the repository's docs/ folder to the site as modules:
//   virtual:mayura-docs            the navigation (from docs/README.md, via scripts/docs-index.mjs) and a lazy
//                                  loader per page
//   virtual:mayura-search          the text of every section of every page, loaded when someone opens search
//   virtual:mayura-doc/<slug>      one rendered page: { slug, file, title, description, html, headings }
//   virtual:mayura-snippet/<name>  a highlighted file from site/snippets/, for the landing page
// Everything is rendered at build time; in development an edit under docs/ or snippets/ reloads the page.
import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';
import { navigation as readNavigation, readPage } from '../../scripts/docs-index.mjs';
import { codeBlock, getHighlighter, renderMarkdown, textOf, type Heading } from './markdown.ts';

const site = resolve(import.meta.dirname, '..');
const docsRoot = resolve(site, '../docs');
const snippetsRoot = resolve(site, 'snippets');

const INDEX = 'virtual:mayura-docs';
const SEARCH = 'virtual:mayura-search';
const PAGE = 'virtual:mayura-doc/';
const SNIPPET = 'virtual:mayura-snippet/';

// scripts/docs-index.mjs is plain JavaScript; this is the shape its navigation() returns.
const navigation = readNavigation as () => { title: string; pages: { path: string; title: string; description: string }[] }[];

interface Page { slug: string; file: string; title: string; description: string; html: string; headings: Heading[] }

/** `concepts/agent` for docs/concepts/agent.md, `README` for docs/README.md. */
const slugOf = (path: string) => relative(docsRoot, path).split(sep).join('/').replace(/\.md$/u, '');

/** A page's text split at its h2 and h3 headings, without code blocks: what search looks through. */
function searchSections(page: Page) {
  return page.html.split(/(?=<h[23] id=")/u).map(part => {
    const heading = /^<h[23] id="([^"]+)">([\s\S]*?)<\/h[23]>/u.exec(part);
    const body = heading ? part.slice(heading[0].length) : part;
    const text = textOf(body.replace(/<div class="code-block">[\s\S]*?<\/pre><\/div>/gu, ' ')).replace(/\s+/gu, ' ').trim();
    return {
      id: heading?.[1] ?? '',
      title: heading ? textOf(heading[2]!.replace(/<a class="heading-anchor"[^>]*>#<\/a>/u, '')).trim() : page.title,
      text: heading ? text : `${page.description} ${text}`.trim(),
    };
  }).filter(section => section.id || section.text);
}

export function docs({ base }: { base: string }): Plugin {
  const cache = new Map<string, Promise<Page>>();

  const page = (slug: string): Promise<Page> => {
    let rendered = cache.get(slug);
    if (!rendered) {
      const file = `${slug}.md`;
      const { title, description, body } = readPage(join(docsRoot, file));
      rendered = renderMarkdown(body, join(docsRoot, file), base).then(result => ({ slug, file: `docs/${file}`, title, description, ...result }));
      cache.set(slug, rendered);
    }
    return rendered;
  };

  const index = async () => {
    const sections = navigation().map(section => ({
      title: section.title,
      pages: section.pages.map(entry => ({ slug: slugOf(entry.path), title: entry.title, description: entry.description })),
    }));
    const slugs = ['README', ...sections.flatMap(section => section.pages.map(entry => entry.slug))];
    const loaders = slugs.map(slug => `  ${JSON.stringify(slug)}: () => import(${JSON.stringify(PAGE + slug)}),`).join('\n');
    return [
      `export const sections = ${JSON.stringify(sections)};`,
      `export const loaders = {\n${loaders}\n};`,
    ].join('\n');
  };

  const search = async () => {
    const entries = await Promise.all(navigation().flatMap(section => section.pages.map(async entry => {
      const rendered = await page(slugOf(entry.path));
      return searchSections(rendered).map(part => ({ slug: rendered.slug, page: rendered.title, section: section.title, ...part }));
    })));
    return `export default ${JSON.stringify(entries.flat())};`;
  };

  return {
    name: 'mayura-docs',
    resolveId(id) {
      if (id === INDEX || id === SEARCH || id.startsWith(PAGE) || id.startsWith(SNIPPET)) return `\0${id}`;
    },
    async load(id) {
      if (!id.startsWith('\0virtual:mayura-')) return;
      const name = id.slice(1);
      if (name === INDEX) {
        this.addWatchFile(join(docsRoot, 'README.md'));
        return index();
      }
      if (name === SEARCH) {
        this.addWatchFile(join(docsRoot, 'README.md'));
        return search();
      }
      if (name.startsWith(PAGE)) {
        const slug = name.slice(PAGE.length);
        this.addWatchFile(join(docsRoot, `${slug}.md`));
        return `export default ${JSON.stringify(await page(slug))};`;
      }
      if (name.startsWith(SNIPPET)) {
        const file = join(snippetsRoot, name.slice(SNIPPET.length));
        this.addWatchFile(file);
        const language = file.endsWith('.sh') ? 'bash' : 'ts';
        return `export default ${JSON.stringify(codeBlock(await getHighlighter(), readFileSync(file, 'utf8').replaceAll('\r\n', '\n'), language))};`;
      }
    },
    configureServer(server) {
      server.watcher.add([docsRoot, snippetsRoot]);
      server.watcher.on('change', file => {
        const path = resolve(file);
        if (!path.startsWith(docsRoot + sep) && !path.startsWith(snippetsRoot + sep)) return;
        cache.clear();
        for (const environment of Object.values(server.environments)) {
          for (const [id, module] of environment.moduleGraph.idToModuleMap) {
            if (id.startsWith('\0virtual:mayura-')) environment.moduleGraph.invalidateModule(module);
          }
        }
        server.ws.send({ type: 'full-reload' });
      });
    },
  };
}
