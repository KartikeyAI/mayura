---
title: "Mayura with Supabase"
description: "Keep Mayura's workflows and run records in Supabase PostgreSQL and let users signed in with Supabase Auth call your agents."
date: 2026-10-12
tags: Supabase, PostgreSQL, authentication, deployment
---

*Supabase details checked against Supabase's documentation on connecting to Postgres, JWT signing keys and custom
schemas on October 12, 2026. Mayura's makers wrote this guide.*

A Supabase project gives you two things Mayura can use directly: a PostgreSQL database, and Supabase Auth, which signs
your users in and hands each session a JWT. This guide uses both. Mayura keeps its workflows, run records and API keys in
its own schema of your Supabase database, and its server accepts your users' Supabase access tokens, with your code
deciding what each user may do.

| | Status in Mayura 1.1 |
|---|---|
| Supabase Auth access tokens (`@mayurajs/auth-supabase`) | Unit tests with real ES256, RS256 and HS256 signatures; a real access token from a real Supabase project verified on October 6, 2026 |
| Supabase PostgreSQL as Mayura's store | Mayura's standard PostgreSQL store. It needs nothing Supabase lacks, but its runs on a Supabase database aren't recorded in the docs, so test your own setup before you rely on it |

## What you'll build

- A Mayura application module run in three roles: `mayura serve` for the API, `mayura worker` for durable workflows and
  `mayura migrate` once per release. All three share your Supabase database.
- Authentication that accepts Supabase access tokens, refuses anonymous and service tokens, and stops a session that
  has signed out.
- A browser client that sends the signed-in user's token with every call.

## 1. Pick the right connection string

Supabase offers several ways in, and the right one depends on what connects. The **Connect** dialog in the Supabase
dashboard shows each string:

| Connection | Address | Use it for |
|---|---|---|
| Direct | `db.<ref>.supabase.co:5432` | Long-running servers and workers, `mayura migrate`, `pg_dump`. IPv6 only, unless you buy the IPv4 add-on |
| Shared pooler, session mode | `aws-<n>-<region>.pooler.supabase.com:5432` | The same, from a network without IPv6. Supports everything a direct connection does |
| Shared pooler, transaction mode | the same host, port `6543` | Serverless and edge functions, which open many short-lived connections |

For containers or a virtual machine, where `mayura serve` and `mayura worker` stay up, use the direct connection or
session mode. Each process keeps a small pool (8 connections in the module below), so the total stays well within the
database's limit. On serverless functions, where every instance opens its own pool, use transaction mode with
`pool: { max: 1 }`, as in [Deploy Mayura on Vercel](vercel.md).

Shared pooler connections log in as `postgres.<ref>` rather than `postgres`. Copy the host from the dashboard instead of
building it from your region: the number in it is a cluster index.

### What transaction mode means for Mayura

In transaction mode, Supabase's pooler hands your connection to another client as soon as each transaction ends.
Supabase lists what breaks: prepared statements, query pipelining, and any session state, including `SET`, session
advisory locks, `LISTEN`/`NOTIFY` and temporary tables.

Mayura's PostgreSQL store avoids all of them:

- **Every operation is one transaction**, so nothing it needs outlives the transaction it runs in.
- **Its timeouts are `SET LOCAL`**: a 10-second statement timeout and a 5-second lock timeout, which end with the
  transaction.
- **The lock `initialize()` takes is transaction-scoped** (`pg_advisory_xact_lock`), so several instances can start at
  once without a session lock.
- **It sends plain parameterized queries, one at a time.** It never names a prepared statement, never pipelines, and
  uses no `LISTEN`, `NOTIFY` or temporary tables.

So every connection type works. Transaction mode is the right one for functions; for long-lived processes it adds a hop
for no benefit.

## 2. Install

```bash
npm install mayura pg @mayurajs/auth-supabase
```

`pg` is the PostgreSQL driver Mayura's store uses, at the version listed in
[Support](../../../docs/project/support.md#package-managers). `@mayurajs/auth-supabase` has no dependencies and no
Supabase SDK: it checks tokens with WebCrypto and your project's published keys.

## 3. Write the application module

This module serves one agent to signed-in users, runs a workflow worker, and owns the migration step. It shares one
`pg` pool between Mayura's store and one query of its own, which is what `mayura/storage-postgres/driver` is for:

```ts
// src/app.ts
import { hostname } from 'node:os';
import { Pool } from 'pg';
import { principalId } from 'mayura/auth';
import { defineMayuraApplication } from 'mayura/cli';
import { listenProductionServer } from 'mayura/server-node';
import { createAggregateRunRecords } from 'mayura/storage-contracts';
import { createPostgresStore } from 'mayura/storage-postgres/driver';
import { createWorkflowLeadership, createWorkflowWorker } from 'mayura/workflows';
import { createWorkflowLifecycleHost } from 'mayura/workflows/lifecycle';
import { supabaseAuthenticator } from '@mayurajs/auth-supabase';
import { assistant } from './assistant.js'; // your agent
import { definitions } from './workflows.js'; // every workflow definition version that still has runs

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const pool = new Pool({ connectionString: env('DATABASE_URL'), max: 8 });
const store = createPostgresStore({ driver: pool, schema: 'mayura' });
let initialized: Promise<void> | undefined;
const ready = () => (initialized ??= store.initialize());

const authenticate = supabaseAuthenticator({
  projectUrl: env('SUPABASE_URL'), // https://<ref>.supabase.co
  identity: async session => {
    // A Supabase access token stays valid until it expires, even after sign-out. Refuse it once the session is gone.
    if (!session.sessionId) return null;
    const live = await pool.query('SELECT 1 FROM auth.sessions WHERE id = $1 AND user_id = $2', [session.sessionId, session.userId]);
    if (live.rows.length === 0) return null;
    return {
      principalId: principalId('supabase', session.userId),
      projectId: 'support',
      agentIds: [assistant.id],
      // app_metadata is set only by your server and Supabase. Never grant from user_metadata.
      capabilities: session.appMetadata['role'] === 'staff' ? ['runs:submit', 'runs:read', 'runs:cancel'] : ['runs:submit', 'runs:read'],
    };
  },
});

export default defineMayuraApplication({
  async server() {
    await ready();
    return listenProductionServer({
      agents: [{ agent: assistant, permissions: { allow: ['model:openai.responses'] }, limits: { maxCostMicros: 200_000 } }],
      authenticate,
      runRecords: createAggregateRunRecords(store),
      publicOrigin: env('MAYURA_PUBLIC_ORIGIN'),
      hostname: '0.0.0.0',
      port: Number(process.env['PORT'] ?? 8080),
      tls: { terminatedBy: 'proxy' },
      readiness: async () => { await store.read('readiness', 'probe'); return true; },
    });
  },
  async worker() {
    await ready();
    const host = createWorkflowLifecycleHost({ store, scope, definitions, permissions, policyVersion: '1', maxCostMicros });
    const leadership = createWorkflowLeadership({ store, scope, role: 'workflows', holderId: process.env['MAYURA_WORKER_ID'] ?? `${hostname()}-${process.pid}` });
    return createWorkflowWorker({ units: [host], leadership });
  },
  async migrate() { await ready(); return { schemaVersion: 1 }; },
  async shutdown() { await store.close(); await pool.end(); },
});
```

`scope`, `permissions` and `maxCostMicros` belong to your workflows: the service principal they run as, what their
steps may do and what they may spend. The [Deployment guide](../../../docs/guides/deployment.md#the-application-module)
explains every part of this module, and the [refund approval guide](../guides/refund-approval.md) builds a workflow
to put in `definitions`.

A few choices in it are worth explaining:

- **The store lives in schema `mayura`.** Supabase's Data API exposes only the `public` schema unless you add others
  under **Exposed schemas**, so Mayura's tables stay out of reach of the `anon` and `authenticated` roles. Keep it that
  way: storage methods are application APIs, never something a browser should call.
- **`store.close()` never ends a pool it didn't create.** That is why `shutdown()` ends the pool itself, after the
  store.
- **`principalId('supabase', userId)` makes a valid id** from Supabase's user UUID and keeps it stable, so each user's
  runs and memory stay theirs.
- **The `auth.sessions` check is optional.** It costs one query each time a token is checked, and it closes the gap
  between sign-out and token expiry, an hour by default. Drop it if short-lived tokens are enough for you.

## 4. What the authenticator checks

`supabaseAuthenticator` verifies each token against `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`, keeping
keys for at most 10 minutes, as Supabase asks. A token passes only if:

- its issuer is `<projectUrl>/auth/v1` and its audience is `authenticated`;
- it is signed with ES256 or RS256 by one of your project's keys, and hasn't expired;
- its `role` is `authenticated`. Tokens made from the publishable (anon) key or the `service_role` key never act as a
  user;
- it isn't an anonymous user, unless you pass `allowAnonymous: true`.

Pass `requireAal2: true` to accept only users who signed in with a second factor, for agents that act on money or
personal data.

If your project still signs tokens with the legacy JWT secret (HS256), also pass it as `jwtSecret` until you have
rotated to asymmetric keys. Supabase's dashboard migrates the secret and rotates without downtime; once no unexpired
token was signed with the secret, remove `jwtSecret` from your configuration. See
[Supabase Auth tokens](../../../docs/integrations/auth-supabase.md) for every option and error.

## 5. Call agents from the browser

`supabase-js` keeps the session and refreshes its token. Give `mayura/client` a function that reads the current one:

```ts
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient } from 'mayura/client';

const supabase = createSupabaseClient('https://abcdefghijklmnopqrst.supabase.co', 'sb_publishable_...');

const agents = createClient({
  baseUrl: 'https://agents.example.com/',
  token: async () => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new Error('Sign in first.');
    return data.session.access_token;
  },
});

const run = await agents.submit('support.assistant', { message: 'Where is my order?' }, { idempotencyKey: crypto.randomUUID() });
```

The client asks for the token on every request, so a refreshed token is picked up without any work on your side.
[Mayura with Next.js](nextjs.md) shows how to stream the run into React components.

If the browser app and the agent server live on different origins, list the app's origin in `allowedOrigins` on the
server.

## 6. Deploy

Set four variables where the processes run: `DATABASE_URL`, `SUPABASE_URL`, `MAYURA_PUBLIC_ORIGIN` and your model
provider's key. Then, for each release:

```bash
npx mayura migrate --app dist/app.js
npx mayura serve --app dist/app.js
npx mayura worker --app dist/app.js
```

Run `migrate` to completion first, with the direct or session-mode string, then start servers and workers. Version 1 is
the baseline for Mayura 1.x, so today `migrate` creates Mayura's tables if they are missing and checks the version. Any
container platform works; [Deployment](../../../docs/guides/deployment.md#choose-a-target) has the Dockerfile,
Kubernetes manifests and platform notes.

## Good to know

- **Back up Mayura's schema on its own.** `pg_dump -Fc -n mayura` over the direct connection takes a consistent copy
  while the app keeps running; Supabase recommends the direct connection for `pg_dump` and restores. See
  [Back up and restore](../../../docs/guides/storage.md#back-up-and-restore).
- **Your own tables and Mayura's can share the database.** A workflow step can read and write your `public` tables
  through tools you define, while Mayura's state stays in `mayura`. A schema keeps data apart; it isn't an
  authorization boundary, so the database role you connect with still decides what is reachable.
- **Storage errors never contain SQL or credentials.** If the database is unreachable, calls fail with
  `STORAGE_UNAVAILABLE`; check the run before retrying anything with effects.
- **Watch the connection count** when you scale out: every server and worker replica holds up to its pool's `max`.
  Lower `max`, or move to the pooler, before you raise the database's limit.

## Next steps

- [Storage](../../../docs/guides/storage.md#postgresql): pool settings, schemas and migrations.
- [Authentication and API keys](../../../docs/guides/authentication.md): API keys for programs, next to your users'
  tokens.
- [Mayura with Neon](neon.md): the same setup on Neon, with its serverless driver at the edge.
