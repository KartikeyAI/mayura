import { createFileRoute } from '@tanstack/react-router';
import { Directory } from '../../components/Directory';
import { pageMeta } from '../../lib/site';

export const Route = createFileRoute('/integrations/')({
  head: () => pageMeta({
    title: 'Integrations · Mayura',
    description: 'Every service Mayura connects to: model providers, voice, databases, file storage, observability, sandboxes, browsers, sign-in, API keys and deploy targets.',
    path: '/integrations/',
  }),
  component: Directory,
});
