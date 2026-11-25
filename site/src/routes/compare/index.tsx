import { Link, createFileRoute } from '@tanstack/react-router';
import { articles } from 'virtual:mayura-content';
import { Icon } from '../../components/Icon';
import { indexHead } from '../../lib/content';

export const Route = createFileRoute('/compare/')({
  head: () => indexHead('compare'),
  component: Comparisons,
});

function Comparisons() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
      <h1 className="max-w-3xl text-4xl font-semibold tracking-[-0.035em] text-balance sm:text-5xl">
        How Mayura compares
      </h1>
      <p className="mt-4 max-w-2xl text-lg leading-relaxed text-pretty text-muted">
        Compare Mayura 1.4 with four TypeScript agent stacks. See where each handles streaming and UI, and how each
        approaches approvals, budgets, and recovery when a tool can change something outside the app.
      </p>
      <ul className="mt-10 grid gap-4 sm:grid-cols-2" aria-label="Framework comparisons">
        {articles.compare.map(({ slug, title, description }) => (
          <li key={slug}>
            <Link to="/compare/$slug/" params={{ slug }}
              className="group block h-full rounded-2xl border border-line bg-raised p-6 transition hover:border-muted/40 sm:p-7">
              <div className="flex items-start justify-between gap-4">
                <h2 className="text-xl font-semibold tracking-tight text-balance group-hover:text-primary">{title}</h2>
                <Icon name="arrow" className="mt-1 size-4 shrink-0 text-muted group-hover:text-primary" />
              </div>
              <p className="mt-3 text-sm leading-relaxed text-pretty text-muted">{description}</p>
            </Link>
          </li>
        ))}
      </ul>
      <section className="mt-12 max-w-2xl" aria-labelledby="keep-your-backend">
        <h2 id="keep-your-backend" className="text-xl font-semibold tracking-tight">Already have an agent backend?</h2>
        <p className="mt-2 leading-relaxed text-pretty text-muted">
          Mayura UI runs in React 19 with your data and callbacks. Agent Workspace streams through an AG-UI transport
          you supply. Your backend still owns authentication, approvals, and tool execution.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-medium">
          <Link to="/ui/$slug/" params={{ slug: 'chat-workspace' }} className="text-primary hover:underline">
            Explore Agent Workspace
          </Link>
          <Link to="/docs/$/" params={{ _splat: 'integrations/ui' }} className="text-primary hover:underline">
            Install Mayura UI
          </Link>
        </div>
      </section>
    </main>
  );
}
