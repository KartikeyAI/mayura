export const site = {
  name: 'Mayura',
  tagline: 'Build AI agents you can put in production',
  description: 'Mayura is a TypeScript framework for AI agents, typed tools and durable workflows. Explicit permissions, '
    + 'cost limits on every run, schemas at every boundary, and workflows that survive restarts.',
  origin: import.meta.env.SITE_ORIGIN,
  version: import.meta.env.MAYURA_VERSION,
  repository: 'https://github.com/KartikeyAI/mayura',
  npm: 'https://www.npmjs.com/package/mayura',
};

/** A path under the site's base: `asset('favicon.svg')` is `/favicon.svg` on mayurajs.com, `/mayura/favicon.svg` on github.io. */
export const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`;

/** The absolute URL of a route, for canonical links and social cards. */
export const absolute = (path: string) => `${site.origin}${import.meta.env.BASE_URL.replace(/\/$/u, '')}${path}`;

/** Title, description and social tags for a page's `head()`. */
export function pageMeta({ title, description, path }: { title: string; description: string; path: string }) {
  return {
    meta: [
      { title },
      { name: 'description', content: description },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:type', content: 'website' },
      { property: 'og:url', content: absolute(path) },
      { property: 'og:site_name', content: site.name },
      { name: 'twitter:card', content: 'summary' },
    ],
    links: [{ rel: 'canonical', href: absolute(path) }],
  };
}
