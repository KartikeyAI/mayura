import { createFileRoute, notFound } from '@tanstack/react-router';
import { UiComponentDetail } from '../../components/UiComponentDetail';
import { pageMeta } from '../../lib/site';
import { uiCatalog } from '../../lib/ui-catalog';

export const Route = createFileRoute('/ui/$slug')({
  loader: ({ params }) => {
    const component = uiCatalog.find(item => item.slug === params.slug);
    if (!component) throw notFound();
    return component.slug;
  },
  head: ({ loaderData }) => {
    const component = uiCatalog.find(item => item.slug === loaderData);
    if (!component) return {};
    return pageMeta({
      title: `${component.title} · Mayura UI`,
      description: component.description,
      path: `/ui/${component.slug}/`,
    });
  },
  component: Detail,
});

function Detail() {
  const slug = Route.useLoaderData();
  if (!slug) throw notFound();
  return <UiComponentDetail key={slug} slug={slug} />;
}
