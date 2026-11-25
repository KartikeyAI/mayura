import { createFileRoute, Link } from '@tanstack/react-router';
import { pageMeta, site } from '../../lib/site';

export const Route = createFileRoute('/roadmap/')({
  head: () => pageMeta({
    title: 'Roadmap · Mayura',
    description: 'See what shipped in Mayura 1.4 and what we plan to qualify next across agent UI, retrieval and deployment.',
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
      { title: 'Retrieval (RAG)', text: 'The 1.2.0 release introduced scoped ingestion, vector adapters, citations, reranking and offline evaluation as experimental.' },
    ],
  },
  {
    label: '1.2.1', title: 'Qualified retrieval and configurable graphs', status: 'shipped',
    summary: 'Published November 23, 2026 through npm trusted publishing.',
    items: [
      { title: 'Production RAG profile', text: 'The registered Modal and Pinecone Loki v28 profile passed semantic quality, load, recovery, scope security and cleanup checks. Other profiles remain experimental.' },
      { title: 'Workflow graph limits', text: 'Keep the 128-node default, set a per-graph bound, or opt out from trusted host configuration while retaining independent runtime limits.' },
    ],
  },
  {
    label: '1.2.2', title: 'Runnable RAG starter and release hardening', status: 'shipped',
    summary: 'Published November 23, 2026 through npm trusted publishing.',
    items: [
      { title: 'Modal + Pinecone starter', text: 'Generate a retrieval agent with an offline Markdown demo, durable ingestion and exact source citations.' },
      { title: 'Dependency security', text: 'Patched Zod and Hono dependencies and added production dependency audits across every published package.' },
      { title: 'Registry verification', text: 'Added clean-install RAG acceptance, archive size checks and registry signature verification.' },
    ],
  },
  {
    label: '1.3', title: 'Standalone agent components', status: 'shipped',
    summary: 'Mayura UI became a standalone React 19 package and gained a public shadcn registry.',
    items: [
      { title: 'Composable UI', text: 'Build chat with a composer, thread history, run activity, exact approval review, citations and artifact inspection.' },
      { title: 'Your app owns the transport', text: 'Use the components with your own data and callbacks, or connect them to a compatible AG-UI backend.' },
    ],
  },
  {
    label: '1.4', title: 'Agent Workspace', status: 'shipped',
    summary: 'Published November 25, 2026. Build on the assembled workspace or install the individual React components.',
    items: [
      { title: 'A ready-to-compose workspace', text: 'Chat, threads, run activity, exact approval review, citations and artifacts share one workspace. Replace the sidebar, composer or message rendering.' },
      { title: 'Editable Tailwind', text: 'Copy workspace source through shadcn and let your app build its utility classes. The npm package also offers a Tailwind v4 entry point and compiled CSS.' },
      { title: 'Reconnect to a run', text: 'Authorized read-only AG-UI observation restores the transcript and pending approval. The Mayura AG-UI adapter remains experimental.' },
      { title: 'Typed reply cards', text: 'Show tables, allowlisted downloads and confirmations, or register your own renderer. Your server authorizes actions that write.' },
    ],
  },
  {
    label: 'Next', title: 'Qualify more real-world paths', status: 'next',
    summary: 'Priorities for broader qualification, without promised delivery dates.',
    items: [
      { title: 'Broader retrieval qualification', text: 'Measure quality, latency and recovery for more embedding, vector store and reranker combinations.' },
      { title: 'Browser and client interoperability', text: 'Expand rendered workspace coverage for accessibility and reconnection, and verify AG-UI reference clients and CopilotKit compatibility.' },
      { title: 'External services', text: 'Qualify more model providers, gateways and authorization policies under real deployment conditions.' },
      { title: 'Deployment profiles', text: 'Extend live testing beyond the Hono and D1 smoke test to more framework setups and workloads.' },
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

const shipped = stages.filter(stage => stage.status === 'shipped').reverse();
const groups = [
  { id: 'latest-release', title: 'Latest release', stages: shipped.slice(0, 1) },
  { id: 'planned-work', title: 'Planned work', stages: stages.filter(stage => stage.status !== 'shipped') },
  { id: 'earlier-releases', title: 'Earlier releases', stages: shipped.slice(1) },
];

function Roadmap() {
  return (
    <main className="px-4 py-16 sm:px-6 sm:py-20">
      <div className="mx-auto max-w-4xl">
        <p className="text-sm font-medium text-primary">Roadmap</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-[-0.035em] text-balance sm:text-5xl">Where Mayura is going</h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-pretty text-muted">
          See what you can build with today’s release and where we plan to expand qualification. Releases keep
          explicit permissions, a hard budget on every run, and semantic versioning for documented stable APIs.
        </p>

        {groups.map(group => (
          <section key={group.id} aria-labelledby={group.id} className="mt-14">
            <h2 id={group.id} className="mb-6 text-lg font-semibold tracking-tight">{group.title}</h2>
            <ol className="relative space-y-12 border-l border-line pl-6 sm:pl-8">
              {group.stages.map(stage => <RoadmapStage key={stage.label} stage={stage} />)}
            </ol>
          </section>
        ))}

        <div className="mt-16 rounded-2xl border border-line bg-soft/60 p-6 sm:p-8">
          <h2 className="text-lg font-semibold tracking-tight">Tell us what you need</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            Open an issue for an integration, a feature or a problem you hit, or comment on one that is already there.
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

function RoadmapStage({ stage }: { stage: Stage }) {
  return (
    <li className="relative">
      <span aria-hidden="true" className={`absolute top-1.5 -left-[1.9rem] size-3.5 rounded-full border-2 border-bg sm:-left-[2.4rem] ${stage.status === 'shipped' ? 'bg-primary' : stage.status === 'next' ? 'bg-fg' : 'bg-line'}`} />
      <div className="flex flex-wrap items-center gap-3">
        {stage.status === 'shipped' && <span className="font-mono text-sm text-muted">v{stage.label}</span>}
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${badge[stage.status]}`}>{badgeText[stage.status]}</span>
      </div>
      <h3 className="mt-2 text-2xl font-semibold tracking-tight">{stage.title}</h3>
      <p className="mt-1 text-muted">{stage.summary}</p>
      <ul className="mt-5 grid gap-3 sm:grid-cols-2">
        {stage.items.map(item => (
          <li key={item.title} className="rounded-2xl border border-line bg-raised p-5">
            <h4 className="font-semibold tracking-tight">{item.title}</h4>
            <p className="mt-1.5 text-sm leading-relaxed text-pretty text-muted">{item.text}</p>
          </li>
        ))}
      </ul>
      {stage.label === '1.1' && (
        <p className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <Link to="/docs/$/" params={{ _splat: 'project/whats-new' }} hash="mayura-11" className="font-medium text-primary hover:underline">Mayura 1.1 history</Link>
          <Link to="/integrations/" className="font-medium text-primary hover:underline">Browse the integrations</Link>
        </p>
      )}
      {stage.label === '1.2.1' && (
        <p className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <Link to="/docs/$/" params={{ _splat: 'project/whats-new' }} hash="mayura-121" className="font-medium text-primary hover:underline">What’s new in 1.2.1</Link>
          <Link to="/docs/$/" params={{ _splat: 'guides/release-readiness' }} hash="v121-publication" className="font-medium text-primary hover:underline">Release evidence and limits</Link>
        </p>
      )}
      {stage.label === '1.2.2' && (
        <p className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <Link to="/docs/$/" params={{ _splat: 'project/changelog' }} className="font-medium text-primary hover:underline">Read the changelog</Link>
          <Link to="/docs/$/" params={{ _splat: 'guides/rag-modal-pinecone-starter' }} className="font-medium text-primary hover:underline">Run the RAG starter</Link>
        </p>
      )}
      {stage.label === '1.4' && (
        <p className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <Link to="/docs/$/" params={{ _splat: 'project/whats-new' }} hash="mayura-14" className="font-medium text-primary hover:underline">What’s new in 1.4</Link>
          <Link to="/ui/" className="font-medium text-primary hover:underline">Explore the UI gallery</Link>
          <Link to="/docs/$/" params={{ _splat: 'guides/nextjs' }} hash="agent-workspace-example" className="font-medium text-primary hover:underline">Run the Next.js example</Link>
        </p>
      )}
    </li>
  );
}
