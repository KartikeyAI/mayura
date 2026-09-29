import { createFileRoute } from '@tanstack/react-router';
import { ArticleIndex } from '../../components/Articles';
import { indexHead } from '../../lib/content';

export const Route = createFileRoute('/integrations/')({
  head: () => indexHead('integrations'),
  component: () => <ArticleIndex section="integrations" />,
});
