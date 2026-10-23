---
title: "Build a Mayura app with React Router"
description: "A React Router notebook with persistent chat, exact approvals and a durable worker: generate it, understand the boundary and prepare it for deployment."
date: 2026-10-23
tags: React Router, framework, starters, approvals
---

Start with the React Router notebook when you want a working scoped conversation flow inside your own framework.
Mayura 1.2 ships the interface, server bridge, offline note agent, persistence, tests and separate indexing worker.
You can inspect and approve a proposed write before introducing paid inference.

## Start locally

```sh
npx mayura@1.2.0 init --starter react-router --directory ./my-notebook --apply
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

## How React Router fits

The resource route forwards loader requests and action requests to the same native handler. The home route hosts the React notebook. Keep the resource route separate from page data loaders so authenticated run responses and event streams are not transformed into page data.

The bridge lives at `app/routes/api.ts`; the view starts at `app/routes/home.tsx`. Use React Router for navigation and Mayura stores for thread/run observation. Unmounting a route disposes its observers; it must not automatically resubmit the previous message or approve the captured call. Preserve the exact submission key when explicitly recovering a lost response.

## Before a deployment

Build and serve the generated React Router Node application with its separate worker. A persistent single-host deployment can share the SQLite volume; replicas need shared PostgreSQL. Route actions do not replace the background worker or guarantee that a remote write was cancelled when navigation stops.

Replace the demonstration identity with verified tenant sessions, supply secrets only on the server and keep model
and worker permissions separate. The six framework starters passed workspace build and mounted HTTP flow checks;
rendered browser and live deployment qualification remains a distinct responsibility.

## Read the complete guide

- [React Router setup and customization](../../../docs/guides/react-router.md): generated files, approval flow, storage and checks.
- [Framework architecture](../../../docs/guides/framework-starters.md): sessions, shared storage and durable recovery.
- [Choose a starter](../guides/choose-a-starter.md): all 11 starting points.
- [Release evidence and limitations](../../../docs/guides/release-readiness.md).
