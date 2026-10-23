---
title: "Build a Mayura app with Nuxt"
description: "A Nuxt notebook with persistent chat, exact approvals and a durable worker: generate it, understand the boundary and prepare it for deployment."
date: 2026-10-23
tags: Nuxt, framework, starters, approvals
---

Start with the Nuxt notebook when you want a working scoped conversation flow inside your own framework.
Mayura 1.2 ships the interface, server bridge, offline note agent, persistence, tests and separate indexing worker.
You can inspect and approve a proposed write before introducing paid inference.

## Start locally

```sh
npx mayura@1.2.0 init --starter nuxt --directory ./my-notebook --apply
cd my-notebook
npm install
npm run setup
npm run dev
```

Use Node 24.15.0 or a later supported 24.x version. Open the local notebook at port 3000 and enter
the token from the ignored `.data/login-token` file. Setup never prints it. Start `npm run worker` in a second
terminal to process the indexing workflow and bounded recovery work.

Send one note, review the proposed call, approve or reject it, and inspect the saved history after reconnecting.
An uncertain response calls for inspection with the original submission key, not another note write.

## How Nuxt fits

The Nitro route converts the H3 event to a Web Request and returns the native Web Response through the H3 bridge. The Vue page uses headless stores and explicit controls. Keep credentials and the application host in private server configuration, outside public runtime config.

The bridge lives at `server/routes/api/mayura/[...path].ts`; the view starts at `app/app.vue`. Retain the native Request/Response bridge when customizing Nitro middleware. Avoid reading and rebuilding approval payloads or buffering event streams in a page API wrapper. The React copy-in registry does not generate Vue components in 1.2; customize the supplied native Vue controls.

## Before a deployment

Use Node 24.15.0 or a later supported 24.x version for the generated Nuxt toolchain. Build the Nitro application and run the separate worker against the same store. Select a deployment preset deliberately; the Node/SQLite application is not automatically portable to edge presets.

Replace the demonstration identity with verified tenant sessions, supply secrets only on the server and keep model
and worker permissions separate. The six framework starters passed workspace build and mounted HTTP flow checks;
rendered browser and live deployment qualification remains a distinct responsibility.

## Read the complete guide

- [Nuxt setup and customization](../../../docs/guides/nuxt.md): generated files, approval flow, storage and checks.
- [Framework architecture](../../../docs/guides/framework-starters.md): sessions, shared storage and durable recovery.
- [Choose a starter](../guides/choose-a-starter.md): all 11 starting points.
- [Release evidence and limitations](../../../docs/guides/release-readiness.md).
