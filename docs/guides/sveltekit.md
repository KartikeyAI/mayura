---
title: "Mayura with SvelteKit"
description: "Run the SvelteKit notebook starter with persistent threads, exact tool approvals, a scoped server and a separate durable worker."
---

Use the `sveltekit` starter to build a SvelteKit application with a working approval flow before adding a paid model.
It includes persistent scoped chat, a deterministic note agent, an explicit approve/reject interface and a separate
durable indexing worker. This is runnable application source, not a hosted service.

## Generate and run

Use Node 24.14.1 or a later supported 24.x version. Run the initializer from a directory you own;
inspect its plan before applying it to an existing project.

```sh
npx mayura@1.2.0 init --starter sveltekit --directory ./my-notebook --apply
cd my-notebook
npm install
npm run setup
npm run dev
```

Open `http://localhost:3000`. Read the generated ignored `.data/login-token` file locally and enter its value in
the notebook's password field. Setup creates an eight-hour local session, never prints its token, and refuses to
replace existing credentials. Keep `.env` and `.data` out of source control.

In another terminal, inside the generated project:

```sh
npm run worker
```

## Follow a complete conversation

1. Connect with the local session and create a thread.
2. Send a note. Inspect the exact proposed input before approving or rejecting it.
3. Approve once: the note is saved and a separate durable indexing workflow is submitted.
4. Let the worker process the index job. Reload, re-enter the session and inspect the persisted history.
5. If a response is lost, inspect the saved run before using the explicit recovery action. Do not send the note again
   with a new key to repair an uncertain write.

The fixture needs no provider API key, model billing or external write. A rejected proposal must not save a note.
Thread history and approval controls remain scoped to the identity verified by the server.

## Framework boundary

The catch-all +server.ts forwards the native HTTP methods to the application handler. The page uses native Svelte controls and headless stores, not React components. Keep connection setup and subscriptions in the browser lifecycle, with disposal when the page disconnects.

| Part | Generated location |
| --- | --- |
| HTTP bridge | `src/routes/api/mayura/[...path]/+server.ts` |
| Notebook interface | `src/routes/+page.svelte` |
| Application and tool configuration | `server/application.mjs` |
| Session verification | `server/auth.mjs` |
| Background processing | `server/worker.mjs` |

The API is mounted at `/api/mayura/*`; the browser's origin-pinned transport preserves the native Mayura route
contract while adding that prefix. Subscribe to the headless thread, run and approval snapshots from the Svelte view. Keep approve/reject behind explicit controls bound to the displayed call. The React copy-in registry does not generate Svelte source in 1.2; the included Svelte interface is the supported starting point.

## Customize identity, tools and storage

Replace the single-user demonstration authenticator with verified application identity before opening the app to
customers. The host fixes principal, project, route capabilities and agent permissions. Browser input cannot choose
a tenant or grant itself a capability. Never distribute one shared owner token to multiple customers.

The note agent and indexing worker have separate grants. If you replace the fixture model, declare the model grant,
prices, finite per-call cost cap and run budget. A gateway subscription does not remove those limits. See
[AI gateways](ai-gateways.md) and [authorization](authorization.md).

Use the generated Node host and a separate Node worker. Review the SvelteKit adapter before switching deployment platforms. PostgreSQL supports multiple hosts; SQLite needs a persistent volume shared with the worker. Serverless hosting still needs a trusted path to advance bounded background work.

A note write and workflow submission are separate operations. If scheduling is unconfirmed after the note was saved,
reconcile the missing index job using the note's identity; never replay the browser write to repair scheduling.
See [framework starter architecture](framework-starters.md) for worker leadership, retention and recovery details.

## Verify your changes

```sh
npm test
npm run typecheck
npm run build
```

The V1.2 release passed the complete cross-platform qualification matrix, including generated packed server
contracts and workspace framework builds/HTTP approval flows. Rendered browser interaction and actual framework
deployments are separate checks; qualify your target before exposing customer data. See
[release validation status](release-readiness.md) and [deployment](deployment.md).

## Continue building

- [Threads and compaction](threads.md): history, recording and bounded summaries.
- [Approvals and human input](approvals-and-human-input.md): exact-call decisions and durable resumption.
- [Copy-in UI](copy-in-ui.md) and [headless stores](react.md): customize the conversation interface.
- [Choose a starter](choosing-a-starter.md): compare this notebook with the other application shapes.
