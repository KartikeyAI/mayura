import { createFileRoute } from '@tanstack/react-router';
import { ArticleHub } from '../../components/Articles';
import { indexHead } from '../../lib/content';

// The hub, filtered to this kind; the old section addresses keep working.
export const Route = createFileRoute('/compare/')({
  head: () => indexHead('compare'),
  component: () => <ArticleHub initial="compare" />,
});
