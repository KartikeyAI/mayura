// Modules generated at build time by plugins/docs.ts.

declare module 'virtual:mayura-docs' {
  export interface NavPage { slug: string; title: string; description: string }
  export interface NavSection { title: string; pages: NavPage[] }
  export interface DocHeading { id: string; depth: 2 | 3; html: string; text: string }
  export interface DocPage { slug: string; file: string; title: string; description: string; html: string; headings: DocHeading[] }
  export const sections: NavSection[];
  export const loaders: Record<string, () => Promise<{ default: DocPage }>>;
}

declare module 'virtual:mayura-search' {
  /** One section of one page: `id` is its heading's anchor, empty for the text before the first heading. */
  export interface SearchEntry { slug: string; page: string; section: string; id: string; title: string; text: string }
  const entries: SearchEntry[];
  export default entries;
}

declare module 'virtual:mayura-snippet/*' {
  const html: string;
  export default html;
}

interface ImportMetaEnv {
  readonly SITE_ORIGIN: string;
  readonly MAYURA_VERSION: string;
}

declare module 'virtual:mayura-content' {
  export type Section = 'guides' | 'integrations' | 'compare' | 'research';
  export interface ArticleSummary {
    section: Section; slug: string; title: string; description: string; date: string; updated?: string; tags: string[]; minutes: number;
  }
  export interface ArticleHeading { id: string; depth: 2 | 3; html: string; text: string }
  export interface Article extends ArticleSummary { file: string; html: string; headings: ArticleHeading[] }
  /** Every section's articles, newest first. */
  export const articles: Record<Section, ArticleSummary[]>;
  /** One loader per article, keyed `<section>/<slug>`. */
  export const loaders: Record<string, () => Promise<{ default: Article }>>;
}
