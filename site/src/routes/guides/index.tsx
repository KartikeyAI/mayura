import { createFileRoute } from '@tanstack/react-router';
import { ArticleHub } from '../../components/Articles';
import { indexHead } from '../../lib/content';

// The hub, filtered to this kind; the old section addresses keep working.
export const Route = createFileRoute('/guides/')({
  head: () => indexHead('guides'),
  component: () => <ArticleHub initial="guides" />,
});
