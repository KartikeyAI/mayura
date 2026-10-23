import { createFileRoute, Link } from '@tanstack/react-router';
import { pageMeta, site } from '../../lib/site';

export const Route = createFileRoute('/roadmap/')({
  head: () => pageMeta({
    title: 'Roadmap · Mayura',
    description: 'What Mayura has shipped, what comes next and what is planned later. Themes, not dates: plans may change.',
    path: '/roadmap/',
  }),
  component: Roadmap,
});

interface Stage { label: string; title: string; status: 'shipped' | 'next' | 'later'; summary: string; items: { title: string; text: string }[] }

const stages: Stage[] = [
  {
    label: '1.0', title: 'A framework you can put in production', status: 'shipped',
    summary: 'The first stable release: every entry point covered by SemVer.',
    items: [
      { title: 'Agents and tools', text: 'Typed agents and tools, explicit permissions, hard cost budgets and validated inputs and outputs.' },
      { title: 'Durable workflows', text: 'Steps, approvals, timers, signals, sagas and loops that survive restarts, on SQLite or PostgreSQL.' },
      { title: 'Serve and operate', text: 'An HTTP server, a browser client, React components, an operator console and the CLI.' },
    ],
  },
  {
    label: '1.1', title: 'Connect it to everything', status: 'shipped',
    summary: 'A model registry, new capabilities and 85 integration packages.',
    items: [
      { title: 'Models', text: 'A model registry with dated prices and fallback chains, and eight provider packages.' },
      { title: 'Agents that act', text: 'Sandboxes, browsers, voice and file storage, each with hosted provider packages.' },
      { title: 'Production plumbing', text: 'Sign-in providers, API keys, seven databases, tracing services and mayura deploy.' },
      { title: 'Edge runtimes', text: 'Cloudflare Workers, Vercel Edge Functions, Deno and Bun.' },
    ],
  },
  {
    label: '1.2', title: 'From backend to product', status: 'shipped',
    summary: 'Published October 23, 2026: conversations, authorization, six framework starters and 105 extensions.',
    items: [
      { title: 'Conversations', text: 'Threads that keep chat history in your own database, runs that pause for a person to approve a tool call, and handoffs between agents.' },
      { title: 'Authorization', text: 'Who may run which agent, tool or workflow and see which data, with role-based access and external policy services.' },
      { title: 'Framework starters', text: 'mayura init projects for Next.js, Hono, React Router, TanStack Start, SvelteKit and Nuxt.' },
      { title: 'UI components', text: 'React thread history, approvals and run controls as source you own; headless stores for Svelte and Vue.' },
      { title: 'Agent UI protocols · experimental', text: 'A bounded AG-UI adapter with run events, state updates, approval interrupts and durable frontend-tool claims. Reference-client and browser qualification remains outstanding.' },
      { title: 'AI gateways', text: 'Vercel AI Gateway, Cloudflare AI Gateway, OpenRouter, Portkey, Helicone and LiteLLM, each an optional package.' },
      { title: 'Retrieval (RAG) · experimental', text: 'Scoped document ingestion, embeddings, vector adapters, citations, reranking and offline evaluation. Real-service interoperability remains unqualified.' },
    ],
  },
  {
    label: 'Next', title: 'Qualify more real-world paths', status: 'next',
    summary: 'Priorities for broader qualification, without promised delivery dates.',
    items: [
      { title: 'External services', text: 'Paid providers and gateways, real authorization policies, and vector/reranker services under deployment conditions.' },
      { title: 'Browser and client interoperability', text: 'Rendered starter flows, accessibility, AG-UI reference clients and CopilotKit compatibility.' },
      { title: 'Deployment profiles', text: 'Live framework deployments and the Hono-specific Bun, Deno and Workers/D1 application paths.' },
    ],
  },
  {
    label: 'Later', title: 'Further out', status: 'later',
    summary: 'Planned after that, in no fixed order.',
    items: [
      { title: 'Realtime voice', text: 'Speech-to-speech conversations, with the same prices and bounds as the voice registry.' },
      { title: 'A workflow builder', text: 'A fluent way to write durable workflows, compiled to the same guarantees.' },
    ],
  },
];

const badge: Record<Stage['status'], string> = {
  shipped: 'bg-primary/10 text-primary',
  next: 'bg-fg text-bg',
  later: 'border border-line text-muted',
};
const badgeText: Record<Stage['status'], string> = { shipped: 'Shipped', next: 'Next', later: 'Later' };

function Roadmap() {
  return (
    <main className="px-4 py-16 sm:px-6 sm:py-20">
      <div className="mx-auto max-w-4xl">
        <p className="text-sm font-medium text-primary">Roadmap</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-[-0.035em] text-balance sm:text-5xl">Where Mayura is going</h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-pretty text-muted">
          What has shipped, what comes next and what is planned after that. These are themes, not promises or dates:
          plans change as we learn. Every release keeps the same rules: nothing allowed by default, a hard budget on
          every run, and semantic versioning for documented stable APIs. Experimental profiles keep their stated limits.
        </p>

        <ol className="relative mt-14 space-y-12 border-l border-line pl-8">
          {stages.map(stage => (
            <li key={stage.label} className="relative">
              <span aria-hidden="true" className={`absolute top-1.5 -left-[2.4rem] size-3.5 rounded-full border-2 border-bg ${stage.status === 'shipped' ? 'bg-primary' : stage.status === 'next' ? 'bg-fg' : 'bg-line'}`} />
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm text-muted">{stage.label}</span>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${badge[stage.status]}`}>{badgeText[stage.status]}</span>
              </div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight">{stage.title}</h2>
              <p className="mt-1 text-muted">{stage.summary}</p>
              <ul className="mt-5 grid gap-3 sm:grid-cols-2">
                {stage.items.map(item => (
                  <li key={item.title} className="rounded-2xl border border-line bg-raised p-5">
                    <h3 className="font-semibold tracking-tight">{item.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-pretty text-muted">{item.text}</p>
                  </li>
                ))}
              </ul>
              {stage.label === '1.1' && (
                <p className="mt-4 text-sm">
                  <Link to="/docs/$/" params={{ _splat: 'project/whats-new' }} hash="mayura-11" className="font-medium text-primary hover:underline">Mayura 1.1 history</Link>
                  <span className="text-muted"> · </span>
                  <Link to="/integrations/" className="font-medium text-primary hover:underline">Browse the integrations</Link>
                </p>
              )}
              {stage.label === '1.2' && (
                <p className="mt-4 text-sm"><Link to="/docs/$/" params={{ _splat: 'project/whats-new' }} className="font-medium text-primary hover:underline">What’s new in 1.2</Link>
                  <span className="text-muted"> · </span><Link to="/docs/$/" params={{ _splat: 'guides/release-readiness' }} className="font-medium text-primary hover:underline">Release evidence and limits</Link></p>
              )}
            </li>
          ))}
        </ol>

        <div className="mt-16 rounded-2xl border border-line bg-soft/60 p-6 sm:p-8">
          <h2 className="text-lg font-semibold tracking-tight">Tell us what you need</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            The roadmap follows what people build with Mayura. Open an issue for an integration, a feature or a problem
            you hit, or comment on one that is already there.
          </p>
          <a href={`${site.repository}/issues`} target="_blank" rel="noopener noreferrer"
            className="mt-4 inline-flex rounded-lg bg-fg px-3.5 py-2 text-sm font-medium text-bg transition hover:opacity-85">
            Open an issue on GitHub
          </a>
        </div>
      </div>
    </main>
  );
}
