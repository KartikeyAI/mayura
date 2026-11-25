import { createFileRoute, Link } from '@tanstack/react-router';
import { Icon } from '../../components/Icon';
import { UiGallery } from '../../components/UiGallery';
import { pageMeta } from '../../lib/site';

export const Route = createFileRoute('/ui/copy-in')({
  head: () => pageMeta({
    title: 'Mayura CLI copy-in components · Mayura',
    description: 'Preview and inspect the source components installed with the Mayura CLI.',
    path: '/ui/copy-in/',
  }),
  component: CopyIn,
});

function CopyIn() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <Link to="/ui/" className="inline-flex items-center gap-2 text-sm text-muted hover:text-fg">
        <Icon name="arrow" className="size-4 rotate-180" /> UI gallery
      </Link>
      <h1 className="mt-6 text-4xl font-semibold tracking-tight">Mayura CLI copy-in</h1>
      <p className="mt-3 mb-10 max-w-xl text-muted">
        Explore the original components installed with <code className="text-sm">mayura add ui</code>.
        The previews use local fixtures.
      </p>
      <UiGallery />
    </main>
  );
}
