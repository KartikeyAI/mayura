import { createFileRoute } from '@tanstack/react-router';
import { ArticleView } from '../../components/Articles';
import { articleHead, loadArticle } from '../../lib/content';

export const Route = createFileRoute('/compare/$slug')({
  loader: ({ params }) => loadArticle('compare', params.slug),
  head: ({ loaderData }) => articleHead(loaderData),
  component: () => <ArticleView article={Route.useLoaderData()} />,
});
