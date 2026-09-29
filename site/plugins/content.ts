// A Vite plugin that serves the articles in site/content/<section>/<slug>.md (guides, integrations, comparisons and
// research) to the site as modules:
//   virtual:mayura-content            every section's articles, newest first, and a lazy loader per article
//   virtual:mayura-article/<s>/<slug>  one rendered article: { section, slug, file, title, description, date, ... }
// Frontmatter: title, description and date (YYYY-MM-DD) are required; updated (YYYY-MM-DD) and tags (comma-separated)
// are optional. Articles link to docs pages and to each other by relative path, as docs pages do; the build turns those
// links into site routes and scripts/docs-check.mjs checks them and type-checks the TypeScript in them.
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';
import { readPage } from '../../scripts/docs-index.mjs';
import { contentRoot, renderMarkdown, type Heading } from './markdown.ts';

export const SECTIONS = ['guides', 'integrations', 'compare', 'research'] as const;

const INDEX = 'virtual:mayura-content';
const ARTICLE = 'virtual:mayura-article/';

interface Summary { section: string; slug: string; title: string; description: string; date: string; updated?: string; tags: string[]; minutes: number }
interface Article extends Summary { file: string; html: string; headings: Heading[] }

const readFields = readPage as (path: string) => Record<string, string> & { title: string; description: string; body: string };

function read(section: string, slug: string): { summary: Summary; body: string; path: string } {
  const path = join(contentRoot, section, `${slug}.md`);
  const fields = readFields(path);
  for (const key of ['title', 'description', 'date']) if (!fields[key]) throw new Error(`site/content/${section}/${slug}.md: missing frontmatter ${key}`);
  for (const key of ['date', 'updated']) if (fields[key] && !/^\d{4}-\d{2}-\d{2}$/u.test(fields[key]!)) throw new Error(`site/content/${section}/${slug}.md: ${key} must be YYYY-MM-DD`);
  const words = fields.body.replace(/```[\s\S]*?```/gu, ' ').split(/\s+/u).filter(Boolean).length;
  return {
    path, body: fields.body,
    summary: {
      section, slug, title: fields.title, description: fields.description, date: fields['date']!,
      ...(fields['updated'] ? { updated: fields['updated'] } : {}),
      tags: (fields['tags'] ?? '').split(',').map(tag => tag.trim()).filter(Boolean),
      minutes: Math.max(1, Math.round(words / 220)),
    },
  };
}

const slugs = (section: string) => existsSync(join(contentRoot, section))
  ? readdirSync(join(contentRoot, section)).filter(name => name.endsWith('.md')).map(name => name.slice(0, -3)).sort()
  : [];

export function content({ base }: { base: string }): Plugin {
  const cache = new Map<string, Promise<Article>>();
  const article = (section: string, slug: string): Promise<Article> => {
    const key = `${section}/${slug}`;
    let rendered = cache.get(key);
    if (!rendered) {
      const { summary, body, path } = read(section, slug);
      rendered = renderMarkdown(body, path, base).then(result => ({ ...summary, file: `site/content/${key}.md`, ...result }));
      cache.set(key, rendered);
    }
    return rendered;
  };

  const index = () => {
    const sections = Object.fromEntries(SECTIONS.map(section => [section,
      slugs(section).map(slug => read(section, slug).summary).sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title))]));
    const loaders = SECTIONS.flatMap(section => slugs(section).map(slug =>
      `  ${JSON.stringify(`${section}/${slug}`)}: () => import(${JSON.stringify(`${ARTICLE}${section}/${slug}`)}),`)).join('\n');
    return `export const articles = ${JSON.stringify(sections)};\nexport const loaders = {\n${loaders}\n};`;
  };

  return {
    name: 'mayura-content',
    resolveId(id) { if (id === INDEX || id.startsWith(ARTICLE)) return `\0${id}`; },
    async load(id) {
      if (id === `\0${INDEX}`) {
        for (const section of SECTIONS) for (const slug of slugs(section)) this.addWatchFile(join(contentRoot, section, `${slug}.md`));
        return index();
      }
      if (id.startsWith(`\0${ARTICLE}`)) {
        const [section = '', slug = ''] = id.slice(ARTICLE.length + 1).split('/');
        this.addWatchFile(join(contentRoot, section, `${slug}.md`));
        return `export default ${JSON.stringify(await article(section, slug))};`;
      }
    },
    configureServer(server) {
      server.watcher.add(contentRoot);
      server.watcher.on('all', (_event, file) => {
        if (!resolve(file).startsWith(contentRoot + sep)) return;
        cache.clear();
        for (const environment of Object.values(server.environments)) {
          for (const [id, module] of environment.moduleGraph.idToModuleMap) {
            if (id.startsWith('\0virtual:mayura-content') || id.startsWith('\0virtual:mayura-article/')) environment.moduleGraph.invalidateModule(module);
          }
        }
        server.ws.send({ type: 'full-reload' });
      });
    },
  };
}
