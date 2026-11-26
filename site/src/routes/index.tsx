import { createFileRoute, Link } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
import { articles } from 'virtual:mayura-content';
import agentSnippet from 'virtual:mayura-snippet/agent.ts';
import browserSnippet from 'virtual:mayura-snippet/browser.ts';
import runSnippet from 'virtual:mayura-snippet/run.ts';
import sandboxSnippet from 'virtual:mayura-snippet/sandbox.ts';
import serveSnippet from 'virtual:mayura-snippet/serve.ts';
import testSnippet from 'virtual:mayura-snippet/test.ts';
import workflowSnippet from 'virtual:mayura-snippet/workflow.ts';
import { GitHubIcon } from '../components/Header';
import { Html } from '../components/Html';
import { Accordion } from '../components/Accordion';
import { Icon, type IconName } from '../components/Icon';
import { LogoMark } from '../components/Logo';
import { IntegrationsWall } from '../components/IntegrationsWall';
import { UiComponentPreview } from '../components/UiComponentPreview';
import {
  BrowserPreview, CostArt, MemoryArt, ModelsArt, PolicyPreview, RunPreview, SandboxPreview, ServePreview, StreamingArt, TestPreview,
  TraceArt, VisionArt, WorkflowPreview,
} from '../components/Visuals';
import { formatDate, sections } from '../lib/content';
import { pageMeta, site } from '../lib/site';
import { frameworkStarters, integrationPackageCount } from '../lib/release';

export const Route = createFileRoute('/')({
  head: () => pageMeta({ title: `${site.name}: ${site.tagline}`, description: site.description, path: '/' }),
  component: Home,
});

function Home() {
  return (
    <main>
      <Hero />
      <WorkspaceSetup />
      <Guarantees />
      <Tour />
      <ProductionRetrieval />
      <IntegrationsWall />
      <Features />
      <FrameworkStarters />
      <GetStarted />
      <Reading />
      <Faq />
      <Closing />
    </main>
  );
}

const docs = (slug: string) => ({ to: '/docs/$/' as const, params: { _splat: slug } });
const firstApprovalGuide = { to: '/guides/$slug/' as const, params: { slug: 'first-approval' } };

/** A heading in two tones: the claim in full colour, the explanation muted. */
function Heading({ strong, soft }: { strong: string; soft?: string }) {
  return (
    <h2 className="mx-auto max-w-3xl text-center text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-[2.6rem] sm:leading-[1.1]">
      {strong}{soft && <> <span className="text-muted">{soft}</span></>}
    </h2>
  );
}

function PrimaryButton({ slug, children }: { slug: string; children: ReactNode }) {
  return (
    <Link {...docs(slug)} className="group inline-flex h-11 items-center gap-2 rounded-lg bg-fg px-5 text-sm font-medium text-bg transition hover:opacity-85">
      {children} <Icon name="arrow" className="size-4 transition group-hover:translate-x-0.5" />
    </Link>
  );
}

function SecondaryButton({ slug, children }: { slug: string; children: ReactNode }) {
  return (
    <Link {...docs(slug)} className="inline-flex h-11 items-center rounded-lg border border-line bg-bg/60 px-5 text-sm font-medium backdrop-blur transition hover:border-muted/50">
      {children}
    </Link>
  );
}

/** A command that copies itself when clicked. */
function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" aria-label={`Copy ${command}`}
      onClick={() => void navigator.clipboard?.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
      className="group inline-flex items-center gap-2 font-mono text-sm text-muted transition hover:text-fg">
      <span className="text-primary">~</span> {command}
      <span className="text-xs opacity-0 transition group-hover:opacity-100">{copied ? 'copied' : 'copy'}</span>
    </button>
  );
}

// ---- Hero -----------------------------------------------------------------------------------------------------------

function Hero() {
  return (
    <section aria-labelledby="home-heading" className="px-4 pt-12 pb-10 sm:px-6 sm:pt-16 sm:pb-12">
      <div className="mx-auto max-w-7xl">
        <div className="grid items-center gap-9 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] lg:gap-12">
          <div>
            <h1 id="home-heading" className="max-w-xl text-[clamp(2.4rem,4.8vw,4.25rem)] leading-[1.02] font-semibold tracking-[-0.06em] text-balance">
              {site.tagline}.
            </h1>
            <p className="mt-5 max-w-lg text-base leading-relaxed text-pretty text-muted sm:text-lg">
              Give your Next.js app an agent workspace where people can inspect a source, review exactly what will
              change, and approve a write. Mayura runs typed tools and durable workflows behind it.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <a href="#approval-demo"
                className="group inline-flex min-h-11 items-center gap-2 rounded-lg bg-fg px-5 text-sm font-medium text-bg transition hover:opacity-85">
                Try an approval <Icon name="arrow" className="size-4 shrink-0 transition group-hover:translate-x-0.5" />
              </a>
              <Link {...firstApprovalGuide}
                className="inline-flex min-h-11 items-center rounded-lg bg-soft px-4 text-sm font-medium transition hover:bg-line">
                Run locally — no API key
              </Link>
            </div>
            <Link {...docs('project/whats-new')} className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
              What’s new in v{site.version} <Icon name="arrow" className="size-3.5 shrink-0" />
            </Link>
          </div>
          <figure id="approval-demo" tabIndex={-1} className="ui-library home-workspace-demo min-w-0 scroll-mt-20 rounded-[1.35rem] bg-soft p-2 sm:p-3">
            <figcaption className="px-2 pt-1 pb-2.5 text-sm leading-relaxed text-muted sm:px-3">
              Select <strong className="font-medium text-fg">Save the release checklist</strong> to review and decide on
              a proposed write. This demo uses sample data in your browser.
            </figcaption>
            <div className="overflow-hidden rounded-[0.95rem] border border-line">
              <UiComponentPreview slug="chat-workspace" />
            </div>
          </figure>
        </div>
      </div>
    </section>
  );
}

const retrievalEvidence = [
  { value: '40', label: 'source-reviewed Loki cases' },
  { value: '4.725 s', label: 'acquisition and ranking p95 upper bound' },
  { value: '600 / 600', label: 'timed Pinecone queries completed' },
];

function ProductionRetrieval() {
  return (
    <section aria-labelledby="production-retrieval" className="border-y border-line bg-soft/40 px-4 py-16 sm:px-6 sm:py-24">
      <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[1.12fr_1fr] lg:items-center lg:gap-20">
        <div>
          <h2 id="production-retrieval" className="max-w-xl text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-[2.6rem]">Ground your agents in sources they can access.</h2>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-pretty text-muted sm:text-lg">
            Mayura gives agents scoped retrieval tools that return evidence with exact citation identities. The registered
            Modal and Pinecone profile for the Loki software operations workload is qualified for production. Other RAG
            profiles remain experimental.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <PrimaryButton slug="guides/rag-modal-pinecone-starter">Try the RAG starter</PrimaryButton>
            <SecondaryButton slug="guides/rag-production">Review qualification evidence</SecondaryButton>
          </div>
        </div>
        <dl className="divide-y divide-line border-y border-line">
          {retrievalEvidence.map(({ value, label }) => (
            <div key={label} className="grid grid-cols-[6.5rem_1fr] items-center gap-4 py-4 sm:grid-cols-[8rem_1fr] sm:gap-6">
              <dt className="col-start-2 row-start-1 text-sm leading-relaxed text-muted">{label}</dt>
              <dd className="col-start-1 row-start-1 text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

// ---- Guarantees -----------------------------------------------------------------------------------------------------

const guarantees: { icon: IconName; title: string; body: string; slug: string }[] = [
  { icon: 'shield', title: 'Nothing allowed by default', body: 'Models, tools and effects need an explicit grant.', slug: 'concepts/permissions' },
  { icon: 'gauge', title: 'Every run has limits', body: 'Cost, steps, tool calls and time are always capped.', slug: 'concepts/costs-and-budgets' },
  { icon: 'braces', title: 'Types at every boundary', body: 'Inputs and outputs are checked against your schemas.', slug: 'concepts/tools' },
  { icon: 'alert', title: 'Honest outcomes', body: 'An unknown side effect is reported, never retried blindly.', slug: 'concepts/outcomes' },
];

function Guarantees() {
  return (
    <section className="border-y border-line">
      <div className="mx-auto grid max-w-7xl divide-y divide-line sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
        {guarantees.map((item, index) => (
          <Link key={item.title} {...docs(item.slug)}
            className={`group px-6 py-8 transition hover:bg-soft sm:px-8 ${index % 2 === 1 ? 'sm:border-l sm:border-line lg:border-l-0' : ''} ${index > 1 ? 'sm:border-t sm:border-line lg:border-t-0' : ''}`}>
            <Icon name={item.icon} className="size-5 text-primary" />
            <div className="mt-4 font-medium">{item.title}</div>
            <div className="mt-1 text-sm leading-relaxed text-muted">{item.body}</div>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ---- Product tour ---------------------------------------------------------------------------------------------------

const tour: { label: string; icon: IconName; file: string; code: string; preview: ReactNode; title: string; body: string; slug: string }[] = [
  { label: 'Agents', icon: 'braces', file: 'agent.ts', code: agentSnippet, preview: <RunPreview />, slug: 'concepts/agent',
    title: 'Typed agents and tools', body: 'Instructions, a model and tools, with schemas for what goes in and what comes out.' },
  { label: 'Permissions', icon: 'shield', file: 'main.ts', code: runSnippet, preview: <PolicyPreview />, slug: 'concepts/permissions',
    title: 'Allow-lists and limits', body: 'A run may use only what you grant, and never spends past its budget.' },
  { label: 'Workflows', icon: 'workflow', file: 'refund.ts', code: workflowSnippet, preview: <WorkflowPreview />, slug: 'guides/durable-workflows',
    title: 'Durable workflows', body: 'Steps that wait for people, timers and signals, and carry on after a restart.' },
  { label: 'Sandboxes', icon: 'box', file: 'sandbox.ts', code: sandboxSnippet, preview: <SandboxPreview />, slug: 'guides/sandboxes',
    title: 'Sandboxes for code', body: 'Isolated Linux machines on Docker or twelve hosted providers, with no network unless you allow it.' },
  { label: 'Browsers', icon: 'globe', file: 'browser.ts', code: browserSnippet, preview: <BrowserPreview />, slug: 'guides/browsers',
    title: 'Real browsers', body: 'Local Chrome or ten hosted services, kept to the origins you list, with a live view to watch.' },
  { label: 'Serve', icon: 'terminal', file: 'server.ts', code: serveSnippet, preview: <ServePreview />, slug: 'guides/server-and-client',
    title: 'Server and client', body: 'Authenticated HTTP with live events, a typed client and React hooks.' },
  { label: 'Test', icon: 'flask', file: 'agent.test.ts', code: testSnippet, preview: <TestPreview />, slug: 'guides/testing',
    title: 'Tests without a network', body: 'Scripted models replay fixed responses, so every test is fast, free and repeatable.' },
];

function Tour() {
  const [active, setActive] = useState(0);
  const id = useId();
  const current = tour[active]!;
  return (
    <section className="px-3 py-24 sm:px-6 sm:py-32">
      <Heading strong="Agents. Tools. Workflows." soft="Everything you need to ship, running under rules you set." />
      <div className="mx-auto mt-14 max-w-7xl rounded-[2rem] border border-line bg-soft p-2 sm:p-3">
        <div role="tablist" aria-label="Product tour" className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]"
          onKeyDown={event => {
            const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
            if (!step) return;
            const next = (active + step + tour.length) % tour.length;
            setActive(next); document.getElementById(`${id}-tab-${next}`)?.focus();
          }}>
          {tour.map((item, index) => (
            <button key={item.label} id={`${id}-tab-${index}`} type="button" role="tab" aria-selected={index === active}
              aria-controls={`${id}-panel-${index}`} tabIndex={index === active ? 0 : -1} onClick={() => setActive(index)}
              className={`flex flex-1 items-center justify-center gap-2 rounded-full px-4 py-3 font-mono text-xs tracking-wider whitespace-nowrap uppercase transition ${index === active
                ? 'bg-bg text-fg shadow-sm ring-1 ring-line' : 'text-muted hover:text-fg'}`}>
              <Icon name={item.icon} className="size-4" /> {item.label}
            </button>
          ))}
        </div>

        <div className="relative mt-2 overflow-hidden rounded-[1.6rem] border border-line bg-bg sm:mt-3">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_60%_at_0%_0%,color-mix(in_srgb,var(--primary)_10%,transparent),transparent),radial-gradient(circle,var(--line)_1px,transparent_1px)] bg-[size:auto,22px_22px]" />
          {/* Every panel shares one grid cell, so the tour keeps its size from tab to tab. */}
          <div className="relative grid">
            {tour.map((item, index) => (
              <div key={item.label} id={`${id}-panel-${index}`} role="tabpanel" aria-labelledby={`${id}-tab-${index}`} aria-hidden={index !== active}
                className={`[grid-area:1/1] grid gap-4 p-3 sm:p-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-6 lg:p-8 ${index === active ? '' : 'invisible'}`}>
                <div className="min-w-0 overflow-hidden rounded-2xl border border-line bg-code">
                  <div className="border-b border-line px-4 py-2.5 font-mono text-xs text-muted">{item.file}</div>
                  <Html html={item.code} className="snippet" />
                </div>
                <div className="flex min-w-0 [&>*]:w-full">{item.preview}</div>
              </div>
            ))}
          </div>
          <div className="relative border-t border-line px-6 py-5 text-center">
            <div className="font-medium">{current.title}</div>
            <p className="mx-auto mt-1 max-w-xl text-sm text-muted">
              {current.body} <Link {...docs(current.slug)} className="text-primary hover:underline">Read the guide</Link>
            </p>
          </div>
        </div>
        <p className="mt-3 text-center text-xs text-muted">Previews are illustrations of what happens during a run.</p>
      </div>
    </section>
  );
}

// ---- Features -------------------------------------------------------------------------------------------------------

const features: { title: string; body: string; slug: string; art: ReactNode }[] = [
  { title: 'Any model, with failover', body: 'Models as provider/model, with dated prices, retries and fallback chains across eight provider packages and any OpenAI-compatible API.', slug: 'guides/model-registry', art: <ModelsArt /> },
  { title: 'Cost control', body: 'Prices, per-call caps and shared budgets, from the tokens providers report.', slug: 'concepts/costs-and-budgets', art: <CostArt /> },
  { title: 'Streaming', body: 'Show an answer as it is written, with guards on every batch.', slug: 'guides/streaming', art: <StreamingArt /> },
  { title: 'Vision', body: 'Agents that see images and PDFs, checked by their own bytes.', slug: 'guides/vision', art: <VisionArt /> },
  { title: 'Memory and context', body: 'Native memory with keyword, semantic and hybrid search.', slug: 'guides/memory-and-context', art: <MemoryArt /> },
  { title: 'Observability', body: 'OpenTelemetry traces with GenAI attributes, for Langfuse, Datadog, Sentry and more.', slug: 'guides/observability', art: <TraceArt /> },
];

function Features() {
  return (
    <section className="border-t border-line px-4 py-24 sm:px-6 sm:py-32">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col items-center gap-2 text-center sm:flex-row sm:items-baseline sm:justify-center sm:gap-3">
          <h2 className="text-3xl font-semibold tracking-[-0.03em] sm:text-[2.6rem]">What’s in Mayura?</h2>
          <p className="text-lg text-muted">Everything an agent needs in production.</p>
        </div>
        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(feature => (
            <Link key={feature.title} {...docs(feature.slug)}
              className="group overflow-hidden rounded-2xl border border-line bg-raised transition hover:border-muted/40">
              <div className="grid h-52 place-items-center border-b border-line bg-[radial-gradient(circle,var(--line)_1px,transparent_1px)] bg-[size:18px_18px] px-6">
                {feature.art}
              </div>
              <div className="p-6">
                <h3 className="font-semibold">{feature.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{feature.body}</p>
              </div>
            </Link>
          ))}
        </div>
        <p className="mt-10 text-center text-sm text-muted">
          Also: <Link {...docs('guides/mcp')} className="text-fg hover:text-primary">MCP tools</Link>,{' '}
          <Link {...docs('guides/code-mode')} className="text-fg hover:text-primary">Code Mode</Link>,{' '}
          <Link {...docs('guides/guardrails')} className="text-fg hover:text-primary">guardrails</Link>,{' '}
          <Link {...docs('guides/child-agents')} className="text-fg hover:text-primary">child agents</Link>,{' '}
          <Link {...docs('guides/react')} className="text-fg hover:text-primary">React</Link>,{' '}
          <Link {...docs('guides/storage')} className="text-fg hover:text-primary">seven databases</Link> and the{' '}
          <Link {...docs('guides/operator-console')} className="text-fg hover:text-primary">operator console</Link>.
        </p>
      </div>
    </section>
  );
}

function WorkspaceSetup() {
  const choices = [
    { title: 'Copy the source', body: 'Add the workspace through shadcn. Edit the React components and Tailwind classes in your app.', label: 'Install with shadcn', hash: 'shadcn-registry' },
    { title: 'Install the React package', body: 'Use the workspace or individual components from @mayurajs/ui with your own AG-UI backend.', label: 'Install from npm', hash: 'npm-package' },
  ];
  return (
    <section aria-labelledby="workspace-setup" className="bg-soft/60 px-4 py-12 sm:px-6 sm:py-16">
      <div className="mx-auto max-w-7xl">
        <h2 id="workspace-setup" className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Add a workspace to your app.</h2>
        <ul className="mt-8 grid gap-x-12 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
          <li>
            <h3 className="font-semibold">Run the Next.js starter</h3>
            <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted">
              Review a note before saving it, then reopen your saved thread. The starter runs with a scripted agent.
            </p>
            <Link {...firstApprovalGuide}
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
              Follow the walkthrough <Icon name="arrow" className="size-3.5" />
            </Link>
          </li>
          {choices.map(({ title, body, label, hash }) => (
            <li key={hash}>
              <h3 className="font-semibold">{title}</h3>
              <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted">{body}</p>
              <Link {...docs('integrations/ui')} hash={hash}
                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                {label} <Icon name="arrow" className="size-3.5" />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** A native select keeps framework discovery keyboard-friendly without hiding any guide links. */
function FrameworkStarters() {
  const [selected, setSelected] = useState<string>('nextjs');
  const selectId = useId();
  const starter = frameworkStarters.find(item => item.id === selected) ?? frameworkStarters[0];
  return (
    <section className="border-t border-line bg-soft/40 px-4 py-24 sm:px-6 sm:py-32">
      <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-2 lg:gap-20">
        <div className="min-w-0">
          <p className="text-sm font-medium text-primary">Six framework starters · No API key needed</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-[-0.03em] sm:text-[2.6rem]">Start in your framework.</h2>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted">A working notebook with persistent threads,
            exact note approvals and a separate indexing worker. Run the offline flow first, then connect your identity and models.</p>
          <label htmlFor={selectId} className="mt-8 block text-sm font-medium">Choose a framework</label>
          <select id={selectId} value={selected} onChange={event => setSelected(event.target.value)}
            className="mt-2 w-full max-w-sm rounded-lg border border-line bg-bg px-3 py-3 text-fg">
            {frameworkStarters.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-code p-4">
            <CopyCommand command={`npx mayura@${site.version} init --starter ${starter.id} --directory ./my-notebook --apply`} />
          </div>
          <p className="mt-3 text-sm text-muted">{starter.detail}</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <PrimaryButton slug={`guides/${starter.id}`}>Follow the {starter.name} guide</PrimaryButton>
            <SecondaryButton slug="guides/choosing-a-starter">Compare all starters</SecondaryButton>
          </div>
        </div>
        <ul className="divide-y divide-line self-start border-y border-line">
          {frameworkStarters.map(item => (
            <li key={item.id}>
              <Link {...docs(`guides/${item.id}`)} className="group flex items-center justify-between gap-4 py-5">
                <div><h3 className="font-semibold group-hover:text-primary">{item.name}</h3>
                  <p className="mt-1 text-sm text-muted">{item.detail}</p></div>
                <Icon name="arrow" className="size-4 shrink-0 text-muted group-hover:text-primary" />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ---- Get started ----------------------------------------------------------------------------------------------------

const steps = [
  ['npx mayura init', 'Pick a starter and a model provider.'],
  ['npm run dev', 'Build, run and restart on every save.'],
  ['mayura serve', 'Serve it; mayura worker runs workflows.'],
];

const starters: { icon: IconName; name: string; title: string; body: string }[] = [
  { icon: 'chat', name: 'support-agent', title: 'Support assistant', body: 'Streamed chat that acts only for the signed-in customer.' },
  { icon: 'shield', name: 'approval-workflow', title: 'Approval workflow', body: 'Refunds that wait for a person to approve the payment.' },
  { icon: 'team', name: 'research-team', title: 'Research team', body: 'Planner, parallel researchers and a writer, on one budget.' },
  { icon: 'bolt', name: 'event-automation', title: 'Event automation', body: 'Signed webhooks start workflows that act through MCP.' },
  { icon: 'terminal', name: 'cli-agent', title: 'Command-line assistant', body: 'Chat in your terminal; you confirm every write.' },
];

function GetStarted() {
  return (
    <section className="border-t border-line px-4 py-24 sm:px-6 sm:py-32">
      <div className="mx-auto grid max-w-7xl gap-14 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-20">
        <div>
          <h2 className="text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-[2.6rem] sm:leading-[1.1]">
            Get started in seconds <span className="text-muted">with a project that already works.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Start with a tested application shape, then follow its setup and deployment guide. Your API key goes into
            <code className="mx-1 font-mono text-[0.9em] text-fg">.env</code>and nowhere else.
          </p>
          <ol className="mt-10 space-y-5">
            {steps.map(([command, body], index) => (
              <li key={command} className="flex items-start gap-4">
                <span className="grid size-7 shrink-0 place-items-center rounded-full border border-line font-mono text-xs text-muted">{index + 1}</span>
                <div>
                  <code className="font-mono text-sm text-fg">{command}</code>
                  <div className="text-sm text-muted">{body}</div>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-10 flex flex-wrap gap-3">
            <PrimaryButton slug="quickstart">Follow the quickstart</PrimaryButton>
            <SecondaryButton slug="cli/init">All starters and templates</SecondaryButton>
          </div>
        </div>
        <ul className="divide-y divide-line self-start overflow-hidden rounded-2xl border border-line bg-raised">
          {starters.map(starter => (
            <li key={starter.name} className="flex items-center gap-4 px-5 py-5 transition hover:bg-soft">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line text-primary"><Icon name={starter.icon} /></span>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{starter.title}</div>
                <div className="text-sm text-muted">{starter.body}</div>
              </div>
              <code className="hidden shrink-0 rounded-md border border-line bg-code px-2 py-1 font-mono text-xs text-muted md:block">{starter.name}</code>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ---- Reading --------------------------------------------------------------------------------------------------------

function Reading() {
  const featured = ['first-approval', 'agent-workspace', 'retrieval-with-citations']
    .flatMap(slug => articles.guides.filter(entry => entry.slug === slug));
  return (
    <section className="border-t border-line px-4 py-24 sm:px-6 sm:py-32">
      <div className="mx-auto max-w-7xl">
        <Heading strong="Learn by building." soft="Guides, comparisons and research from the people who make Mayura." />
        <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {featured.map(entry => (
            <Link key={`${entry.section}/${entry.slug}`} to={`/${entry.section}/$slug/` as '/guides/$slug/'} params={{ slug: entry.slug }}
              className="group flex flex-col rounded-2xl border border-line bg-raised p-6 transition hover:border-muted/40">
              <span className="self-start rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary first-letter:uppercase">{sections[entry.section].noun}</span>
              <h3 className="mt-4 font-semibold tracking-tight text-balance group-hover:text-primary">{entry.title}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-pretty text-muted">{entry.description}</p>
              <p className="mt-4 text-xs text-muted">{formatDate(entry.date)} · {entry.minutes} min read</p>
            </Link>
          ))}
          <Link to="/roadmap/" className="group flex flex-col justify-between rounded-2xl border border-line bg-soft/60 p-6 transition hover:border-muted/40">
            <div>
              <span className="rounded-full bg-fg px-2.5 py-0.5 text-xs font-medium text-bg">Roadmap</span>
              <h3 className="mt-4 font-semibold tracking-tight group-hover:text-primary">What comes next</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">See what shipped and which integrations are still being qualified.</p>
            </div>
            <span className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary">See the roadmap <Icon name="arrow" className="size-4 transition group-hover:translate-x-0.5" /></span>
          </Link>
        </div>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <Link to="/articles/" className="inline-flex h-11 items-center rounded-lg border border-line bg-bg/60 px-5 text-sm font-medium transition hover:border-muted/50">All articles</Link>
          <Link to="/compare/" className="inline-flex h-11 items-center rounded-lg border border-line bg-bg/60 px-5 text-sm font-medium transition hover:border-muted/50">Compare frameworks</Link>
        </div>
      </div>
    </section>
  );
}

// ---- FAQ ------------------------------------------------------------------------------------------------------------

const questions: { q: string; a: ReactNode }[] = [
  { q: 'What is Mayura?', a: <>A TypeScript framework for AI agents, typed tools and durable workflows. You describe an agent with schemas, give it tools and a model, and run it under an allow-list of permissions and limits. It is one npm package, <code>mayura</code>, with a CLI of the same name.</> },
  { q: 'Do I need to install anything else?', a: <>No. <code>npm install mayura</code> is enough to build agents: schemas use <code>z</code> from <code>mayura</code> (it is Zod). Optional parts such as SQLite or PostgreSQL storage, the QuickJS sandbox and React hooks each need one extra package, only if you use them. Other services, from more model providers and databases to hosted browsers and identity providers, come as <Link to="/integrations/" className="text-primary hover:underline"><code>@mayurajs/*</code> packages</Link>.</> },
  { q: 'What can Mayura connect to?', a: <>{integrationPackageCount} optional packages: providers, AI gateways, vector stores, rerankers, authorization policies, voice, databases, files, tracing, sandboxes, browsers, identity and deploy targets. Configure credentials explicitly and review each adapter’s permissions and limits in the <Link to="/integrations/" className="text-primary hover:underline">integrations directory</Link>.</> },
  { q: 'Which models can I use?', a: <>Through the model registry, OpenAI, Anthropic, Google Gemini, Amazon Bedrock, Azure OpenAI, Mistral, Groq and Ollama, each a provider package with a dated price catalog, named as <code>provider/model</code>. Any OpenAI-compatible API works too, such as DeepSeek, xAI, OpenRouter, Together, Fireworks and local servers. Retries and fallback chains move a call to the next model when one fails.</> },
  { q: 'Can agents run code or use a browser?', a: <>Yes, in a sandbox (Docker, or one of twelve hosted providers such as E2B, Daytona and Modal) or a real browser (local Chrome, or one of ten hosted services). Both are off until you grant them, have lifetimes and limits, and keep to the network or origins you allow. See <Link {...docs('guides/sandboxes')} className="text-primary hover:underline">Sandboxes</Link> and <Link {...docs('guides/browsers')} className="text-primary hover:underline">Browsers</Link>.</> },
  { q: 'How does Mayura keep agents in bounds?', a: <>A run can use a model, tool or effect only when you grant it, every run has cost, step, tool-call and time limits, and every input and output is validated. When a side effect may or may not have happened, the run ends <code>outcome_unknown</code> instead of retrying blindly.</> },
  { q: 'Can I test without an API key?', a: <>Yes. Scripted models from <code>mayura/testing</code> replay fixed responses, so agents, tools and workflows run offline in your tests.</> },
  { q: 'Can I use Mayura UI with another backend?', a: <>Yes. Use <code>@mayurajs/ui</code> in React 19 or copy the source with shadcn. Supply your own callbacks for individual components or connect the workspace to your own AG-UI transport. See the <Link {...docs('integrations/ui')} className="text-primary hover:underline">UI installation guide</Link>.</> },
  { q: 'Where can I deploy Mayura?', a: <>Anywhere Node.js 22 or 24 runs: containers, Kubernetes, managed platforms such as Cloud Run, ECS and Fly.io, your own servers, inside an app you already run, and serverless functions on Vercel (AWS Lambda and Cloud Run functions experimental). It also runs on edge runtimes: Vercel Edge, Cloudflare Workers, Deno and Bun. <code>mayura deploy</code> ships to Docker, Kubernetes and eleven platforms through their own tools. See <Link {...docs('guides/deployment')} className="text-primary hover:underline">Deployment</Link>.</> },
  { q: 'Can I use Mayura RAG in production?', a: <>Yes, within the tested scope of the <Link {...docs('guides/rag-production')} className="text-primary hover:underline">qualified Modal and Pinecone Loki v28 profile</Link>. Mayura returns authorized evidence and citation identities. Evaluate retrieval, citations and answer grounding on your own corpus before making production claims for a different configuration.</> },
  { q: 'Is Mayura ready for production?', a: <>Mayura {site.version} is published under <code>latest</code>. The documented stable APIs follow <Link {...docs('project/versioning')} className="text-primary hover:underline">the versioning policy</Link>. AG-UI and other RAG profiles remain experimental. Read the <Link {...docs('guides/release-readiness')} className="text-primary hover:underline">release evidence and limitations</Link>.</> },
  { q: 'Is Mayura open source?', a: <>Yes, under the Apache-2.0 license, on <a href={site.repository} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">GitHub</a>.</> },
];

function Faq() {
  return (
    <section className="border-t border-line px-4 py-24 sm:px-6 sm:py-32">
      <Heading strong="Frequently asked questions" />
      <div className="mx-auto mt-12 max-w-3xl divide-y divide-line overflow-hidden rounded-2xl border border-line bg-raised">
        {questions.map(({ q, a }) => (
          <Accordion key={q} title={q}>
            <p className="text-sm leading-relaxed text-muted">{a}</p>
          </Accordion>
        ))}
      </div>
    </section>
  );
}

// ---- Closing --------------------------------------------------------------------------------------------------------

const agentPrompt = [
  'Build this with Mayura, a TypeScript framework for AI agents, typed tools and durable workflows.',
  'Install it with `npm install mayura` (Node.js 22 or 24, ES modules). Before writing code, read',
  'node_modules/mayura/llms.txt and the pages it links in node_modules/mayura/docs/.',
  "Import from 'mayura' or 'mayura/<entry point>', and use `z` from 'mayura' for schemas.",
  'Grant every model, tool and effect a run needs in createRuntime({ permissions: { allow } }), set',
  'limits.maxCostMicros, check result.status before reading result.output, and test offline with',
  "scriptedModel from 'mayura/testing'.",
].join(' ');

function Closing() {
  const [copied, setCopied] = useState(false);
  return (
    <section className="relative overflow-hidden border-t border-line">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_50%_60%_at_50%_100%,color-mix(in_srgb,var(--primary)_14%,transparent),transparent)]" />
      <div className="mx-auto flex max-w-3xl flex-col items-center px-4 py-28 text-center sm:py-36">
        <LogoMark className="size-12" />
        <h2 className="mt-8 text-4xl font-semibold tracking-[-0.04em] text-balance sm:text-6xl">Start building with Mayura today</h2>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <Link {...firstApprovalGuide}
            className="group inline-flex h-11 items-center gap-2 rounded-lg bg-fg px-5 text-sm font-medium text-bg transition hover:opacity-85">
            Run locally — no API key <Icon name="arrow" className="size-4 transition group-hover:translate-x-0.5" />
          </Link>
          <button type="button"
            onClick={() => void navigator.clipboard?.writeText(agentPrompt).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); })}
            className="inline-flex h-11 items-center gap-2 rounded-lg border border-line bg-bg/60 px-5 text-sm font-medium backdrop-blur transition hover:border-muted/50">
            <Icon name={copied ? 'check' : 'sparkle'} className="size-4 text-primary" />
            {copied ? 'Prompt copied' : 'Copy prompt for your coding agent'}
          </button>
        </div>
        <a href={site.repository} target="_blank" rel="noopener noreferrer"
          className="mt-8 inline-flex items-center gap-2 text-sm text-muted transition hover:text-fg">
          <GitHubIcon className="size-4" /> Open source under Apache-2.0
        </a>
      </div>
    </section>
  );
}
