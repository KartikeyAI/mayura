import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '../components/NotFound';

// Prerendered, then moved to /404.html, which GitHub Pages serves for any path that has no page.
export const Route = createFileRoute('/not-found')({
  head: () => ({ meta: [{ title: 'Page not found · Mayura' }, { name: 'robots', content: 'noindex' }] }),
  component: NotFound,
});
