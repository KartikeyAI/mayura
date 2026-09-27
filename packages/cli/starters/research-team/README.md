# Research team on Mayura

A complete, production-shaped starter for multi-agent research: a **planner** splits a question into sub-questions,
**researchers** answer them in parallel from a **source library**, and a **writer** produces a cited report. The whole
thing is one **durable workflow** run by a **worker**, under **one shared cost budget**, and the report is stored as a
**content-addressed artifact**. Optional **OpenTelemetry** traces carry timing metadata only, never content.

It runs offline out of the box: rule-based stand-in models, SQLite, a bundled six-document library and local artifact
files. One environment switch uses OpenAI, Anthropic or an OpenAI-compatible provider, another uses PostgreSQL, a third turns on tracing.

```
your app ──desk token──▶ server ──▶ research.desk ──▶ research.start ──▶ durable run (research.run v1)
                            │                                               │
                            │                         worker: plan ─▶ research.1 ┐
operator ──token──▶ console / operator API:                                ─▶ research.2 ├─▶ research ─▶ write ─▶ store
                     watch, pause, cancel,                                 ─▶ research.3 │  (join)          (artifact)
                     hold the fleet                                        ─▶ research.4 ┘
            research.desk ──▶ research.report ──▶ run status, or the report read back from the artifact store
```

## Quick start

```bash
npm install
npm run dev
```

`npm run dev` builds, starts the server and a worker in one process on `.data/research-team.sqlite`, asks the desk
one demo question, waits for the report and prints the console URL, two tokens and the finished run. Open the
console, paste the **operator** token and open **Workflows**: the run shows `plan`, the four research slots (three
used; the fourth skipped because the plan did not need it), the `research` join, `write` and `store`.

`npm run dev` runs `mayura dev`: it loads `.env` if you have one, and rebuilds and restarts when you save a file. The tokens it prints are kept in `.data/dev-secrets.json`, so they stay the same across restarts.

Ask your own question as your application:

```ts
import { createClient } from '@mayura/client';
import { deskOutput } from './src/desk.js'; // or your own copy of the output schema
const desk = createClient({ baseUrl: 'http://127.0.0.1:8080', token: () => process.env.DESK_TOKEN! });
async function ask(input: object, idempotencyKey: string) {
  const run = await desk.submit('research.desk', input, { idempotencyKey });
  for await (const _event of run.events()) { /* ends when the desk run settles */ }
  const outcome = await run.result(deskOutput);
  if (outcome?.status !== 'succeeded') throw new Error('The desk did not answer.');
  return outcome.output;
}

// Start: idempotent on your request id. Retrying the same request id returns the same run.
const { runId } = await ask({ requestId: 'q-42', question: 'What did the co-operative learn after two years, and what are its open risks?' }, 'start-q-42');
// Later: the report (Markdown with citations), or the run's status while it is unfinished.
const { status, report, citations } = await ask({ runId }, `report-q-42-${Date.now()}`);
```

`npm test` runs everything offline over real HTTP: a research run end to end with the researchers provably in
parallel, citations checked against the library, idempotent starts, a run stopped by its budget, token scopes,
metadata-only trace export to a local collector, and configuration checks.

## What is where

| File | Purpose |
|---|---|
| `src/workflow.ts` | The research workflow: its steps, the shared budget, citation checks, report rendering and artifact storage |
| `src/team.ts` | The planner, researcher and writer agents and their offline stand-in models |
| `src/desk.ts` | The research desk agent, its `research.start` and `research.report` tools, and its offline stand-in |
| `src/library/` | The `SourceLibrary` interface, a local keyword index, the `library.search`/`library.read` tools and the bundled corpus |
| `src/telemetry.ts` | Optional metadata-only OpenTelemetry traces |
| `src/server.ts` | HTTP: the desk, the operator console at `/inspector` and the operator API |
| `src/worker.ts` | Advances research runs, with leadership so replicas never double-drive the fleet |
| `src/auth.ts` | Bearer tokens (digests in config) and caller scopes |
| `src/config.ts` | Every setting, from the environment, validated at startup |
| `src/model.ts` | Offline, OpenAI, Anthropic or OpenAI-compatible, chosen by `MAYURA_MODEL_PROVIDER` |
| `src/app.ts` | The entry point for `mayura serve`, `mayura worker` and `mayura migrate` |
| `src/dev.ts` | The one-process local run with a demo question |

## How it works

**Why a lifecycle workflow.** Mayura has several durable formats. This starter uses the lifecycle format
(`@mayura/workflows/lifecycle`, format 5) because it covers what the team needs with the least machinery: tool steps
whose dependencies are met run **in parallel** in the same wave; every step is journaled before it runs and **never
replayed** after a crash; the run record carries **one cost budget** that every step draws on, checked before each
step starts; `createWorkflowLifecycleHost` is a ready-made worker unit (with leadership, the fleet hold and backoff);
and the operator console and API work as in the approval-workflow starter, where reviewed migrations are added the
same way.
It also has human and timer nodes, should you want an editor's approval before a report is published.
The alternatives were weighed: *workflow trees* (required child workflows with per-child cost ceilings under one root
account) are the closest conceptual fit, but the guide describes them as a preview limited to one level of tool/join
children, they need a coordinator wrapped as a worker unit, and each child would still be a static node, so they add
machinery without solving variable fan-out. *Graphs* add waits on other runs, which research does not need.
`agentAsDurableWorkflow` wraps one agent as one workflow, not a team. The store's `durableBudgets` ledger is a
lower-level primitive whose guide warns that calling it separately from the workflow is not a restart-safe
integration; the lifecycle budget is written in the same record update that claims each step.

**One shared budget.** `RESEARCH_BUDGET_MICROS` is the budget of a whole research run. Every agent step declares a
ceiling (`MAYURA_MAX_RUN_COST_MICROS`, which is also the agent's own `maxCostMicros`). Before a step runs, the runtime
reserves its ceiling from what the run has left, in the same storage write that claims the step; when the step
completes, the run is charged what it reported spending and the rest of the reservation is released. When the rest of the
budget cannot cover a step, that step is `blocked` with code `BUDGET_EXCEEDED`, every later step is skipped, and the
run ends `blocked`: no model is called and no report is written. The desk reports it as
`{ status: 'blocked', stopReason: 'budget_exhausted' }`. By default the budget is six step ceilings: plan, four
research slots and write (storing costs nothing), enough for the largest plan.

**Parallel research.** `fanOut` from `@mayura/workflows/lifecycle` gives the graph one slot per possible researcher
(four). The planner returns as many assignments as it needs (two to four); slot n runs the researcher on assignment n,
and a slot without an assignment is bypassed: it never starts and reserves nothing from the budget. The `research`
join lists every slot's output in order, `null` for a bypassed slot, and the writer reads that list.

**Citations you can trust.** A researcher's tools are created per step and record which documents it read; a finding
that cites anything else fails the step. The writer may cite only sources the researchers reported, and every cited id
must resolve in the library, whose titles (not the model's) fill the reference list.

**Content-addressed reports.** The `store` step writes the Markdown report to `@mayura/artifacts`; its reference
(`sha256:` digest of the exact bytes) is the run's result. `research.report` reads the bytes back through the store,
which re-verifies the digest.

**Traces.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` (the collector's base URL; traces go to `/v1/traces`) and each research
run becomes one trace rooted at the run (`workflow:research.run`), with a span per step (`tool:plan`,
`tool:research.1`..`4`, `join:research`, `tool:write`, `tool:store`). Each agent a step runs is nested under that step
(`agent:research.planner`, ...), with its model calls (`model.call`) and tool calls (`tool:library.search`,
`tool:library.read`) under it. The run and step spans are built from the run's durable event log once it settles, so
a worker that restarts exports them later, and exporting twice sends the same span ids. Spans carry names, times,
ok/error, run and node ids, step statuses, definition id/version and budget figures. Questions, prompts, sources,
findings and reports are never exported: span attributes come from a fixed catalog of identifiers and integers, and
the observer admits only allow-listed metadata. Unset, nothing is collected or sent.

## Make it yours

1. **Sources.** Implement `SourceLibrary` (`search` and `read`) in `src/library/index.ts` and pass it to
   `openServices` (or replace `localLibrary(harlowCreekCorpus)` in `src/services.ts`). For **web search**, `search`
   calls your search API and returns URL-derived ids with snippets; `read` fetches and extracts the page, and must
   return only what it fetched (keep ids short and stable: they are what reports cite). For a **vector store**,
   `search` embeds the query and returns the nearest chunks' document ids; `read` returns the stored document. Keep
   both read-only and bounded, and treat fetched text as untrusted input to the model.
2. **Model.** Set `MAYURA_MODEL_PROVIDER=openai` (or `anthropic`) with the key, model name, prices and cost limits in
   `.env.example`. The same agents, tools and output schemas are used; the offline stand-ins are not.
3. **Budget.** Set `MAYURA_MAX_RUN_COST_MICROS` (one agent step) and `RESEARCH_BUDGET_MICROS` (one research run).
4. **Team.** Edit the instructions in `src/team.ts`, or change `MAX_RESEARCHERS` in `src/config.ts` (a new workflow
   definition; see below).

### Changing the workflow

The run budget, every step's ceiling and capabilities, and the graph are pinned into each run. Never change them
under runs in flight: let runs finish (or cancel them from the console) first, or add a new version in
`src/workflow.ts`, keep the old one in `definitions`, declare a reviewed migration with `defineWorkflowMigration` and
pass it to `createWorkflowOperatorTransports({ migrations })` in `src/server.ts`, as the approval-workflow starter does
(see the Mayura guide *Migrating in-flight workflow runs*). Switching the model provider alone changes nothing pinned;
changing `MAYURA_MAX_RUN_COST_MICROS` or `RESEARCH_BUDGET_MICROS` does.

## Production

1. Create tokens with `npm run token`, once per caller. Give each token to its caller's secret store and put only the
   digest in `MAYURA_OPERATOR_TOKEN_SHA256` or `MAYURA_DESK_TOKEN_SHA256`. Several comma-separated digests rotate
   without downtime.
2. Use PostgreSQL (`DATABASE_URL`). SQLite is for a single node.
3. Give the server and every worker the **same** artifact directory (`RESEARCH_ARTIFACTS_DIR`): workers write
   reports, the server reads them for `research.report`.
4. Run `npm run migrate` before new code serves traffic, then `npm run serve` and `npm run worker` as separate
   processes. One worker leads at a time.
5. Terminate TLS in front of the server and set `MAYURA_PUBLIC_ORIGIN` to the exact `https://` origin. `/healthz` and
   `/readyz` are unauthenticated and content-free; the worker serves its own on port 9090.

`docker compose up --build` runs this shape locally (PostgreSQL, migrate, server, worker, a shared artifact volume)
from `.env`. The image builds from the npm registry, so it needs published Mayura packages.

## Know the limits

- **Steps are admitted by ceiling, charged by use.** Before a step starts, its full ceiling must fit in what the run
  has left; once it completes, the run is charged what the step reported spending and the rest is released. So a run
  that is almost out of budget can stop at a step it could have afforded in practice; size `RESEARCH_BUDGET_MICROS`
  with that headroom. Research slots the plan does not use are bypassed and reserve nothing. Offline, the ceilings
  default to zero and the budget never binds.
- **Artifacts are local files.** `@mayura/artifacts` is a same-host store. With several machines, mount shared storage
  at `RESEARCH_ARTIFACTS_DIR` for the server and every worker, or replace the store with object storage. Artifact
  files are not deleted when runs are; plan retention yourself.
- **A failed step fails the run.** Nothing is retried automatically (a model call costs money); submit again with a
  new request id. A step cut off by a crash waits for operator reconciliation.
- **The desk relays the report through its model.** With a real provider, the desk's answer repeats the report, which
  costs output tokens; reports are capped at 24,000 characters. For large reports, serve the artifact from your own
  route with `artifacts.disclose` after checking the caller may read that run.
- **Any desk caller can read any run** whose id it has; run ids are unguessable digests, not access control. Add an
  owner check in `research.report` if callers must not see each other's research.
- **The offline models are not research.** They split on punctuation, quote the sentence the keyword search matched
  and assemble a report from those quotes. They show the protocol a real model follows.
- **The corpus is fictional.** Harlow Creek, its co-operative and every figure are invented for this starter.
- **Run traces arrive when the run settles.** The worker exports a run's workflow spans after it succeeds, fails, is
  blocked or is cancelled (every 2 s while it leads); a run still waiting has only its agent spans so far. Agent spans
  are best effort: a worker that dies mid-step loses that agent's spans, never the run's.
- Operator commands are attributed to the service principal. For per-person attribution, put your identity provider
  in front of the API.
