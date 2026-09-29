---
title: "Mayura with Next.js"
description: "Serve Mayura's agent API from a Next.js route handler, stream runs into React components, and run durable workflows next to your app."
date: 2026-09-29
tags: Next.js, React, streaming
---

Mayura's server is a standard `fetch(request)` handler, so a Next.js app can serve it from a single route handler. There
is no separate API server to deploy, and no proxy between your pages and your agents: the browser calls
`/v1/runs` on your own origin, and Mayura streams the run back to a React component.

This guide covers a Next.js app that runs on a Node.js server with `next start`. For Vercel, the same module works
behind the setup in [Deploy Mayura on Vercel](vercel.md).

## What you'll build

- A route handler that serves Mayura's API at `/v1/*`, with your app's sign-in deciding who may run which agent.
- A client component that starts a run, shows each tool as it runs and streams the reply as it's written.
- A worker process for durable workflows, if your agents start any.

## 1. Install

Next.js already brings React, so Mayura is the only addition:

```bash
npm install mayura
```

## 2. Define the server once

Put the server in its own module, so the route handler stays a thin adapter. `mounted: true` tells Mayura that your
framework routed the request to it: it trusts only the path and query it was given, never the `Host` header.

```ts
// src/mayura.ts
import { createAgentServer } from 'mayura/server';

export const api = createAgentServer({
  publicOrigin: 'https://app.example.com',
  mounted: true,
  agents,
  authenticate: async ({ token }) => {
    const session = await verifySession(token);
    if (!session) return null;
    return {
      scope: { principalId: session.userId, projectId: 'web' },
      agentIds: ['support.assistant'],
      capabilities: ['runs:submit', 'runs:read'],
      expiresAtMs: Math.min(session.expiresAtMs, Date.now() + 60_000),
    };
  },
});
```

`agents` is the list of agents you serve, each with the permissions and limits it runs under; see
[Agent](../../../docs/concepts/agent.md) and [Permissions](../../../docs/concepts/permissions.md). `verifySession` is
your app's own check. Mayura never parses the token: `authenticate` decides who the caller is, which agents they may
use and what they may do, and a caller can't choose any of it. Returning `null` answers `401`.

Keep `principalId` to letters, digits, `.`, `_`, `/` and `-`. If your identity provider uses subjects such as
`auth0|123`, map them, for example to a SHA-256 digest. The
[capabilities table](../../../docs/guides/server-and-client.md#authentication-and-capabilities) lists everything a
caller can be allowed.

## 3. Add the route handler

One catch-all route under `app/v1/` sends every API request to the handler:

```ts
// app/v1/[...path]/route.ts
import { api } from '@/src/mayura';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => api.fetch(request);
export const POST = (request: Request) => api.fetch(request);
```

`runtime = 'nodejs'` keeps it off the edge runtime. `dynamic = 'force-dynamic'` stops Next.js from caching API
responses. The API stays at `/v1/` on your public origin, which is where `mayura/client` expects it.

## 4. Show a live run in React

In the browser, a headless store follows the run's events, and two hooks turn them into state you can render. This
component submits a question, shows each tool as it runs, streams the reply's text and then shows the final reply:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { z } from 'mayura';
import { createClient } from 'mayura/client';
import { createHeadlessRunStore, type HeadlessRunStore } from 'mayura/client/headless';
import { useMayuraRun, useMayuraRunActivity } from 'mayura/client-react';

const Reply = z.object({ reply: z.string() });
const client = createClient({ baseUrl: `${window.location.origin}/`, token: () => sessionToken() });

function RunView({ store }: { readonly store: HeadlessRunStore }) {
  const state = useMayuraRun(store);
  const activity = useMayuraRunActivity(state);
  return (
    <section>
      <p>{state.connection === 'reconnecting' ? 'Reconnecting…' : state.snapshot?.status ?? state.connection}</p>
      <ul>
        {activity.items.filter(item => item.kind === 'tool').map(item => <li key={item.id}>{item.label}: {item.status}</li>)}
      </ul>
      {state.streamedOutput && <p>{state.streamedOutput.text}</p>}
    </section>
  );
}

export function Ask() {
  const [store, setStore] = useState<HeadlessRunStore | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  useEffect(() => () => store?.dispose(), [store]);

  async function ask(message: string): Promise<void> {
    const run = await client.submit('support.assistant', { message }, { idempotencyKey: crypto.randomUUID() });
    const next = createHeadlessRunStore({ run });
    setStore(next);
    setReply(null);
    await next.observe();
    const outcome = await run.result(Reply);
    setReply(outcome?.status === 'succeeded' ? outcome.output.reply : 'Something went wrong.');
  }

  return (
    <div>
      <button onClick={() => void ask('Where is my order?').catch(() => setReply('Something went wrong.'))}>Ask</button>
      {store && <RunView store={store} />}
      {reply && <p>{reply}</p>}
    </div>
  );
}
```

`sessionToken()` returns the token your sign-in gives the browser: the same one `verifySession` checks on the server.
Some details matter:

- **The idempotency key makes submitting safe to retry.** If the network drops after the server accepted the run, the
  same key finds that run instead of starting a second one.
- **Nothing fetches on its own.** Mounting the component or calling a hook never starts a request; `observe()` does,
  and it reconnects a dropped stream from the last event it saw.
- **The streamed text is a preview.** `run.result()` returns the validated final output, and only that counts. If a
  stream guard stops the preview, `streamedOutput.withheld` is set and the text stops growing.
- **Clean up.** Disposing the store stops following the run. It doesn't cancel the run.

For styled building blocks, `mayura/client-react/components` has unstyled, accessible components for a run summary,
workflow graphs and human response forms; see [React and UI bindings](../../../docs/guides/react.md).

## 5. Run workflows next to the app

A route handler only serves requests. If your agents start [durable workflows](../../../docs/guides/durable-workflows.md),
something has to advance them: run `mayura worker` as a second process next to `next start`, and run
`mayura migrate` once per release, before either starts. Both load an application module that exports your worker and
migration; see [Serve, worker and migrate](../../../docs/cli/run.md).

```bash
npx mayura migrate --app dist/src/app.js
npx mayura worker --app dist/src/app.js
```

Agents that don't start workflows need neither.

## Good to know

- **Keep the route on the Node.js runtime.** Mayura 1.0 runs on Node.js 22 and 24. Support for edge runtimes is planned
  for Mayura 1.1.
- **One server instance per process.** Create `api` once, at module level as above, not inside the route handler:
  runs in progress, streams and limits belong to the instance.
- **Several instances need shared run records.** When more than one process serves `/v1/*`, give `createAgentServer`
  `runRecords` backed by PostgreSQL, so any instance can read a run another one started; see
  [Several server replicas](../../../docs/guides/server-and-client.md#several-server-replicas).
- **The repository runs this setup in CI.** `examples/embedded-handler.mjs` mounts the handler the same way and runs it
  end to end.

## Next steps

- [Deploy Mayura on Vercel](vercel.md): the same app on Vercel Functions, with workflows advanced by cron.
- [Streaming](../../../docs/guides/streaming.md): stream an output field as it's written.
- [Build a refund agent with human approval](../guides/refund-approval.md): an agent that starts a durable workflow.
