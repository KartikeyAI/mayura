import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import agentSnippet from 'virtual:mayura-snippet/agent.ts';
import cliSnippet from 'virtual:mayura-snippet/cli.sh';
import workflowSnippet from 'virtual:mayura-snippet/workflow.ts';
import { GitHubIcon } from '../components/Header';
import { Html } from '../components/Html';
import { LogoMark } from '../components/Logo';
import { asset, pageMeta, site } from '../lib/site';

export const Route = createFileRoute('/')({
  head: () => pageMeta({ title: `${site.name}: ${site.tagline}`, description: site.description, path: '/' }),
  component: Home,
});

function Home() {
  return (
    <main>
      <Hero />
      <Principles />
      <Workflows />
      <Features />
      <Cli />
      <Assistants />
      <Closing />
    </main>
  );
}

// ---- Hero -----------------------------------------------------------------------------------------------------------

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 left-1/2 h-[36rem] w-[60rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--primary)_22%,transparent),transparent)]" />
        <div className="absolute top-24 -right-40 h-[26rem] w-[26rem] rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--gold)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,var(--line)_1px,transparent_1px),linear-gradient(to_bottom,var(--line)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_70%)] bg-[size:48px_48px] opacity-50" />
      </div>

      <div className="mx-auto grid max-w-[90rem] items-center gap-12 px-4 pt-16 pb-20 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-16 lg:pt-24 lg:pb-28">
        <div>
          <Link to="/docs/$/" params={{ _splat: 'project/versioning' }}
            className="inline-flex items-center gap-2 rounded-full border border-line bg-raised/70 px-3 py-1 text-xs text-muted hover:text-fg">
            <span className="size-1.5 rounded-full bg-gold" />
            {site.version} · 1.0 release candidate
          </Link>
          <h1 className="mt-6 text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-[3.5rem] lg:leading-[1.05]">
            AI agents that only do <span className="bg-gradient-to-r from-primary via-blue to-gold bg-clip-text text-transparent">what you allow</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-pretty text-muted">
            Mayura is a TypeScript framework for AI agents, typed tools and durable workflows. Every run is checked against
            your allow-list, capped on cost and time, and validated at every boundary. When an outcome can’t be known,
            Mayura says so instead of guessing.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/docs/$/" params={{ _splat: 'quickstart' }}
              className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-on-primary shadow-sm hover:bg-primary-hover">
              Get started
            </Link>
            <Link to="/docs/$/" params={{ _splat: 'introduction' }}
              className="rounded-lg border border-line bg-raised px-5 py-2.5 text-sm font-medium hover:border-muted/40">
              Read the docs
            </Link>
            <Command text="npm install mayura zod" />
          </div>
          <p className="mt-6 text-sm text-muted">
            One npm package. Node.js 22 and 24. Apache-2.0.
          </p>
        </div>

        <Window title="weather-agent.ts">
          <Html html={agentSnippet} className="snippet max-h-[34rem] overflow-y-auto" />
        </Window>
      </div>
    </section>
  );
}

function Command({ text }: { text: string }) {
  return (
    <Html className="[&_.code-block]:m-0" html={`<div class="code-block"><button type="button" class="code-copy" data-copy aria-label="Copy command">Copy</button><pre class="!py-2.5 !pr-16 !pl-3.5 !text-[0.8rem]"><span class="select-none text-muted">$ </span>${text}</pre></div>`} />
  );
}

function Window({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-2xl border border-line bg-code shadow-[0_30px_80px_-30px_color-mix(in_srgb,var(--primary)_35%,transparent)]">
      <div className="flex items-center gap-2 border-b border-line bg-soft/70 px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-muted/25" />
        <span className="size-2.5 rounded-full bg-muted/25" />
        <span className="size-2.5 rounded-full bg-muted/25" />
        <span className="ml-2 font-mono text-xs text-muted">{title}</span>
      </div>
      {children}
    </div>
  );
}

// ---- Principles -----------------------------------------------------------------------------------------------------

const principles = [
  {
    title: 'Nothing is allowed by default',
    body: 'A run can use a model, a tool or an effect only when the runtime grants it. Registering a tool doesn’t grant it, and child agents can only narrow what they inherit.',
    slug: 'concepts/permissions',
    icon: <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.4 7.5 9.5 4.4-1.1 7.5-4.9 7.5-9.5V6L12 3Zm-3 9 2 2 4-4" />,
  },
  {
    title: 'Every run has limits',
    body: 'Cost, model calls, tool calls, steps, duration and output size are capped. A run may spend nothing until you give it a budget, priced from real token counts.',
    slug: 'concepts/costs-and-budgets',
    icon: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v4l2.5 2.5" />,
  },
  {
    title: 'Types at every boundary',
    body: 'Agent and tool inputs and outputs are validated at runtime with your schemas, and TypeScript infers the types from the same schemas.',
    slug: 'concepts/tools',
    icon: <path d="M8 6 3 12l5 6m8-12 5 6-5 6M14 4l-4 16" />,
  },
  {
    title: 'Honest outcomes',
    body: 'If a tool with side effects fails midway, the run ends outcome_unknown instead of retrying blindly. Your code decides how to reconcile.',
    slug: 'concepts/outcomes',
    icon: <path d="M12 8v5m0 3.5v.5M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />,
  },
];

function Principles() {
  return (
    <section className="border-y border-line bg-soft/50">
      <div className="mx-auto max-w-[90rem] px-4 py-20 sm:px-6">
        <SectionHeading eyebrow="Guarantees, not guidelines" title="Safe defaults, enforced by the runtime">
          The rules that keep an agent in bounds aren’t prompts or conventions. They’re checked on every model call,
          every tool call and every step.
        </SectionHeading>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {principles.map(principle => (
            <Link key={principle.title} to="/docs/$/" params={{ _splat: principle.slug }}
              className="group rounded-2xl border border-line bg-raised p-6 transition hover:-translate-y-0.5 hover:border-primary/50">
              <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
                <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {principle.icon}
                </svg>
              </span>
              <h3 className="mt-5 font-semibold">{principle.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{principle.body}</p>
              <span className="mt-4 inline-block text-sm text-primary opacity-80 group-hover:opacity-100">Learn more →</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---- Workflows ------------------------------------------------------------------------------------------------------

function Workflows() {
  const points = [
    ['Survive restarts', 'Each step is recorded before it starts and after it finishes, in SQLite or PostgreSQL.'],
    ['Wait for people and time', 'Approvals, typed questions, timers and signals, for as long as it takes.'],
    ['Never repeat an unknown effect', 'Idempotency keys, sagas with compensation, and loops with limits.'],
    ['Operate them live', 'Pause, resume, cancel, version and migrate runs that are already in flight.'],
  ];
  return (
    <section className="mx-auto grid max-w-[90rem] items-center gap-12 px-4 py-24 sm:px-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-16">
      <Window title="fulfil-order.ts">
        <Html html={workflowSnippet} className="snippet" />
      </Window>
      <div className="lg:order-first">
        <p className="text-sm font-medium text-primary">Durable workflows</p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">When one run isn’t enough</h2>
        <p className="mt-4 text-lg leading-relaxed text-muted">
          The same agents and tools become steps in workflows that wait days for an approval, survive a deploy or a
          crash, and carry on in another process.
        </p>
        <dl className="mt-8 grid gap-6 sm:grid-cols-2">
          {points.map(([title, body]) => (
            <div key={title} className="border-l-2 border-gold/70 pl-4">
              <dt className="font-medium">{title}</dt>
              <dd className="mt-1 text-sm leading-relaxed text-muted">{body}</dd>
            </div>
          ))}
        </dl>
        <Link to="/docs/$/" params={{ _splat: 'guides/durable-workflows' }} className="mt-8 inline-block text-sm font-medium text-primary hover:underline">
          Durable workflows guide →
        </Link>
      </div>
    </section>
  );
}

// ---- Features -------------------------------------------------------------------------------------------------------

const features: { title: string; body: string; slug: string }[] = [
  { title: 'Any model', body: 'OpenAI, Anthropic and OpenAI-compatible providers, with routing and automatic failover.', slug: 'guides/model-providers' },
  { title: 'Streaming', body: 'Show an agent’s answer as it’s written, with guards on every batch.', slug: 'guides/streaming' },
  { title: 'Vision', body: 'Agents that see images and PDFs, checked by their own bytes and never shown to logs.', slug: 'guides/vision' },
  { title: 'People in the loop', body: 'Approvals and typed questions, answered from code, the CLI, a React form or the console.', slug: 'guides/approvals-and-human-input' },
  { title: 'Guardrails and hooks', body: 'Input and output guards, PII redaction, moderation, and hooks that can stop a run.', slug: 'guides/guardrails' },
  { title: 'Memory and context', body: 'Native memory with keyword, semantic and hybrid search, plus Mem0, Supermemory and OpenViking.', slug: 'guides/memory-and-context' },
  { title: 'Multi-agent', body: 'Child agents, agents as tools and speculative branches under one shared budget.', slug: 'guides/child-agents' },
  { title: 'Skills, MCP and Code Mode', body: 'Load SKILL.md skills on demand, call MCP tools, run model-written code in a sandbox.', slug: 'guides/code-mode' },
  { title: 'Serve it anywhere', body: 'An authenticated HTTP server with live events, a browser client and React hooks.', slug: 'guides/server-and-client' },
  { title: 'Operator console', body: 'A UI for runs, workflows and approvals, and CLI commands for the same.', slug: 'guides/operator-console' },
  { title: 'Observability', body: 'Run events, workflow tracing and OpenTelemetry export. Nothing is sent unless you configure it.', slug: 'guides/observability' },
  { title: 'Test offline', body: 'Scripted models run agents, tools and workflows with no network and no API key.', slug: 'guides/testing' },
];

function Features() {
  return (
    <section className="border-t border-line">
      <div className="mx-auto max-w-[90rem] px-4 py-24 sm:px-6">
        <SectionHeading eyebrow="Progressive" title="Start with one agent. Add the rest when you need it.">
          Each capability is its own entry point, and native dependencies like SQLite, PostgreSQL, QuickJS and React are
          installed only by projects that use them. The core needs no database, server or hosted account.
        </SectionHeading>
        <div className="mt-12 grid overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4" style={{ gap: '1px' }}>
          {features.map(feature => (
            <Link key={feature.title} to="/docs/$/" params={{ _splat: feature.slug }} className="bg-bg p-6 transition hover:bg-soft">
              <h3 className="font-medium">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{feature.body}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---- CLI ------------------------------------------------------------------------------------------------------------

const starters = [
  ['support-agent', 'Customer support chat with a React UI, streamed replies, per-customer memory and redaction.'],
  ['approval-workflow', 'Refunds that wait for an operator to approve the exact payment in the console.'],
  ['research-team', 'A planner, parallel researchers and a writer with checked citations, under one budget.'],
  ['event-automation', 'Signed webhooks start workflows where a triage agent acts through MCP tools.'],
  ['cli-agent', 'A command-line assistant for the folder you run it in; you confirm every write.'],
];

function Cli() {
  return (
    <section className="border-y border-line bg-soft/50">
      <div className="mx-auto grid max-w-[90rem] gap-12 px-4 py-24 sm:px-6 lg:grid-cols-2 lg:gap-16">
        <div>
          <p className="text-sm font-medium text-primary">The mayura CLI</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">From an empty folder to production</h2>
          <p className="mt-4 text-lg leading-relaxed text-muted">
            <code className="font-mono text-[0.9em] text-fg">mayura init</code> asks for a starter and a model provider,
            shows its plan, and writes only when you confirm. Your API key goes into the project’s <code className="font-mono text-[0.9em] text-fg">.env</code> and
            nowhere else.
          </p>
          <div className="mt-8">
            <Window title="terminal">
              <Html html={cliSnippet} className="snippet" />
            </Window>
          </div>
        </div>
        <div className="lg:pt-12">
          <h3 className="text-sm font-semibold tracking-wide text-muted uppercase">Starters</h3>
          <ul className="mt-4 divide-y divide-line rounded-2xl border border-line bg-raised">
            {starters.map(([name, body]) => (
              <li key={name} className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-baseline sm:gap-4">
                <code className="shrink-0 font-mono text-sm text-primary sm:w-44">{name}</code>
                <span className="text-sm text-muted">{body}</span>
              </li>
            ))}
          </ul>
          <Link to="/docs/$/" params={{ _splat: 'cli/init' }} className="mt-6 inline-block text-sm font-medium text-primary hover:underline">
            Every starter and template →
          </Link>
        </div>
      </div>
    </section>
  );
}

// ---- AI coding assistants -------------------------------------------------------------------------------------------

function Assistants() {
  return (
    <section className="mx-auto max-w-[90rem] px-4 py-24 sm:px-6">
      <div className="grid gap-10 rounded-3xl border border-line bg-raised p-8 sm:p-12 lg:grid-cols-[1.2fr_1fr] lg:items-center">
        <div>
          <p className="text-sm font-medium text-primary">Built for AI coding agents</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-balance">Docs your assistant reads, for the version you installed</h2>
          <p className="mt-4 leading-relaxed text-muted">
            The documentation ships inside the package, with <code className="font-mono text-[0.9em] text-fg">llms.txt</code>,{' '}
            <code className="font-mono text-[0.9em] text-fg">llms-full.txt</code> and typed entry points, so Claude Code,
            Cursor, Codex and others read docs that match your code, even offline. Projects from{' '}
            <code className="font-mono text-[0.9em] text-fg">mayura init</code> include an <code className="font-mono text-[0.9em] text-fg">AGENTS.md</code> that
            points them there.
          </p>
          <div className="mt-6 flex flex-wrap gap-4 text-sm">
            <Link to="/docs/$/" params={{ _splat: 'ai-agents' }} className="font-medium text-primary hover:underline">Using Mayura with AI agents →</Link>
            <a href={asset('llms.txt')} className="text-muted hover:text-fg">llms.txt</a>
            <a href={asset('llms-full.txt')} className="text-muted hover:text-fg">llms-full.txt</a>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-code p-5 font-mono text-[0.8rem] leading-7 text-muted">
          <div className="text-fg">node_modules/mayura/</div>
          <div>├── docs/ <span className="opacity-60"># this documentation, as Markdown</span></div>
          <div>├── llms.txt <span className="opacity-60"># an index for assistants</span></div>
          <div>├── llms-full.txt <span className="opacity-60"># everything in one file</span></div>
          <div>└── lib/*/dist/*.d.ts <span className="opacity-60"># exact types</span></div>
        </div>
      </div>
    </section>
  );
}

// ---- Closing --------------------------------------------------------------------------------------------------------

function Closing() {
  return (
    <section className="relative overflow-hidden border-t border-line">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_bottom,color-mix(in_srgb,var(--primary)_16%,transparent),transparent_60%)]" />
      <div className="mx-auto flex max-w-3xl flex-col items-center px-4 py-24 text-center">
        <LogoMark className="size-12" />
        <h2 className="mt-6 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Build your first agent in a few minutes</h2>
        <p className="mt-4 text-lg text-muted">Run it offline first, then on any model you choose.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link to="/docs/$/" params={{ _splat: 'quickstart' }}
            className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-on-primary shadow-sm hover:bg-primary-hover">
            Follow the quickstart
          </Link>
          <a href={site.repository} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-lg border border-line bg-raised px-5 py-2.5 text-sm font-medium hover:border-muted/40">
            <GitHubIcon className="size-4" /> Star on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}

function SectionHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <div className="max-w-2xl">
      <p className="text-sm font-medium text-primary">{eyebrow}</p>
      <h2 className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h2>
      <p className="mt-4 text-lg leading-relaxed text-muted">{children}</p>
    </div>
  );
}
