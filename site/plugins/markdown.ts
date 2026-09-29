// Markdown to HTML for the docs pages, at build time. Code is highlighted here with Shiki, so no highlighter ships to
// the browser. Links between docs pages become site routes, and headings get the same anchors GitHub gives them (the
// anchors scripts/docs-check.mjs verifies), so a `page.md#section` link works in the repository and on the site.
import { posix } from 'node:path';
import { Marked, type Tokens } from 'marked';
import { createHighlighter, type Highlighter } from 'shiki';

export interface Heading { id: string; depth: 2 | 3; html: string; text: string }
export interface RenderedPage { html: string; headings: Heading[] }

const languages = ['ts', 'tsx', 'js', 'bash', 'json', 'yaml', 'toml', 'ini', 'dockerfile', 'markdown'];
const plain = new Set(['', 'text', 'txt', 'plaintext']);
let highlighter: Promise<Highlighter> | undefined;

export function getHighlighter(): Promise<Highlighter> {
  highlighter ??= createHighlighter({ themes: ['github-light', 'github-dark'], langs: languages });
  return highlighter;
}

/** Highlighted code as HTML. Colors are CSS variables (--shiki-light, --shiki-dark) that the theme switches between. */
export function highlight(shiki: Highlighter, code: string, language: string): string {
  const lang = plain.has(language) || !shiki.getLoadedLanguages().includes(language) ? 'text' : language;
  return shiki.codeToHtml(code.replace(/\n$/u, ''), {
    lang, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false,
  });
}

/** A code block with a language label and a copy button (the button is wired up in the browser). */
export function codeBlock(shiki: Highlighter, code: string, language: string): string {
  const label = plain.has(language) ? '' : `<span class="code-lang">${escapeHtml(language)}</span>`;
  return `<div class="code-block">${label}<button type="button" class="code-copy" data-copy aria-label="Copy code">Copy</button>`
    + `${highlight(shiki, code, language)}</div>`;
}

/** GitHub's heading anchors, numbered on repeats; the same rules as scripts/docs-check.mjs. */
export function slugger(): (heading: string) => string {
  const seen = new Map<string, number>();
  return heading => {
    const base = heading.replace(/`/gu, '').replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1').trim().toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '').replace(/\s/gu, '-');
    const count = seen.get(base) ?? 0; seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  };
}

/** The route of a docs page: docs/README.md is `docs/`, docs/concepts/agent.md is `docs/concepts/agent/`. */
export function pageRoute(slug: string): string {
  return slug === 'README' ? 'docs/' : `docs/${slug}/`;
}

/**
 * Renders one page. `file` is the page's path inside docs/ (`concepts/agent.md`); `base` is the site's public base
 * path, with a trailing slash.
 */
export async function renderMarkdown(markdown: string, file: string, base: string): Promise<RenderedPage> {
  const shiki = await getHighlighter();
  const headings: Heading[] = [];
  const anchor = slugger();

  const rewrite = (href: string): string => {
    if (/^[a-z][a-z\d+.-]*:/iu.test(href) || href.startsWith('#')) return href;
    const [path = '', hash] = href.split('#', 2);
    if (!path.endsWith('.md')) return href;
    const target = posix.normalize(posix.join(posix.dirname(file), path));
    if (target.startsWith('../')) return href;
    return `${base}${pageRoute(target.slice(0, -3))}${hash ? `#${hash}` : ''}`;
  };

  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth, text }: Tokens.Heading) {
        const id = anchor(text);
        const inner = this.parser.parseInline(tokens);
        if (depth === 2 || depth === 3) headings.push({ id, depth, html: inner, text: textOf(inner) });
        return `<h${depth} id="${id}"><a class="heading-anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        return codeBlock(shiki, text, (lang ?? '').trim().split(/\s/u)[0]!.toLowerCase());
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const target = rewrite(href);
        const external = /^https?:/u.test(target);
        return `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ''}`
          + `${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inner}</a>`;
      },
    },
  });

  const html = (await marked.parse(markdown))
    .replaceAll('<table>', '<div class="table-wrap"><table>').replaceAll('</table>', '</table></div>');
  return { html, headings };
}

const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
/** Plain text of an inline HTML fragment, for search. */
export function textOf(html: string): string {
  return html.replace(/<[^>]+>/gu, '').replace(/&(?:amp|lt|gt|quot|#39);/gu, entity => entities[entity]!);
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, char => `&#${char.charCodeAt(0)};`);
}
