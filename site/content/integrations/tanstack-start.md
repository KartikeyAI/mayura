---
title: "Build a Mayura app with TanStack Start"
description: "A TanStack Start notebook with persistent chat, exact approvals and a durable worker: generate it, understand the boundary and prepare it for deployment."
date: 2026-10-23
tags: TanStack Start, framework, starters, approvals
---

Start with the TanStack Start notebook when you want a working scoped conversation flow inside your own framework.
Mayura 1.2 ships the interface, server bridge, offline note agent, persistence, tests and separate indexing worker.
You can inspect and approve a proposed write before introducing paid inference.

## Start locally

```sh
npx mayura@1.2.0 init --starter tanstack-start --directory ./my-notebook --apply
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

## How TanStack Start fits

The file route registers native GET, POST, DELETE, OPTIONS and HEAD handlers. Each forwards the Request to the portable server module. The index route renders the notebook. Keep this server route boundary instead of serializing approval commands through a server function.

The bridge lives at `src/routes/api.mayura.$.ts`; the view starts at `src/routes/index.tsx`. Keep server-only imports out of the React page bundle. Update the route prefix and browser transport together if the application moves under another mount. Native stream responses should pass through unchanged so run events and approval pauses remain observable.

## Before a deployment

The generated Node adapter uses a pinned Nitro beta. Retain the starter toolchain and verify the build on the actual deployment before changing adapter versions. The worker is a separate Node process; a server route alone does not advance the durable indexing workflow.

Replace the demonstration identity with verified tenant sessions, supply secrets only on the server and keep model
and worker permissions separate. The six framework starters passed workspace build and mounted HTTP flow checks;
rendered browser and live deployment qualification remains a distinct responsibility.

## Read the complete guide

- [TanStack Start setup and customization](../../../docs/guides/tanstack-start.md): generated files, approval flow, storage and checks.
- [Framework architecture](../../../docs/guides/framework-starters.md): sessions, shared storage and durable recovery.
- [Choose a starter](../guides/choose-a-starter.md): all 11 starting points.
- [Release evidence and limitations](../../../docs/guides/release-readiness.md).
