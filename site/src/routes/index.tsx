import { createFileRoute, Link } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
import agentSnippet from 'virtual:mayura-snippet/agent.ts';
import runSnippet from 'virtual:mayura-snippet/run.ts';
import serveSnippet from 'virtual:mayura-snippet/serve.ts';
import testSnippet from 'virtual:mayura-snippet/test.ts';
import workflowSnippet from 'virtual:mayura-snippet/workflow.ts';
import { GitHubIcon } from '../components/Header';
import { Html } from '../components/Html';
import { Icon, type IconName } from '../components/Icon';
import { LogoMark } from '../components/Logo';
import { WorksWith } from '../components/Logos';
import {
  CostArt, MemoryArt, ModelsArt, PolicyPreview, RunPreview, ServePreview, StreamingArt, TestPreview, TraceArt, VisionArt,
  WorkflowPreview,
} from '../components/Visuals';
import { pageMeta, site } from '../lib/site';

export const Route = createFileRoute('/')({
  head: () => pageMeta({ title: `${site.name}: ${site.tagline}`, description: site.description, path: '/' }),
  component: Home,
});

function Home() {
  return (
    <main>
      <Hero />
      <Guarantees />
      <WorksWith />
      <Tour />
      <Features />
      <GetStarted />
      <Faq />
      <Closing />
    </main>
  );
}

const docs = (slug: string) => ({ to: '/docs/$/' as const, params: { _splat: slug } });

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
    <section className="relative overflow-hidden">
      <HeroBackdrop />
      <div className="relative mx-auto flex max-w-5xl flex-col items-center px-4 pt-20 pb-24 text-center sm:px-6 sm:pt-28 sm:pb-32">
        <Link {...docs('project/versioning')}
          className="inline-flex items-center gap-2 rounded-full border border-line bg-bg/70 py-1 pr-3 pl-1 text-xs text-muted backdrop-blur transition hover:text-fg">
          <span className="rounded-full bg-primary/15 px-2 py-0.5 font-medium text-primary">New</span>
          {site.version}: the 1.0 release candidate
          <Icon name="arrow" className="size-3.5" />
        </Link>
        <h1 className="mt-8 text-[2.75rem] leading-[1.02] font-semibold tracking-[-0.045em] text-balance sm:text-7xl md:text-[5.25rem]">
          Build AI agents you can put in production
        </h1>
        <p className="mt-7 max-w-2xl text-lg leading-relaxed text-pretty text-muted sm:text-xl">
          Mayura is the TypeScript framework for <strong className="font-medium text-fg">agents, typed tools and durable
          workflows</strong>, with permissions, budgets and validation enforced by the runtime.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <PrimaryButton slug="quickstart">Get started</PrimaryButton>
          <SecondaryButton slug="introduction">Learn Mayura</SecondaryButton>
        </div>
        <div className="mt-6"><CopyCommand command="npx mayura init" /></div>
      </div>
    </section>
  );
}

/** Frame lines and rings like a blueprint, fading out from the middle. */
function HeroBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
      <div className="absolute inset-x-0 top-0 h-[36rem] bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,color-mix(in_srgb,var(--primary)_16%,transparent),transparent)]" />
      <svg className="absolute top-0 left-1/2 h-full w-[76rem] -translate-x-1/2 [mask-image:radial-gradient(ellipse_65%_60%_at_50%_45%,black,transparent)]" viewBox="0 0 1216 640" fill="none" preserveAspectRatio="xMidYMin slice">
        <g className="stroke-fg/15" strokeWidth="1">
          <path d="M128 0v640M1088 0v640M0 96h1216M0 544h1216" />
          <path d="M288 0v640M928 0v640M0 208h1216M0 432h1216" strokeDasharray="4 6" />
          <circle cx="128" cy="96" r="30" />
          <circle cx="1088" cy="544" r="30" />
        </g>
        <circle cx="1088" cy="96" r="3" className="fill-gold" />
        <circle cx="128" cy="544" r="3" className="fill-primary" />
      </svg>
    </div>
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
  { title: 'Any model, with failover', body: 'OpenAI, Anthropic and OpenAI-compatible providers, routed with automatic failover.', slug: 'guides/model-routing', art: <ModelsArt /> },
  { title: 'Cost control', body: 'Prices, per-call caps and shared budgets, from the tokens providers report.', slug: 'concepts/costs-and-budgets', art: <CostArt /> },
  { title: 'Streaming', body: 'Show an answer as it is written, with guards on every batch.', slug: 'guides/streaming', art: <StreamingArt /> },
  { title: 'Vision', body: 'Agents that see images and PDFs, checked by their own bytes.', slug: 'guides/vision', art: <VisionArt /> },
  { title: 'Memory and context', body: 'Native memory with keyword, semantic and hybrid search.', slug: 'guides/memory-and-context', art: <MemoryArt /> },
  { title: 'Observability', body: 'Run events, workflow tracing and OpenTelemetry export.', slug: 'guides/observability', art: <TraceArt /> },
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
          <Link {...docs('guides/react')} className="text-fg hover:text-primary">React</Link> and the{' '}
          <Link {...docs('guides/operator-console')} className="text-fg hover:text-primary">operator console</Link>.
        </p>
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
            Each starter is complete, with tests, a worker and deployment files. Your API key goes into
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

// ---- FAQ ------------------------------------------------------------------------------------------------------------

const questions: { q: string; a: ReactNode }[] = [
  { q: 'What is Mayura?', a: <>A TypeScript framework for AI agents, typed tools and durable workflows. You describe an agent with schemas, give it tools and a model, and run it under an allow-list of permissions and limits. It is one npm package, <code>mayura</code>, with a CLI of the same name.</> },
  { q: 'Do I need to install anything else?', a: <>No. <code>npm install mayura</code> is enough to build agents: schemas use <code>z</code> from <code>mayura</code> (it is Zod). Optional parts such as SQLite or PostgreSQL storage, the QuickJS sandbox and React hooks each need one extra package, only if you use them.</> },
  { q: 'Which models can I use?', a: <>OpenAI and Anthropic natively, and any OpenAI-compatible provider, such as Groq, Gemini, Mistral, DeepSeek, xAI, OpenRouter, Together, Fireworks, Azure OpenAI and local servers. A router fails over between them.</> },
  { q: 'How does Mayura keep agents in bounds?', a: <>A run can use a model, tool or effect only when you grant it, every run has cost, step, tool-call and time limits, and every input and output is validated. When a side effect may or may not have happened, the run ends <code>outcome_unknown</code> instead of retrying blindly.</> },
  { q: 'Can I test without an API key?', a: <>Yes. Scripted models from <code>mayura/testing</code> replay fixed responses, so agents, tools and workflows run offline in your tests.</> },
  { q: 'Where can I deploy Mayura?', a: <>Anywhere Node.js 22 or 24 runs: containers, Kubernetes, managed platforms such as Cloud Run, ECS and Fly.io, your own servers, inside an app you already run, and serverless functions on Vercel, with AWS Lambda and Cloud Run functions experimental. Edge runtimes are planned for 1.1. See <Link {...docs('guides/deployment')} className="text-primary hover:underline">Deployment</Link>.</> },
  { q: 'Is Mayura ready for production?', a: <>Mayura is at the 1.0 release candidate. From 1.0.0, every entry point is stable under semantic versioning; until then, pin the exact version and try it in a pilot first. See <Link {...docs('project/versioning')} className="text-primary hover:underline">Versioning and stability</Link>.</> },
  { q: 'Is Mayura open source?', a: <>Yes, under the Apache-2.0 license, on <a href={site.repository} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">GitHub</a>.</> },
];

function Faq() {
  return (
    <section className="border-t border-line px-4 py-24 sm:px-6 sm:py-32">
      <Heading strong="Frequently asked questions" />
      <div className="mx-auto mt-12 max-w-3xl divide-y divide-line overflow-hidden rounded-2xl border border-line bg-raised">
        {questions.map(({ q, a }) => (
          <details key={q} className="group [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:text-fg">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 font-medium transition hover:bg-soft [&::-webkit-details-marker]:hidden">
              {q}
              <Icon name="arrow" className="size-4 shrink-0 text-muted transition group-open:rotate-90" />
            </summary>
            <p className="px-6 pb-6 text-sm leading-relaxed text-muted">{a}</p>
          </details>
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
          <PrimaryButton slug="quickstart">Get started</PrimaryButton>
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
