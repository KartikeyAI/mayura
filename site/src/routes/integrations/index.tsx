import { createFileRoute } from '@tanstack/react-router';
import { Directory } from '../../components/Directory';
import { pageMeta } from '../../lib/site';

export const Route = createFileRoute('/integrations/')({
  head: () => pageMeta({
    title: 'Integrations · Mayura',
    description: 'Explore Mayura integrations: model providers, AI gateways, authorization, retrieval, databases, voice, observability, deployment and framework starter guides.',
    path: '/integrations/',
  }),
  component: Directory,
});
