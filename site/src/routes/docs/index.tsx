import { createFileRoute } from '@tanstack/react-router';
import { loaders } from 'virtual:mayura-docs';
import { DocView } from '../../components/DocView';
import { pageMeta } from '../../lib/site';

export const Route = createFileRoute('/docs/')({
  loader: async () => (await loaders['README']!()).default,
  head: () => pageMeta({
    title: 'Documentation · Mayura',
    description: 'Every page of the Mayura documentation: concepts, guides, the CLI and the reference.',
    path: '/docs/',
  }),
  component: DocsIndex,
});

function DocsIndex() {
  return <DocView page={Route.useLoaderData()} />;
}
