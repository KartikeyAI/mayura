---
title: "Choose a starter"
description: "Choose among 11 runnable Mayura applications, six framework notebooks and focused templates, then follow the right setup path."
---

Start with the application shape you need. A **starter** includes an application, tests and configuration;
a **template** demonstrates one capability in a smaller project. Both can begin with offline model fixtures.
You do not need a model API key to learn the approval and persistence flow.

## Pick an application

| Your goal | Starter | What you start with |
| --- | --- | --- |
| Chat inside Next.js | `nextjs` | App Router, React notebook, exact note approvals and indexing worker |
| Fetch routing with a separate frontend | `hono` | Hono, Vite React and additional runtime source |
| Chat in React Router | `react-router` | Resource routes and React notebook controls |
| Chat in TanStack Start | `tanstack-start` | Server routes and React notebook controls |
| Native Svelte chat | `sveltekit` | Svelte controls over the headless conversation stores |
| Native Vue chat | `nuxt` | Nitro routing and Vue conversation controls |
| A customer support service | `support-agent` | Scoped support chat and server deployment source |
| A durable review process | `approval-workflow` | A refund workflow that waits for human approval |
| Parallel research | `research-team` | Planner, researchers and writer with bounded shared spending |
| Webhook-driven work | `event-automation` | Signed webhook admission and durable MCP tool work |
| Interactive terminal use | `cli-agent` | Terminal conversation with confirmation for writes |

The six framework notebooks share one portable server application and the same scope, approval and recovery
contract. Choose the framework your team already operates; choosing a framework does not change an agent's authority.
Use [Next.js](nextjs.md), [Hono](hono.md), [React Router](react-router.md), [TanStack Start](tanstack-start.md),
[SvelteKit](sveltekit.md) or [Nuxt](nuxt.md) for exact setup and generated file locations.

## Generate a reviewed directory

```sh
npx mayura@1.2.0 init --starter nextjs --directory ./my-notebook --apply
```

Replace `nextjs` with the selected starter ID. The [initializer](../cli/init.md) supports a plan before writing and
refuses unapproved replacement of existing files. Run from a directory you own; use the generated README for that
starter's install, build and environment commands.

For a framework notebook:

```sh
cd my-notebook
npm install
npm run setup
npm run dev
```

Use Node 24.14.1 or a later supported 24.x release; the Nuxt toolchain requires 24.15.0 or later.
Read the local token from ignored `.data/login-token`, enter it in the notebook and start `npm run worker` in another
terminal. Setup never prints that credential and does not overwrite existing credentials. Other starter families
have their own setup instructions; do not assume the notebook login flow applies to a CLI or support service.

## What to verify first

Send a note, inspect the proposed input, approve once and inspect its recorded outcome. Reject another proposal
and confirm that it did not write. Let the separate worker process indexing, then reload and reconnect to inspect
the saved thread. If submission is uncertain, retain its original input and key for explicit recovery.

The notebook is a local, single-user identity demonstration. Before exposing it to customers, replace its
authenticator with verified per-tenant identity. The host owns scope, route capabilities, tools and budgets;
browser data never grants authority. Keep secrets on the server and configure the exact public origin.

## Choose a template for one concept

Use the interactive initializer to see the current template catalog when you want a small example rather than a
complete service. Templates suit learning a tool schema, a model call or a workflow primitive. When adapting one
for customers, supply your own identity, persistence, server lifecycle, deployment and operational recovery.

## Before adding paid work

Select a [model provider](model-providers.md) or [AI gateway](ai-gateways.md), declare prices and a finite model-call
cap, and grant only the model/tools needed for the application. Preserve separate worker permissions and
[authorization](authorization.md). A UI approval does not authorize an unrelated workflow tool.

The V1.2 package release and cross-platform checks passed. Rendered browser, external provider and live deployment
qualification remain separate from offline fixture checks. Follow [framework architecture](framework-starters.md),
[deployment](deployment.md) and [release evidence](release-readiness.md) before production rollout.
