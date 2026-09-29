import { createFileRoute } from '@tanstack/react-router';
import { ArticleView } from '../../components/Articles';
import { articleHead, loadArticle } from '../../lib/content';

export const Route = createFileRoute('/guides/$slug')({
  loader: ({ params }) => loadArticle('guides', params.slug),
  head: ({ loaderData }) => articleHead(loaderData),
  component: () => <ArticleView article={Route.useLoaderData()} />,
});
