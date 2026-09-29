import { notFound } from '@tanstack/react-router';
import { loaders, type Article, type Section } from 'virtual:mayura-content';
import { absolute, pageMeta } from './site';

/** The sections of site/content, in the order the navigation lists them. */
export const sections: Record<Section, { title: string; heading: string; description: string; noun: string }> = {
  guides: {
    title: 'Guides', noun: 'guide',
    heading: 'Build something real',
    description: 'End-to-end tutorials: from an empty folder to a deployed agent, with the permissions, budgets and tests a production app needs.',
  },
  integrations: {
    title: 'Integrations', noun: 'integration',
    heading: 'Use Mayura with the tools you already have',
    description: 'Frameworks, platforms, databases and model providers: how Mayura fits with each, and what to watch for.',
  },
  compare: {
    title: 'Compare', noun: 'comparison',
    heading: 'How Mayura compares',
    description: 'Honest comparisons with other ways to build agents: what each is designed for, where they differ, and when to choose which.',
  },
  research: {
    title: 'Research', noun: 'paper',
    heading: 'How Mayura works, in depth',
    description: 'Long-form technical writing on the guarantees behind Mayura: durable execution, permissions and running everywhere.',
  },
};

export const sectionOrder: Section[] = ['guides', 'integrations', 'compare', 'research'];

/** `2026-09-29` as `September 29, 2026`, the same on the server and in every browser. */
export function formatDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[(month ?? 1) - 1]} ${day}, ${year}`;
}

/** An article's rendered page, or the not-found page for a slug that isn't one. */
export async function loadArticle(section: Section, slug: string): Promise<Article> {
  const load = loaders[`${section}/${slug.replace(/\/+$/u, '')}`];
  if (!load) throw notFound();
  return (await load()).default;
}

export const indexHead = (section: Section) => pageMeta({
  title: `${sections[section].title} · Mayura`, description: sections[section].description, path: `/${section}/`,
});

export function articleHead(article: Article | undefined) {
  if (!article) return { meta: [{ title: 'Page not found · Mayura' }, { name: 'robots', content: 'noindex' }] };
  const head = pageMeta({ title: `${article.title} · Mayura`, description: article.description, path: `/${article.section}/${article.slug}/` });
  return {
    ...head,
    meta: [
      ...head.meta.filter(entry => !('property' in entry && entry.property === 'og:type')),
      { property: 'og:type', content: 'article' },
      { property: 'article:published_time', content: article.date },
      ...(article.updated ? [{ property: 'article:modified_time', content: article.updated }] : []),
      { name: 'author', content: 'Mayura' },
    ],
    scripts: [{ type: 'application/ld+json', children: JSON.stringify({
      '@context': 'https://schema.org', '@type': article.section === 'research' ? 'TechArticle' : 'Article',
      headline: article.title, description: article.description, datePublished: article.date, dateModified: article.updated ?? article.date,
      url: absolute(`/${article.section}/${article.slug}/`), publisher: { '@type': 'Organization', name: 'Mayura' },
    }) }],
  };
}
