import { createFileRoute } from '@tanstack/react-router';
import { UiCatalog } from '../../components/UiCatalog';
import { pageMeta } from '../../lib/site';

export const Route = createFileRoute('/ui/')({
  head: () => pageMeta({
    title: 'UI gallery · Mayura',
    description: 'Explore interactive React components for agent conversations, run activity, approvals, and AG-UI.',
    path: '/ui/',
  }),
  component: UiCatalog,
});
