---
title: "Build a Mayura app with Hono"
description: "A Hono notebook with persistent chat, exact approvals and a durable worker: generate it, understand the boundary and prepare it for deployment."
date: 2026-10-23
tags: Hono, framework, starters, approvals
---

Start with the Hono notebook when you want a working scoped conversation flow inside your own framework.
Mayura 1.2 ships the interface, server bridge, offline note agent, persistence, tests and separate indexing worker.
You can inspect and approve a proposed write before introducing paid inference.

## Start locally

```sh
npx mayura@1.2.0 init --starter hono --directory ./my-notebook --apply
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

## How Hono fits

Hono mounts the native Fetch handler while Vite builds the React notebook. The Node entry point and the separate worker share the application configuration. Keep the API prefix and the origin-pinned browser transport in agreement when mounting behind another router.

The bridge lives at `server/hono-node.mjs`; the view starts at `src/`. Start with the Node path before selecting another runtime. Review the generated start:bun, start:deno, dev:workers and deploy:workers scripts rather than reusing Node SQLite imports at the edge. Workers needs a configured D1 binding and secret identity directory; serve only built frontend assets.

## Before a deployment

The starter also ships Bun and Deno entry points using PostgreSQL, and Workers source with a D1 binding, assets and a scheduled handler. Those application-specific profiles still need qualification on the target host; shared runtime CI is not a live Workers deployment check.

Replace the demonstration identity with verified tenant sessions, supply secrets only on the server and keep model
and worker permissions separate. The six framework starters passed workspace build and mounted HTTP flow checks;
rendered browser and live deployment qualification remains a distinct responsibility.

## Read the complete guide

- [Hono setup and customization](../../../docs/guides/hono.md): generated files, approval flow, storage and checks.
- [Framework architecture](../../../docs/guides/framework-starters.md): sessions, shared storage and durable recovery.
- [Choose a starter](../guides/choose-a-starter.md): all 11 starting points.
- [Release evidence and limitations](../../../docs/guides/release-readiness.md).
