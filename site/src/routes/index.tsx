import { createFileRoute, Link } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
import agentSnippet from 'virtual:mayura-snippet/agent.ts';
import runSnippet from 'virtual:mayura-snippet/run.ts';
import testSnippet from 'virtual:mayura-snippet/test.ts';
import workflowSnippet from 'virtual:mayura-snippet/workflow.ts';
import { GitHubIcon } from '../components/Header';
import { Html } from '../components/Html';
import { Icon, type IconName } from '../components/Icon';
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
      <Features />
      <UseCases />
      <GetStarted />
      <SafeByDefault />
      <Closing />
    </main>
  );
}

const docs = (slug: string) => ({ to: '/docs/$/' as const, params: { _splat: slug } });

// ---- Hero -----------------------------------------------------------------------------------------------------------

const tabs = [
  { label: 'Agent', file: 'agent.ts', html: agentSnippet, caption: 'Tools are typed functions with declared effects. The agent’s input and output are schemas.' },
  { label: 'Run', file: 'main.ts', html: runSnippet, caption: 'The runtime grants only what you list, caps the cost, and tells you exactly how the run ended.' },
  { label: 'Workflow', file: 'refund.ts', html: workflowSnippet, caption: 'Durable workflows wait for approvals, timers and signals, and survive restarts.' },
  { label: 'Test', file: 'agent.test.ts', html: testSnippet, caption: 'Scripted models run the same agent offline, so tests are fast and free.' },
];

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-48 left-1/2 h-[40rem] w-[70rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--primary)_20%,transparent),transparent)]" />
        <div className="absolute top-40 -right-32 h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--gold)_14%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,var(--line)_1px,transparent_1px),linear-gradient(to_bottom,var(--line)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_at_top,black_15%,transparent_65%)] bg-[size:56px_56px] opacity-40" />
      </div>

      <div className="mx-auto grid max-w-7xl items-center gap-14 px-4 pt-16 pb-24 sm:px-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:pt-24 lg:pb-32">
        <div>
          <Link {...docs('project/versioning')}
            className="inline-flex items-center gap-2 rounded-full border border-line bg-raised/70 px-3 py-1 text-xs text-muted backdrop-blur hover:text-fg">
            <span className="size-1.5 rounded-full bg-gold" />
            {site.version} is out · release candidate
          </Link>
          <h1 className="mt-6 text-[2.6rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
            AI agents that only do{' '}
            <span className="bg-gradient-to-r from-primary via-blue to-gold bg-clip-text text-transparent">what you allow</span>
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-relaxed text-pretty text-muted">
            A TypeScript framework for agents, typed tools and durable workflows, with permissions, budgets and
            validation enforced by the runtime.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link {...docs('quickstart')}
              className="group inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-on-primary shadow-sm hover:bg-primary-hover">
              Get started <Icon name="arrow" className="size-4 transition group-hover:translate-x-0.5" />
            </Link>
            <Command text="npm install mayura zod" />
          </div>
          <ul className="mt-9 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
            {['One npm package', 'No infrastructure needed', 'Node.js 22 and 24'].map(item => (
              <li key={item} className="flex items-center gap-1.5"><Icon name="check" className="size-4 text-primary" />{item}</li>
            ))}
          </ul>
        </div>
        <CodeTabs />
      </div>
    </section>
  );
}

function CodeTabs() {
  const [active, setActive] = useState(0);
  const id = useId();
  const tab = tabs[active]!;
  return (
    <div className="min-w-0">
      <div className="overflow-hidden rounded-2xl border border-line bg-code shadow-[0_40px_100px_-40px_color-mix(in_srgb,var(--primary)_45%,transparent)]">
        <div className="flex items-center gap-4 border-b border-line bg-soft/70 px-4">
          <div className="hidden gap-1.5 sm:flex" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-muted/25" /><span className="size-2.5 rounded-full bg-muted/25" /><span className="size-2.5 rounded-full bg-muted/25" />
          </div>
          <div role="tablist" aria-label="Code examples" className="flex overflow-x-auto [scrollbar-width:none]"
            onKeyDown={event => {
              const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
              if (!step) return;
              const next = (active + step + tabs.length) % tabs.length;
              setActive(next);
              document.getElementById(`${id}-tab-${next}`)?.focus();
            }}>
            {tabs.map((item, index) => (
              <button key={item.label} id={`${id}-tab-${index}`} type="button" role="tab" aria-selected={index === active}
                aria-controls={`${id}-panel`} tabIndex={index === active ? 0 : -1} onClick={() => setActive(index)}
                className={`relative px-3 py-3 text-sm whitespace-nowrap transition ${index === active
                  ? 'font-medium text-fg after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary'
                  : 'text-muted hover:text-fg'}`}>
                {item.label}
              </button>
            ))}
          </div>
          <span className="ml-auto hidden font-mono text-xs text-muted sm:inline">{tab.file}</span>
        </div>
        <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${active}`}>
          <Html html={tab.html} className="snippet min-h-[30.5rem]" />
        </div>
      </div>
      <p className="mt-4 px-1 text-sm text-muted">{tab.caption}</p>
    </div>
  );
}

function Command({ text }: { text: string }) {
  return (
    <Html className="[&_.code-block]:m-0 [&_.code-block]:bg-raised/80"
      html={`<div class="code-block"><button type="button" class="code-copy" data-copy aria-label="Copy command">Copy</button><pre class="!py-2.5 !pr-16 !pl-3.5 !text-[0.8rem]"><span class="select-none opacity-50">$ </span>${text}</pre></div>`} />
  );
}

// ---- Features -------------------------------------------------------------------------------------------------------

const features: { icon: IconName; title: string; body: string; slug: string }[] = [
  { icon: 'braces', title: 'Typed agents and tools', body: 'Schemas in, schemas out, checked at runtime and inferred in TypeScript.', slug: 'concepts/tools' },
  { icon: 'models', title: 'Any model', body: 'OpenAI, Anthropic and OpenAI-compatible providers, with automatic failover.', slug: 'guides/model-providers' },
  { icon: 'gauge', title: 'Cost control', body: 'Prices, per-call caps and budgets on every run, shared across agents.', slug: 'concepts/costs-and-budgets' },
  { icon: 'workflow', title: 'Durable workflows', body: 'Steps, timers, signals, sagas and loops on SQLite or PostgreSQL.', slug: 'guides/durable-workflows' },
  { icon: 'user', title: 'People in the loop', body: 'Approvals and typed questions, answered from code, CLI or UI.', slug: 'guides/approvals-and-human-input' },
  { icon: 'flask', title: 'Test offline', body: 'Scripted models run everything with no network and no API key.', slug: 'guides/testing' },
];

const more = [
  ['Streaming', 'guides/streaming'], ['Vision', 'guides/vision'], ['Memory', 'guides/memory-and-context'],
  ['MCP tools', 'guides/mcp'], ['Code Mode', 'guides/code-mode'], ['Guardrails', 'guides/guardrails'],
  ['Child agents', 'guides/child-agents'], ['React', 'guides/react'], ['Operator console', 'guides/operator-console'],
  ['OpenTelemetry', 'guides/observability'],
] as const;

function Features() {
  return (
    <section className="border-t border-line">
      <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:py-28">
        <SectionHeading eyebrow="Features" title="Everything an agent needs in production"
          lead="Start with one agent in one file. Every other part is its own entry point, there when you need it." />
        <div className="mt-14 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(feature => (
            <Link key={feature.title} {...docs(feature.slug)} className="group flex gap-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-line bg-raised text-primary transition group-hover:border-primary/50 group-hover:bg-primary/10">
                <Icon name={feature.icon} />
              </span>
              <span>
                <span className="block font-semibold group-hover:text-primary">{feature.title}</span>
                <span className="mt-1 block text-sm leading-relaxed text-muted">{feature.body}</span>
              </span>
            </Link>
          ))}
        </div>
        <div className="mt-14 flex flex-wrap items-center justify-center gap-2">
          <span className="mr-1 text-sm text-muted">And</span>
          {more.map(([label, slug]) => (
            <Link key={label} {...docs(slug)}
              className="rounded-full border border-line bg-raised px-3 py-1 text-sm text-muted transition hover:border-primary/50 hover:text-fg">
              {label}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---- What you can build ---------------------------------------------------------------------------------------------

const useCases: { icon: IconName; title: string; body: string; starter: string; wide?: boolean }[] = [
  { icon: 'chat', title: 'Support assistants', body: 'Streamed chat that acts on orders for the signed-in customer, remembers them and redacts card numbers.', starter: 'support-agent', wide: true },
  { icon: 'shield', title: 'Approval workflows', body: 'Refunds that wait for a person to approve the exact payment.', starter: 'approval-workflow' },
  { icon: 'team', title: 'Research teams', body: 'A planner, parallel researchers and a writer, under one budget.', starter: 'research-team' },
  { icon: 'bolt', title: 'Event automations', body: 'Signed webhooks start workflows that act through MCP tools.', starter: 'event-automation' },
  { icon: 'terminal', title: 'Command-line assistants', body: 'Chat with an agent in your terminal; you confirm every write.', starter: 'cli-agent' },
];

function UseCases() {
  return (
    <section className="border-t border-line bg-soft/50">
      <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:py-28">
        <SectionHeading eyebrow="What you can build" title="Start from a project that already works"
          lead="Each starter is a complete project with tests. Pick one, then make it yours." />
        <div className="mt-14 grid gap-4 md:grid-cols-3">
          {useCases.map(useCase => (
            <div key={useCase.starter}
              className={`group flex flex-col rounded-2xl border border-line bg-raised p-6 transition hover:border-primary/40 hover:shadow-[0_20px_50px_-30px_color-mix(in_srgb,var(--primary)_50%,transparent)] ${useCase.wide ? 'md:col-span-2' : ''}`}>
              <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary"><Icon name={useCase.icon} /></span>
              <h3 className="mt-5 text-lg font-semibold">{useCase.title}</h3>
              <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">{useCase.body}</p>
              <code className="mt-auto pt-6 font-mono text-xs text-muted">
                <span className="rounded-md border border-line bg-code px-2 py-1 transition group-hover:text-primary">--starter {useCase.starter}</span>
              </code>
            </div>
          ))}
        </div>
        <p className="mt-8 text-center text-sm">
          <Link {...docs('cli/init')} className="font-medium text-primary hover:underline">See every starter and template →</Link>
        </p>
      </div>
    </section>
  );
}

// ---- Get started ----------------------------------------------------------------------------------------------------

const steps = [
  { title: 'Create', command: 'npx mayura init', body: 'Pick a starter and a model provider. Your key goes into .env, nowhere else.' },
  { title: 'Develop', command: 'npm run dev', body: 'Build, run and restart on every save, with your .env loaded.' },
  { title: 'Ship', command: 'mayura serve', body: 'An authenticated HTTP server, and mayura worker for durable workflows.' },
];

function GetStarted() {
  return (
    <section className="border-t border-line">
      <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:py-28">
        <SectionHeading eyebrow="Get started" title="From an empty folder to a served agent in minutes" center />
        <ol className="relative mt-16 grid gap-10 md:grid-cols-3 md:gap-8">
          <li aria-hidden="true" className="absolute top-5 right-[16%] left-[16%] hidden h-px bg-gradient-to-r from-primary/10 via-primary/50 to-primary/10 md:block" />
          {steps.map((step, index) => (
            <li key={step.title} className="relative flex flex-col items-center text-center">
              <span className="grid size-10 place-items-center rounded-full border border-primary/40 bg-bg font-mono text-sm font-semibold text-primary">
                {index + 1}
              </span>
              <h3 className="mt-5 text-lg font-semibold">{step.title}</h3>
              <code className="mt-3 rounded-lg border border-line bg-code px-3 py-1.5 font-mono text-sm">{step.command}</code>
              <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-14 flex flex-wrap justify-center gap-3">
          <Link {...docs('quickstart')} className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-on-primary hover:bg-primary-hover">
            Follow the quickstart
          </Link>
          <Link {...docs('guides/deployment')} className="rounded-lg border border-line bg-raised px-5 py-2.5 text-sm font-medium hover:border-muted/40">
            Deployment guide
          </Link>
        </div>
      </div>
    </section>
  );
}

// ---- Safe by default ------------------------------------------------------------------------------------------------

const principles: { icon: IconName; title: string; body: string; slug: string }[] = [
  { icon: 'shield', title: 'Nothing is allowed by default', body: 'Models, tools and effects need an explicit grant.', slug: 'concepts/permissions' },
  { icon: 'gauge', title: 'Every run has limits', body: 'Cost, steps, tool calls and time are always capped.', slug: 'concepts/costs-and-budgets' },
  { icon: 'braces', title: 'Types at every boundary', body: 'Input and output your schemas reject never reach your code.', slug: 'concepts/tools' },
  { icon: 'alert', title: 'Honest outcomes', body: 'Unknown effects end as outcome_unknown, never a blind retry.', slug: 'concepts/outcomes' },
];

function SafeByDefault() {
  return (
    <section className="border-t border-line bg-soft/50">
      <div className="mx-auto grid max-w-7xl items-center gap-14 px-4 py-24 sm:px-6 lg:grid-cols-2 lg:gap-20 lg:py-28">
        <div>
          <SectionHeading eyebrow="Safe by default" title="Guarantees the runtime enforces, not conventions you hope for" />
          <ul className="mt-10 space-y-6">
            {principles.map(principle => (
              <li key={principle.title}>
                <Link {...docs(principle.slug)} className="group flex gap-4">
                  <span className="mt-0.5 text-primary"><Icon name={principle.icon} /></span>
                  <span>
                    <span className="font-semibold group-hover:text-primary">{principle.title}</span>
                    <span className="mt-0.5 block text-sm text-muted">{principle.body}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <PolicyCard />
      </div>
    </section>
  );
}

/** An illustration of what the runtime checks during one run: grants, a refused call and the budget. */
function PolicyCard() {
  const grants = [
    { name: 'model:openai.responses', allowed: true },
    { name: 'tool:orders.lookup', allowed: true },
    { name: 'effect:read', allowed: true },
    { name: 'tool:orders.refund', allowed: false },
  ];
  return (
    <figure className="rounded-2xl border border-line bg-raised p-6 shadow-[0_30px_80px_-40px_color-mix(in_srgb,var(--primary)_40%,transparent)] sm:p-8">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold">One run, as the runtime sees it</span>
        <span className="rounded-full bg-primary/10 px-2.5 py-0.5 font-mono text-xs text-primary">support</span>
      </div>
      <ul className="mt-6 space-y-2.5 font-mono text-[0.8rem]">
        {grants.map(grant => (
          <li key={grant.name} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${grant.allowed ? 'border-line bg-code' : 'border-red-500/30 bg-red-500/5'}`}>
            <span className={`grid size-5 shrink-0 place-items-center rounded-full ${grant.allowed ? 'bg-primary/15 text-primary' : 'bg-red-500/15 text-red-600 dark:text-red-400'}`}>
              <Icon name={grant.allowed ? 'check' : 'x'} className="size-3" />
            </span>
            <span className={`truncate ${grant.allowed ? 'text-fg' : 'text-red-700 dark:text-red-300'}`}>{grant.name}</span>
            <span className="ml-auto shrink-0 font-sans text-xs text-muted">{grant.allowed ? 'granted' : 'refused'}</span>
          </li>
        ))}
      </ul>
      <div className="mt-7">
        <div className="flex justify-between text-xs text-muted">
          <span>Run budget</span><span className="font-mono">$0.043 of $0.10</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-soft">
          <div className="h-full w-[43%] rounded-full bg-gradient-to-r from-primary to-gold" />
        </div>
      </div>
      <figcaption className="mt-5 text-xs text-muted">An illustration: permissions and limits are checked before every model and tool call.</figcaption>
    </figure>
  );
}

// ---- Closing --------------------------------------------------------------------------------------------------------

function Closing() {
  return (
    <section className="relative overflow-hidden border-t border-line">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_bottom,color-mix(in_srgb,var(--primary)_16%,transparent),transparent_60%)]" />
      <div className="mx-auto flex max-w-3xl flex-col items-center px-4 py-24 text-center lg:py-28">
        <LogoMark className="size-12" />
        <h2 className="mt-6 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Build your first agent today</h2>
        <p className="mt-4 text-lg text-muted">Open source under Apache-2.0, documented for you and your coding assistant.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link {...docs('quickstart')} className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-on-primary shadow-sm hover:bg-primary-hover">
            Get started
          </Link>
          <a href={site.repository} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-lg border border-line bg-raised px-5 py-2.5 text-sm font-medium hover:border-muted/40">
            <GitHubIcon className="size-4" /> Star on GitHub
          </a>
        </div>
        <p className="mt-8 text-sm text-muted">
          Using an AI coding assistant? Point it at <a href={asset('llms.txt')} className="text-primary hover:underline">llms.txt</a>, or read{' '}
          <Link {...docs('ai-agents')} className="text-primary hover:underline">using Mayura with AI agents</Link>.
        </p>
      </div>
    </section>
  );
}

function SectionHeading({ eyebrow, title, lead, center }: { eyebrow: string; title: string; lead?: ReactNode; center?: boolean }) {
  return (
    <div className={`max-w-2xl ${center ? 'mx-auto text-center' : ''}`}>
      <p className="text-sm font-semibold text-primary">{eyebrow}</p>
      <h2 className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h2>
      {lead && <p className="mt-4 text-lg leading-relaxed text-pretty text-muted">{lead}</p>}
    </div>
  );
}
