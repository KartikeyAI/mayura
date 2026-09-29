import { createFileRoute } from '@tanstack/react-router';
import { ArticleView } from '../../components/Articles';
import { articleHead, loadArticle } from '../../lib/content';

export const Route = createFileRoute('/research/$slug')({
  loader: ({ params }) => loadArticle('research', params.slug),
  head: ({ loaderData }) => articleHead(loaderData),
  component: () => <ArticleView article={Route.useLoaderData()} />,
});
