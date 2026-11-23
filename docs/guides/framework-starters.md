---
title: "Framework starters"
description: "Generate Next.js, Hono, React Router, TanStack Start, SvelteKit or Nuxt notebooks with scoped threads and in-run approvals."
---

The six framework starters extend [mayura init](../cli/init.md) with a small persistent notebook application.
Each includes scoped server routes, a deterministic no-cost model fixture, threads, exact approval controls,
scripted offline tests, a separate workflow worker, deployment files and an environment example.

| Starter | Server route | Interface | Background processing |
| --- | --- | --- | --- |
| `nextjs` | App Router catch-all, Node runtime | React copy-in source | Node worker |
| `hono` | Hono Fetch routing | Vite React copy-in source | Node/Bun/Deno process or Workers Cron |
| `react-router` | Resource loader/action route | React copy-in source | Node worker |
| `tanstack-start` | Server-route handlers | React copy-in source | Node worker |
| `sveltekit` | Catch-all `+server.ts` | Native Svelte with headless stores | Node worker |
| `nuxt` | Nitro catch-all with a Web Request/Response bridge | Native Vue with headless stores | Node worker |

Follow the dedicated setup for [Next.js](nextjs.md), [Hono](hono.md), [React Router](react-router.md),
[TanStack Start](tanstack-start.md), [SvelteKit](sveltekit.md) or [Nuxt](nuxt.md).
For other application shapes, see [Choose a starter](choosing-a-starter.md).

## Generate and connect

```sh
mayura init --starter nextjs --directory /absolute/path/my-notebook --apply
```

In the generated project, install dependencies, run `npm run setup`, then `npm run dev`. The local setup writes
an eight-hour session to ignored owner-readable files and refuses to overwrite existing files. Open `.data/login-token`
locally and enter its value in the notebook at `http://localhost:3000`. No token is printed by setup or embedded in
the frontend. Start `npm run worker` in another terminal to process note indexing and bounded conversation recovery.
The generated README describes configuration and deployment for that framework.

The notebook asks to save one note for each submitted message. The runtime pauses for approval; the UI displays the
captured input before an explicit approve/reject command. A successful write queues a separate durable indexing
workflow. No model provider, network write or paid request is part of the fixture.

## Scope and ownership

The server owns the project, verified principal, route capabilities, agent permissions, model budgets and workflow
permissions. Browser input cannot choose an identity. The local token directory is a demonstration; production apps
must connect the server's authenticate callback to verified application identity and issue distinct tenant sessions.
Rotate credentials and restart the service when changing the host identity configuration.

`server/application.mjs` holds the portable Mayura setup. The framework mounts it under `/api/mayura/*`; the browser
client uses an origin-pinned Fetch adapter to preserve Mayura's root route contract while adding that prefix.
No framework action parses and reserializes run/approval payloads, so the native server owns validation and limits.
Native event responses are streamed through the framework bridge.

The interface keeps a session token in memory. Thread/run selection and an unconfirmed message/key may be retained
in this tab's session storage, under a credential digest. Re-entering the token after reload restores that selection.
Observers only read; decisions and submissions are explicit. Retry retains the same submission key and input.
Disconnect/unmount removes observers and credentials without pretending that a remote write was cancelled.
An ambiguous approval or tool outcome requires inspection and safe reconciliation; it is never a browser write retry.

React starters include owned source from the [copy-in registry](copy-in-ui.md) for thread history, approval controls
and the thread list. SvelteKit and Nuxt use [headless stores](react.md#other-frameworks) with native subscriptions and
controls. The copy-in registry is React-only in 1.2. All output is rendered as plain text; long approval previews
block approval rather than silently authorizing unseen input.

## Persistence and workers

Node defaults to SQLite on a persistent single-host volume. PostgreSQL through `DATABASE_URL` supports shared
replicas and serverless request hosts. Each chat invocation runs inside its request, with persisted run records
and checkpoints. Native model and tool budgets remain explicit; the fixture costs zero. Switching providers needs
reviewed host prices, permissions and finite call/run budgets.

The worker uses separate scoped workflow permissions and shared-store leadership, with bounded passes over configured
identities. Its recovery path advances checkpoint/recording work without replaying claimed writes or model calls.
A saved note and its workflow submission are two operations: if scheduling is unconfirmed after the note is written,
inspect the run and reconcile the job using the note id. Never repeat the note write to repair scheduling.

Deploy source includes a Docker image and Compose web/worker services sharing one database volume. Supply the exact
public origin and runtime credentials at deployment; local configuration and generated framework output are excluded
from starter packaging. Use shared PostgreSQL rather than unshared SQLite files for multiple hosts. Allow at least
30 seconds for the configured request/run bounds. A trusted scheduler may call the bounded application `runOnce`;
there is no public Cron route.

Hono additionally includes Bun and Deno entry points using PostgreSQL without native SQLite imports. Workers uses
the optional D1 extension, a Workers assets binding and a scheduled handler. Configure its D1 binding, public origin,
project and secret identity directory before use. Its frontend is built by Vite; serve only the built asset directory.

## Validation and remaining qualifications

The starter suite passed locally for all 11 starters, including all six frameworks. It builds and boots each framework in the workspace, exercises its mounted approval flow,
and generates, packs, installs and tests each server contract offline. Like the existing Vite starters, framework toolchains
are qualified in the workspace; generated packed installs qualify the Mayura server contract separately.
The shared runtime checks passed on Bun, Deno, workerd and Vercel Edge; they do not qualify the Hono-specific Bun/Deno entry points or a deployed Workers/D1 application. Those profiles and rendered browser interaction checks remain outstanding.

Tests, type checks, framework builds and mounted HTTP approval/worker flows passed locally on Windows using Node 24.15.0 for framework qualification. The final V1.2 main qualification passed all 39 jobs, including Linux/macOS/Windows Node 22/24 consumer lanes. This does not establish rendered browser or live deployment qualification. TanStack's Node adapter uses a pinned Nitro beta; framework compiler integrations use TypeScript 6 tooling. Keep the starter's declared Node version and repeat qualification on the target deployment. See [release validation status](release-readiness.md).

The Stagehand/OpenAI/Zod and Mistral/OpenTelemetry peer conflicts are resolved in the workspace lockfile. An exact
local pnpm metadata hook gives the legacy OpenAI 4 SDK its own supported Zod 3 dependency; Mayura, Stagehand and
its Ollama transport keep Zod 4. Root development dependencies provide Mistral's OpenTelemetry 2.9 peers. Strict
peer checks remain enabled. Frozen installation with lifecycle scripts disabled, local builds and offline package compatibility checks passed.
