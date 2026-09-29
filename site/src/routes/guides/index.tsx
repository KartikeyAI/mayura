import { createFileRoute } from '@tanstack/react-router';
import { ArticleIndex } from '../../components/Articles';
import { indexHead } from '../../lib/content';

export const Route = createFileRoute('/guides/')({
  head: () => indexHead('guides'),
  component: () => <ArticleIndex section="guides" />,
});
