export const site = {
  name: 'Mayura',
  tagline: 'Build agents with a workspace',
  description: 'Build TypeScript agents with typed tools and durable workflows. Add a React and AG-UI workspace with '
    + 'streaming replies, inspectable citations and tool approvals.',
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
