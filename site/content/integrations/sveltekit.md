---
title: "Build a Mayura app with SvelteKit"
description: "A SvelteKit notebook with persistent chat, exact approvals and a durable worker: generate it, understand the boundary and prepare it for deployment."
date: 2026-10-23
tags: SvelteKit, framework, starters, approvals
---

Start with the SvelteKit notebook when you want a working scoped conversation flow inside your own framework.
Mayura 1.2 ships the interface, server bridge, offline note agent, persistence, tests and separate indexing worker.
You can inspect and approve a proposed write before introducing paid inference.

## Start locally

```sh
npx mayura@1.2.0 init --starter sveltekit --directory ./my-notebook --apply
cd my-notebook
npm install
npm run setup
npm run dev
```

Use Node 24.14.1 or a later supported 24.x version. Open the local notebook at port 3000 and enter
the token from the ignored `.data/login-token` file. Setup never prints it. Start `npm run worker` in a second
terminal to process the indexing workflow and bounded recovery work.

Send one note, review the proposed call, approve or reject it, and inspect the saved history after reconnecting.
An uncertain response calls for inspection with the original submission key, not another note write.

## How SvelteKit fits

The catch-all +server.ts forwards the native HTTP methods to the application handler. The page uses native Svelte controls and headless stores, not React components. Keep connection setup and subscriptions in the browser lifecycle, with disposal when the page disconnects.

The bridge lives at `src/routes/api/mayura/[...path]/+server.ts`; the view starts at `src/routes/+page.svelte`. Subscribe to the headless thread, run and approval snapshots from the Svelte view. Keep approve/reject behind explicit controls bound to the displayed call. The React copy-in registry does not generate Svelte source in 1.2; the included Svelte interface is the supported starting point.

## Before a deployment

Use the generated Node host and a separate Node worker. Review the SvelteKit adapter before switching deployment platforms. PostgreSQL supports multiple hosts; SQLite needs a persistent volume shared with the worker. Serverless hosting still needs a trusted path to advance bounded background work.

Replace the demonstration identity with verified tenant sessions, supply secrets only on the server and keep model
and worker permissions separate. The six framework starters passed workspace build and mounted HTTP flow checks;
rendered browser and live deployment qualification remains a distinct responsibility.

## Read the complete guide

- [SvelteKit setup and customization](../../../docs/guides/sveltekit.md): generated files, approval flow, storage and checks.
- [Framework architecture](../../../docs/guides/framework-starters.md): sessions, shared storage and durable recovery.
- [Choose a starter](../guides/choose-a-starter.md): all 11 starting points.
- [Release evidence and limitations](../../../docs/guides/release-readiness.md).
