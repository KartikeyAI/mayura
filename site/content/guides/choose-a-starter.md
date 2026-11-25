---
title: "Choose your Mayura starter"
description: "Choose from twelve starter applications, including framework notebooks, standalone services and a cited retrieval agent."
date: 2026-10-23
updated: 2026-11-25
tags: starters, frameworks, Next.js, Hono, SvelteKit, Nuxt
---

The Mayura CLI includes twelve runnable applications. Choose a chat notebook, a standalone service, a retrieval
agent, an event-driven workflow or a terminal assistant. The six notebook starters let
you try persistent threads and exact tool approvals without a provider credential or a model bill.

## Use your team's framework

| Framework | Server boundary | Interface | Setup guide |
| --- | --- | --- | --- |
| Next.js | App Router on Node | React source | [Next.js](../../../docs/guides/nextjs.md) |
| Hono | Fetch routing | Vite React | [Hono](../../../docs/guides/hono.md) |
| React Router | Resource loader/action | React source | [React Router](../../../docs/guides/react-router.md) |
| TanStack Start | File-based server handlers | React source | [TanStack Start](../../../docs/guides/tanstack-start.md) |
| SvelteKit | Catch-all server route | Native Svelte | [SvelteKit](../../../docs/guides/sveltekit.md) |
| Nuxt | Nitro Request/Response bridge | Native Vue | [Nuxt](../../../docs/guides/nuxt.md) |

Every notebook has the same core flow: connect with a scoped local session, send a note, inspect the proposed write,
approve or reject it, and let a separate worker index approved notes. The database keeps the thread and run record.
Your framework controls the application shell; the Mayura host controls identity, capabilities and budgets.

## Try Agent Workspace in Next.js

For the v1.4 React workspace with editable Tailwind, read-only AG-UI reconnection and structured reply cards,
run the [Agent Workspace example](agent-workspace.md). The `nextjs` CLI starter below generates the persistent
notebook with an indexing worker.

## Generate the notebook

```sh
npx mayura@1.4.0 init --starter nextjs --directory ./my-notebook --apply
cd my-notebook
npm install
npm run setup
npm run dev
```

Use the starter ID from the setup guide for another framework. The notebook runs at `http://localhost:3000`.
Read `.data/login-token` locally and enter it in the password field; never paste it into an issue or commit it.
Run `npm run worker` in another terminal. Use the Node version required by the generated README.

## Prefer a standalone application?

| Starter | Start here when |
| --- | --- |
| `support-agent` | You need a scoped support service with a chat interface |
| `approval-workflow` | The product is a durable approval process, such as a reviewed refund |
| `research-team` | You want planner/researcher/writer coordination with bounded shared spending |
| `event-automation` | Signed webhooks should start durable work through MCP tools |
| `cli-agent` | The interface belongs in a terminal, with confirmation for writes |
| [`rag-modal-pinecone`](../../../docs/guides/rag-modal-pinecone-starter.md) | You need durable Markdown ingestion and cited answers |

Follow each generated README: these applications do not all use the notebook's setup command or session token.
For a small example of a single capability, choose a template in the initializer instead.

## Move from fixture to product

Keep the working offline flow as your regression case. Replace the local demonstration identity with verified
tenant sessions, choose persistent storage suitable for your deployment, and add explicit provider prices and
spending caps before paid calls. Do not recover a lost response by automatically repeating a write.

The release's offline and mounted HTTP checks do not establish browser accessibility or a live production deployment.
Use the [complete starter guide](../../../docs/guides/choosing-a-starter.md),
[shared framework architecture](../../../docs/guides/framework-starters.md) and
[release qualifications](../../../docs/guides/release-readiness.md) to plan that transition.
