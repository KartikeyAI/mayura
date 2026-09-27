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

## What every starter has

- **Runs offline first.** Each agent has a small rule-based stand-in model, clearly labelled, so `npm run dev` and
  `npm test` need no key and no network. `MAYURA_MODEL_PROVIDER=openai` or `anthropic` switches the same agents to a real
  model, with explicit prices and cost limits.
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
