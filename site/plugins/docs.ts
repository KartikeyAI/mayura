// A Vite plugin that serves the repository's docs/ folder to the site as modules:
//   virtual:mayura-docs            the navigation (from docs/README.md, via scripts/docs-index.mjs) and a lazy
//                                  loader per page
//   virtual:mayura-search          the text of every section of every page, loaded when someone opens search
//   virtual:mayura-doc/<slug>      one rendered page: { slug, file, title, description, html, headings }
//   virtual:mayura-snippet/<name>  a highlighted file from site/snippets/, for the landing page
//   virtual:mayura-ui-sources      original UI source and highlighted TSX/CSS/install commands for the gallery
//   virtual:mayura-ui-detail-code  highlighted examples and package source for component details
//   virtual:mayura-ui-package.css  the scoped stylesheet used by the published package
// Everything is rendered at build time; development watches repository source and Markdown.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { format } from 'prettier';
import type { Plugin } from 'vite';
import { compileUiStyles } from '../../extensions/ui/scripts/build-styles.mjs';
import { navigation as readNavigation, readPage } from '../../scripts/docs-index.mjs';
import { uiCatalog } from '../src/lib/ui-catalog.ts';
import { codeBlock, getHighlighter, highlight, renderMarkdown, textOf, type Heading } from './markdown.ts';

const site = resolve(import.meta.dirname, '..');
const docsRoot = resolve(site, '../docs');
const snippetsRoot = resolve(site, 'snippets');
const uiRoot = resolve(site, '../packages/cli/ui');
const legacyStylesId = join(uiRoot, 'ui.css').split(sep).join('/');
const packageUiRoot = resolve(site, '../extensions/ui');
const packageSourceRoot = join(packageUiRoot, 'src');
const packageStyleRoot = join(packageUiRoot, 'styles');

const INDEX = 'virtual:mayura-docs';
const SEARCH = 'virtual:mayura-search';
const PAGE = 'virtual:mayura-doc/';
const SNIPPET = 'virtual:mayura-snippet/';
const UI_SOURCES = 'virtual:mayura-ui-sources';
const UI_DETAIL_CODE = 'virtual:mayura-ui-detail-code';
const UI_PACKAGE_STYLE = 'virtual:mayura-ui-package.css';
const uiFormat = { printWidth: 90, tabWidth: 2, singleQuote: true, trailingComma: 'all', semi: true, endOfLine: 'lf' } as const;

/** Both libraries use `.mayura-ui`. Keep their site previews isolated even after route styles are loaded together. */
const scopeUiStyles = (css: string, gallery: string) => css.replace(/\.mayura-ui(?![-\w])/gu, `${gallery} .mayura-ui`);

// scripts/docs-index.mjs is plain JavaScript; this is the shape its navigation() returns.
const navigation = readNavigation as () => { title: string; pages: { path: string; title: string; description: string }[] }[];

/** What an integration page (docs/integrations/*.md) adds to its frontmatter: the package, the vendor and its logo. */
interface Integration { package: string; vendor: string; logo: string; website: string; area: string }
interface Page { slug: string; file: string; title: string; description: string; html: string; headings: Heading[]; integration?: Integration }

/** A page's integration fields, when its frontmatter names a package. */
function integrationOf(fields: Record<string, string>): Integration | undefined {
  if (!fields['package']) return undefined;
  return { package: fields['package'], vendor: fields['vendor'] ?? '', logo: fields['logo'] ?? '', website: fields['website'] ?? '', area: fields['area'] ?? '' };
}

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
  let packageStyles: Promise<string> | undefined;

  const page = (slug: string): Promise<Page> => {
    let rendered = cache.get(slug);
    if (!rendered) {
      const file = `${slug}.md`;
      const { title, description, body, ...fields } = readPage(join(docsRoot, file)) as ReturnType<typeof readPage> & Record<string, string>;
      const integration = integrationOf(fields);
      rendered = renderMarkdown(body, join(docsRoot, file), base)
        .then(result => ({ slug, file: `docs/${file}`, title, description, ...result, ...(integration ? { integration } : {}) }));
      cache.set(slug, rendered);
    }
    return rendered;
  };

  const index = async () => {
    const sections = navigation().map(section => ({
      title: section.title,
      pages: section.pages.map(entry => {
        const integration = integrationOf(entry as unknown as Record<string, string>);
        return { slug: slugOf(entry.path), title: entry.title, description: entry.description, ...(integration ? { integration } : {}) };
      }),
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

  const detailCode = async (watchFile: (path: string) => void) => {
    const shiki = await getHighlighter();
    const sources = await Promise.all([...new Set(uiCatalog.map(entry => entry.sourceFile))].map(async file => {
      const path = join(packageSourceRoot, file);
      watchFile(path);
      const source = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
      const formatted = await format(source, { ...uiFormat, filepath: path, parser: 'typescript' });
      return [file, { source, sourceHtml: highlight(shiki, formatted, file.endsWith('.tsx') ? 'tsx' : 'ts') }];
    }));
    const snippets = await Promise.all(uiCatalog.map(async ({ slug, sourceFile, usage, registryImports }) => {
      const [formattedUsage, formattedImports] = await Promise.all([
        format(usage, { ...uiFormat, parser: 'typescript' }),
        format(registryImports, { ...uiFormat, parser: 'typescript' }),
      ]);
      return [slug, sourceFile, highlight(shiki, formattedUsage, 'tsx'), highlight(shiki, formattedImports, 'tsx')];
    }));
    // A component file can back multiple detail pages. Serialize its highlighted source only once.
    return `const sources = ${JSON.stringify(Object.fromEntries(sources))};\n`
      + `const snippets = ${JSON.stringify(snippets)};\n`
      + 'export default Object.fromEntries(snippets.map(([slug, file, usageHtml, registryImportsHtml]) => '
      + '[slug, { ...sources[file], usageHtml, registryImportsHtml }]));';
  };

  return {
    name: 'mayura-docs',
    resolveId(id) {
      if ([INDEX, SEARCH, UI_SOURCES, UI_DETAIL_CODE, UI_PACKAGE_STYLE].includes(id) || id.startsWith(PAGE) || id.startsWith(SNIPPET)) return `\0${id}`;
    },
    async load(id) {
      if (id === legacyStylesId) return scopeUiStyles(readFileSync(id, 'utf8'), ':where(.ui-gallery)');
      if (!id.startsWith('\0virtual:mayura-')) return;
      const name = id.slice(1);
      if (name === UI_SOURCES) {
        // Format and tokenize trusted repository source at build time; copy actions retain the original file.
        const shiki = await getHighlighter();
        const entries = await Promise.all(readdirSync(uiRoot).filter(file => /\.(?:tsx|css)$/u.test(file)).sort().map(async file => {
          const path = join(uiRoot, file);
          this.addWatchFile(path);
          const source = readFileSync(path, 'utf8');
          const language = file.endsWith('.css') ? 'css' : 'tsx';
          const formatted = await format(source, { ...uiFormat, filepath: path, parser: language === 'css' ? 'css' : 'typescript' });
          const command = `mayura add ui ${file.slice(0, -4)} --directory ./my-app --apply`;
          return [file, { source, html: highlight(shiki, formatted, language),
            commandHtml: language === 'tsx' ? highlight(shiki, command, 'bash') : '' }];
        }));
        return `export default ${JSON.stringify(Object.fromEntries(entries))};`;
      }
      if (name === UI_DETAIL_CODE) return detailCode(path => this.addWatchFile(path));
      if (name === UI_PACKAGE_STYLE) {
        for (const root of [packageSourceRoot, packageStyleRoot]) {
          for (const file of readdirSync(root, { encoding: 'utf8', recursive: true })) {
            if (/\.(?:tsx?|css|mjs)$/u.test(file)) this.addWatchFile(join(root, file));
          }
        }
        packageStyles ??= compileUiStyles({ toolchainFrom: join(site, 'package.json') })
          .then(css => scopeUiStyles(css, '.ui-library'));
        return packageStyles;
      }
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
      const watchedRoots = [docsRoot, snippetsRoot, uiRoot, packageSourceRoot, packageStyleRoot];
      server.watcher.add(watchedRoots);
      server.watcher.on('all', (_event, file) => {
        const path = resolve(file);
        if (!watchedRoots.some(root => path.startsWith(root + sep))) return;
        if (path.startsWith(packageUiRoot + sep)) packageStyles = undefined;
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
