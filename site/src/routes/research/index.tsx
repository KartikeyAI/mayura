import { createFileRoute } from '@tanstack/react-router';
import { ArticleIndex } from '../../components/Articles';
import { indexHead } from '../../lib/content';

export const Route = createFileRoute('/research/')({
  head: () => indexHead('research'),
  component: () => <ArticleIndex section="research" />,
});
