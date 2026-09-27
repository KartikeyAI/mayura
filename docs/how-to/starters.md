# Start from a complete project

Templates show one feature in one file. **Starters** are complete projects you can run, test and ship: a server and a
worker, validated configuration, tests, a Dockerfile, a compose stack and CI. `@mayura/cli` ships them.

```text
mayura starters
mayura init --starter approval-workflow --directory ./refunds
mayura init --starter approval-workflow --directory ./refunds --apply
```

`init --starter` uses the same plan-first flow as templates: without `--apply` it writes nothing and lists every file with
its digest, and replacing an existing file needs `--apply --confirm <plan digest>`. The generated `package.json` pins
every Mayura package to the CLI's exact release.

## Try a starter from this repository

Before Mayura is published to npm, `npm install` in a generated project cannot find the `@mayura/*` packages. From a
clone of this repository, create the project with `pnpm local:init` instead:

```text
pnpm install
pnpm local:init                                                   # choose interactively
pnpm local:init --starter research-team --directory ../research-app
pnpm local:init --template basic-agent --directory ../my-agent
```

It builds the workspace, creates the project exactly as `mayura init` does, packs this workspace's Mayura packages and
the third-party packages they use (taken from the local installation, including this machine's native binaries such
as SQLite's), and installs them offline into the project. Nothing is downloaded. Then `cd` into the project and run
`npm run dev` (for a template, `npm run build` and `npm start`). The packed packages stay in the project's
`.mayura-local/` folder (ignored by git), so `npm install` keeps working there offline. To pick up later changes to the
workspace, create a new project. A relative `--directory` is resolved from where you run the command.

## What every starter has

- **Runs offline first.** Each agent has a small rule-based stand-in model, clearly labelled, so `npm run dev` and
  `npm test` need no key and no network. `MAYURA_MODEL_PROVIDER=openai`, `anthropic` or `compatible` switches the same
  agents to a real model, with explicit prices and cost limits. `compatible` takes any OpenAI-compatible chat-completions
  endpoint (`MAYURA_MODEL_ENDPOINT`, a short `MAYURA_MODEL_PROVIDER_ID` such as `groq`, `MAYURA_MODEL_AUTH` and
  `MAYURA_MODEL_API_KEY`); see [Model providers](model-providers.md). `mayura init` asks for all of this and writes `.env`.
- **SQLite locally, PostgreSQL in production**, chosen by `DATABASE_URL`.
- **The production shape.** `src/app.ts` is the entry point for `mayura migrate`, `mayura serve` and `mayura worker`. Run
  the server and workers as separate processes; workers use leadership, so replicas never double-drive the fleet.
- **Configuration only from the environment**, validated at startup, with the production requirements enforced
  (public HTTPS origin, token digests). Tokens are configured as SHA-256 digests; `npm run token` makes one.
- **Tests that exercise the real thing**: a loopback server, the HTTP client, durable storage and the worker.
- **Honest limits.** Each README ends with what the starter does not do.

## The starters

| Starter | What it shows |
|---|---|
| `approval-workflow` | Refund approvals: an intake agent opens a durable workflow that checks policy, waits for an operator to approve the exact payment in the console, issues it and notifies the customer. Includes a reviewed in-place migration from workflow v1 to v2. |
| `support-agent` | Customer support chat with a React + shadcn UI and streamed replies (each batch PII-checked before release): order tools that act only for the signed-in customer (HMAC-signed sessions your backend mints), per-customer native memory, PII redaction of inputs, outputs and tool results, and a durable return follow-up workflow. |
| `research-team` | Multi-agent research as one durable lifecycle workflow: a planner, up to four parallel researchers over a swappable source library, and a writer whose citations are checked in code; one run budget; the report stored as a content-addressed artifact; optional metadata-only OpenTelemetry traces. |
| `event-automation` | Signed ticket webhooks (HMAC, replay window, durable deduplication) start durable runs in which a triage agent acts on the tracker through MCP tools under explicit capability grants; assigning an urgent ticket waits for operator approval. Ships a minimal local MCP server. |

## How starters are qualified

`pnpm test:starters` runs in CI on Linux, macOS and Windows with Node 22 and 24. For each starter it:

1. builds it in the workspace, runs its own tests, and builds its web UI if it has one;
2. generates it with `init --starter` into a fresh directory, installs only its exact dependency closure from locally
   packed archives (no registry, no install scripts), builds it and runs its tests;
3. boots it as production does: `migrate`, then `serve` and `worker` as separate processes, and checks that the server
   lists exactly the agents the project declares and the worker reports ready.

A web UI's toolchain (Vite, Tailwind) is verified in step 1 only. The Dockerfiles install from the npm registry, so they
build once Mayura packages are published.
