---
title: "Upgrade to Mayura 1.2.2 and try the RAG starter"
description: "Update Mayura and your extensions together, verify your install, and generate a retrieval agent with exact citations."
date: 2026-11-24
tags: release, RAG, starters
---

Mayura **1.2.2** ships a Modal + Pinecone retrieval starter and patches Zod, Hono and the Hono Node adapter.
All 106 packages are published under `latest` through npm trusted publishing. See the [changelog](../../../docs/project/changelog.md)
for the release history.

## Upgrade your application

Install the new Mayura version from the application root. If the application uses optional `@mayurajs/*` packages,
update the ones in your manifest to the same version.

```bash
npm install --save-exact mayura@1.2.2
npm exec -- mayura --version
npm audit --omit=dev
```

The CLI should report `1.2.2`. Review the lockfile diff and run your application's tests before rollout. If your
service uses the Hono server, include the routes, middleware and streaming or WebSocket paths you depend on.
Mayura's [release qualification](../../../docs/guides/release-readiness.md#v122-publication) checked a database
upgrade from 1.2.1, registry provenance and a clean install.

## Generate a retrieval agent

Run the starter locally using its included Markdown fixture and offline model.

```bash
npx mayura@1.2.2 init --starter rag-modal-pinecone --directory ./mayura-rag-starter --apply
cd mayura-rag-starter
npm install
npm run dev
```

The demo prints a cited answer. Its citation binds the source, revision and exact offsets, so you can find the
supporting passage in `fixtures/on-call.md`. Use the [starter guide](../../../docs/guides/rag-modal-pinecone-starter.md)
for tests and hosted setup, or the [RAG quickstart](../../../docs/guides/rag-quickstart.md) for a small API example
that also verifies deletion.

The [production qualification](../../../docs/guides/rag-production.md) covers the registered Loki v28 profile.
Measure retrieval and answer grounding on your own corpus before deploying a different configuration.
