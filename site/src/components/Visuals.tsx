// Illustrations for the landing page, drawn in HTML and SVG. They show what Mayura does during a run; they are not
// screenshots of a product UI, and the tour labels them as illustrations.
import type { ReactNode } from 'react';
import { Icon } from './Icon';

/** A panel in the product tour: a titled card on a soft, dotted backdrop. */
export function Panel({ title, badge, children }: { title: string; badge?: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-[22rem] flex-col overflow-hidden rounded-2xl border border-line bg-raised shadow-[0_30px_80px_-50px_rgba(0,0,0,0.6)]">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <span className="text-sm font-medium">{title}</span>
        {badge && <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[0.7rem] text-muted">{badge}</span>}
      </div>
      <div className="flex-1 p-5">{children}</div>
    </div>
  );
}

const Tick = ({ ok = true }: { ok?: boolean }) => (
  <span className={`grid size-5 shrink-0 place-items-center rounded-full ${ok ? 'bg-primary/15 text-primary' : 'bg-red-500/15 text-red-600 dark:text-red-400'}`}>
    <Icon name={ok ? 'check' : 'x'} className="size-3" />
  </span>
);

// ---- Product tour previews ------------------------------------------------------------------------------------------

/** One run, step by step: input, a tool call, and an output checked against the schema. */
export function RunPreview() {
  const steps = [
    { label: 'input', body: '{ "question": "Do I need an umbrella?" }', note: 'matches input schema' },
    { label: 'model', body: 'calls weather.get { "city": "Paris" }', note: 'openai.responses · $0.0009' },
    { label: 'tool', body: 'weather.get → { "celsius": 21 }', note: 'effect: read · granted' },
    { label: 'output', body: '{ "reply": "No umbrella needed." }', note: 'matches output schema' },
  ];
  return (
    <Panel title="Run" badge="succeeded">
      <ol className="relative space-y-4 before:absolute before:top-2 before:bottom-2 before:left-[9px] before:w-px before:bg-line">
        {steps.map((step, index) => (
          <li key={step.label} className="rise-in relative flex gap-3" style={{ animationDelay: `${index * 90}ms` }}>
            <Tick />
            <div className="min-w-0">
              <div className="font-mono text-[0.7rem] tracking-wide text-muted uppercase">{step.label}</div>
              <div className="mt-0.5 truncate font-mono text-[0.8rem] text-fg">{step.body}</div>
              <div className="mt-0.5 text-xs text-muted">{step.note}</div>
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/** The allow-list at work: grants, a refused tool and the run's budget. */
export function PolicyPreview() {
  const grants = [
    { name: 'model:openai.responses', ok: true },
    { name: 'tool:weather.get', ok: true },
    { name: 'effect:read', ok: true },
    { name: 'tool:orders.refund', ok: false },
  ];
  return (
    <Panel title="Permissions and limits" badge="per run">
      <ul className="space-y-2 font-mono text-[0.78rem]">
        {grants.map(grant => (
          <li key={grant.name} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${grant.ok ? 'border-line bg-code' : 'border-red-500/30 bg-red-500/5'}`}>
            <Tick ok={grant.ok} />
            <span className={`truncate ${grant.ok ? '' : 'text-red-700 dark:text-red-300'}`}>{grant.name}</span>
            <span className="ml-auto shrink-0 font-sans text-xs text-muted">{grant.ok ? 'granted' : 'refused'}</span>
          </li>
        ))}
      </ul>
      <div className="mt-6">
        <div className="flex justify-between text-xs text-muted"><span>Budget</span><span className="font-mono">$0.043 of $0.10</span></div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-soft"><div className="h-full w-[43%] rounded-full bg-gradient-to-r from-primary to-gold" /></div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
          {[['steps', '3 / 20'], ['tool calls', '1 / 10'], ['time', '2.1s / 60s']].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-line py-2"><div className="font-mono text-fg">{value}</div><div className="text-muted">{label}</div></div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

/** A durable refund workflow paused on a person's approval. */
export function WorkflowPreview() {
  return (
    <Panel title="orders.refund" badge="waiting">
      <div className="flex flex-col items-center gap-3 pt-2">
        <Node label="check" state="done" note="policy ok" />
        <Edge />
        <Node label="pay" state="waiting" note="waiting for approval" />
        <Edge dashed />
        <Node label="notify" state="pending" note="next" />
      </div>
      <div className="mt-6 rounded-xl border border-line bg-code p-4">
        <div className="text-sm font-medium">Approve refund of $42.00?</div>
        <div className="mt-1 text-xs text-muted">Order o-1001 · requested by the triage agent</div>
        <div className="mt-3 flex gap-2">
          <span className="rounded-md bg-fg px-3 py-1 text-xs font-medium text-bg">Approve</span>
          <span className="rounded-md border border-line px-3 py-1 text-xs">Reject</span>
        </div>
      </div>
    </Panel>
  );
}

function Node({ label, state, note }: { label: string; state: 'done' | 'waiting' | 'pending'; note: string }) {
  const tone = state === 'done' ? 'border-primary/50 text-primary' : state === 'waiting' ? 'border-gold/60 text-gold' : 'border-line text-muted';
  return (
    <div className={`flex w-56 items-center gap-3 rounded-xl border bg-code px-3 py-2 ${tone}`}>
      <span className={`size-2.5 rounded-full ${state === 'done' ? 'bg-primary' : state === 'waiting' ? 'pulse-ring bg-gold' : 'bg-muted/40'}`} />
      <span className="font-mono text-sm text-fg">{label}</span>
      <span className="ml-auto text-xs">{note}</span>
    </div>
  );
}

const Edge = ({ dashed }: { dashed?: boolean }) => <span className={`h-5 w-px ${dashed ? 'border-l border-dashed border-muted/50' : 'bg-primary/50'}`} />;

/** The routes a server exposes and the capability each needs (from the server guide). */
export function ServePreview() {
  const routes = [
    ['POST', '/v1/runs', 'runs:submit'],
    ['GET', '/v1/runs/:id/events', 'runs:read'],
    ['POST', '/v1/runs/:id/cancel', 'runs:cancel'],
    ['POST', '/v1/human-requests/:id/responses', 'humans:respond'],
    ['POST', '/v1/workflow-runs/:id/approvals', 'workflows:control'],
  ];
  return (
    <Panel title="mayura serve" badge="authenticated">
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-code font-mono text-[0.75rem]">
        {routes.map(([method, path, capability]) => (
          <li key={path} className="flex items-center gap-3 px-3 py-2.5">
            <span className={`w-10 shrink-0 font-semibold ${method === 'GET' ? 'text-blue' : 'text-primary'}`}>{method}</span>
            <span className="truncate text-fg">{path}</span>
            <span className="ml-auto hidden shrink-0 text-muted sm:inline">{capability}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs leading-relaxed text-muted">
        Every request carries a token you verify. The token decides which agents a caller may run and what it may do.
      </p>
    </Panel>
  );
}

/** A test run on a scripted model. */
export function TestPreview() {
  const tests = ['looks the order up before answering', 'refuses a refund that is not granted', 'stops at the cost limit', 'waits for approval before paying'];
  return (
    <Panel title="npm test" badge="offline">
      <div className="rounded-xl border border-line bg-code p-4 font-mono text-[0.78rem] leading-7">
        {tests.map((test, index) => (
          <div key={test} className="rise-in flex items-center gap-2" style={{ animationDelay: `${index * 120}ms` }}>
            <span className="text-primary">✓</span><span className="truncate">{test}</span>
          </div>
        ))}
        <div className="mt-3 border-t border-line pt-3 text-muted">4 passed · 0 network calls · $0.00</div>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-muted">Scripted models replay fixed responses, so tests need no API key and no network.</p>
    </Panel>
  );
}

// ---- Feature card illustrations -------------------------------------------------------------------------------------

export function ModelsArt() {
  return (
    <div className="w-full max-w-60 space-y-2 font-mono text-[0.72rem]">
      <div className="flex items-center gap-2 rounded-lg border border-line bg-code px-3 py-2 opacity-70"><Tick ok={false} /><span>openai.responses</span><span className="ml-auto text-muted">429</span></div>
      <div className="flex justify-center"><Icon name="arrow" className="size-4 rotate-90 text-muted" /></div>
      <div className="flex items-center gap-2 rounded-lg border border-primary/40 bg-code px-3 py-2"><Tick /><span>anthropic.messages</span><span className="ml-auto text-primary">200</span></div>
    </div>
  );
}

export function CostArt() {
  return (
    <div className="w-full max-w-60">
      <div className="flex items-end justify-between"><span className="font-mono text-2xl font-semibold tracking-tight">$0.043</span><span className="text-xs text-muted">of $0.10</span></div>
      <div className="mt-3 flex h-10 items-end gap-1">
        {[30, 45, 25, 60, 40, 72, 43].map((height, index) => (
          <span key={index} className={`flex-1 rounded-sm ${index === 6 ? 'bg-gold' : 'bg-primary/35'}`} style={{ height: `${height}%` }} />
        ))}
      </div>
      <div className="mt-2 text-[0.7rem] text-muted">cost per run, capped</div>
    </div>
  );
}

export function StreamingArt() {
  return (
    <div className="w-full max-w-60 rounded-xl border border-line bg-code p-3 text-[0.8rem] leading-6">
      <span className="text-muted">Clear skies over Paris today, around 21°C, so you can leave the umbrella</span>
      <span className="caret ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 bg-primary" />
    </div>
  );
}

export function VisionArt() {
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-24 w-32 overflow-hidden rounded-lg border border-line bg-code">
        <svg viewBox="0 0 128 96" className="h-full w-full" aria-hidden="true">
          <circle cx="94" cy="26" r="10" className="fill-gold/70" />
          <path d="M0 96 40 50l22 24 18-16 48 38Z" className="fill-primary/40" />
        </svg>
      </div>
      <div className="space-y-1.5 font-mono text-[0.7rem]">
        <div className="rounded border border-line px-2 py-1">image/png · 184 KB</div>
        <div className="rounded border border-line px-2 py-1">application/pdf</div>
        <div className="flex items-center gap-1.5 text-primary"><Icon name="check" className="size-3" /> type read from bytes</div>
      </div>
    </div>
  );
}

export function MemoryArt() {
  const hits = [['refund policy: 30 days', '0.92'], ['order o-1001 shipped', '0.81'], ['prefers email replies', '0.74']];
  return (
    <div className="w-full max-w-60 space-y-2">
      <div className="flex items-center gap-2 rounded-lg border border-line bg-code px-3 py-2 text-xs text-muted">
        <Icon name="sparkle" className="size-3.5" /> refunds for this customer
      </div>
      {hits.map(([text, score]) => (
        <div key={text} className="flex items-center justify-between rounded-lg border border-line px-3 py-1.5 text-xs">
          <span className="truncate">{text}</span><span className="ml-2 font-mono text-primary">{score}</span>
        </div>
      ))}
    </div>
  );
}

export function TraceArt() {
  const spans = [['run', 0, 100, 'bg-fg/25'], ['model', 4, 30, 'bg-primary/60'], ['weather.get', 36, 22, 'bg-gold/70'], ['model', 60, 34, 'bg-primary/60']] as const;
  return (
    <div className="w-full max-w-60 space-y-2">
      {spans.map(([label, left, width, tone], index) => (
        <div key={index} className="flex items-center gap-2">
          <span className="w-[4.6rem] shrink-0 font-mono text-[0.68rem] text-muted">{label}</span>
          <div className="relative h-3 flex-1"><span className={`absolute inset-y-0 rounded-sm ${tone}`} style={{ left: `${left}%`, width: `${width}%` }} /></div>
        </div>
      ))}
      <div className="pt-1 text-right text-[0.68rem] text-muted">OpenTelemetry · OTLP</div>
    </div>
  );
}
