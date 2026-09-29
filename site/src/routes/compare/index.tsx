import { createFileRoute } from '@tanstack/react-router';
import { ArticleIndex } from '../../components/Articles';
import { indexHead } from '../../lib/content';

export const Route = createFileRoute('/compare/')({
  head: () => indexHead('compare'),
  component: () => <ArticleIndex section="compare" />,
});
