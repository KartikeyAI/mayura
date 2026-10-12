import { createFileRoute } from '@tanstack/react-router';
import { ArticleHub } from '../../components/Articles';
import { pageMeta } from '../../lib/site';

export const Route = createFileRoute('/articles/')({
  head: () => pageMeta({
    title: 'Articles · Mayura',
    description: 'Guides, integration guides, comparisons and research on building production AI agents with Mayura.',
    path: '/articles/',
  }),
  component: () => <ArticleHub />,
});
