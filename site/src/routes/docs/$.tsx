import { createFileRoute, notFound } from '@tanstack/react-router';
import { loaders } from 'virtual:mayura-docs';
import { DocView } from '../../components/DocView';
import { pageMeta } from '../../lib/site';

export const Route = createFileRoute('/docs/$')({
  loader: async ({ params }) => {
    const slug = (params._splat ?? '').replace(/\/+$/u, '');
    const load = slug === 'README' ? undefined : loaders[slug];
    if (!load) throw notFound();
    return (await load()).default;
  },
  head: ({ loaderData }) => loaderData
    ? pageMeta({ title: `${loaderData.title} · Mayura`, description: loaderData.description, path: `/docs/${loaderData.slug}/` })
    : { meta: [{ title: 'Page not found · Mayura' }, { name: 'robots', content: 'noindex' }] },
  component: DocRoute,
});

function DocRoute() {
  return <DocView page={Route.useLoaderData()} />;
}
