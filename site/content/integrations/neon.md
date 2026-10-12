---
title: "Mayura with Neon"
description: "Keep Mayura's state in Neon PostgreSQL over pooled, direct or WebSocket connections, and accept Neon Auth tokens on your agent server."
date: 2026-10-12
tags: Neon, PostgreSQL, authentication, edge
---

*Neon details checked against Neon's documentation on connection pooling, the serverless driver, Neon Auth and
branching on October 12, 2026. Mayura's makers wrote this guide.*

[Neon](https://neon.com) is serverless PostgreSQL: compute that scales with load, a built-in connection pooler, a
driver that connects over WebSockets where TCP isn't available, and Neon Auth, a managed better-auth whose users live
in the same database. Mayura can use all of it. Its store keeps workflows, run records and API keys in a schema of your
Neon database, and `@mayurajs/auth-neon` turns Neon Auth tokens into identities on your agent server.

| | Status in Mayura 1.1 |
|---|---|
| Neon's pooled connection from Vercel Functions | Tested on a real Vercel deployment; see [Deploy Mayura on Vercel](vercel.md) |
| Neon's WebSocket `Pool` through `mayura/storage-postgres/driver` | Tested on a Vercel Edge preview deployment: request-bound agent runs and a timer workflow advanced by one-shot invocations |
| Mayura's PostgreSQL store on a Neon database | Passed the hosted-database live check (`scripts/live/storage-postgres.mjs`) on October 12, 2026: migrations, a record and its events, and API keys |
| Neon Auth tokens (`@mayurajs/auth-neon`) | Unit tests with real EdDSA signatures; the live check hasn't passed against a real Neon project yet |

## Three ways to connect

The **Connect** dialog in the Neon console shows two connection strings for each branch. The pooled one has `-pooler`
after the endpoint id in its host name (`ep-cool-darkness-123456-pooler...`) and goes through PgBouncer; the other
connects to the compute directly. The serverless driver is the third way.

| Connection | Use it for |
|---|---|
| Pooled (`-pooler`) | Serverless functions and anything that runs many instances. PgBouncer accepts up to 10,000 client connections and shares a smaller set of real ones |
| Direct | `mayura migrate`, `pg_dump` and `pg_restore`, and long-running processes that want no pooler between them and the database |
| `@neondatabase/serverless` `Pool` | Runtimes without TCP sockets, such as Vercel Edge. It speaks PostgreSQL over a WebSocket |

### Mayura behind PgBouncer

Neon runs PgBouncer in transaction mode: a connection goes back to the pool after each transaction. Neon lists what
that rules out: session advisory locks, `SET` and `RESET`, `LISTEN`/`NOTIFY`, and SQL-level `PREPARE`.

Mayura's PostgreSQL store needs none of them. Every operation is one transaction. Its statement and lock timeouts are
`SET LOCAL`, which lasts only for that transaction. The lock `initialize()` takes so that several instances can start at
once is `pg_advisory_xact_lock`, which is released when the transaction ends. And it sends parameterized queries,
never a named prepared statement. So the pooled string is safe for everything Mayura does at runtime.

Migrations and backups are the exception, by Neon's advice rather than Mayura's needs: Neon recommends the direct
connection for schema migrations and always for `pg_dump`.

## 1. Install

```bash
npm install mayura pg @mayurajs/auth-neon
```

For the edge setup in step 4, add `@neondatabase/serverless`. `@mayurajs/auth-neon` has no dependencies and no Neon
SDK: it checks tokens with WebCrypto and your project's published keys.

## 2. Storage and authentication

On Node.js, whether a long-running server or a function, the store takes the connection string:

```ts
// src/mayura.ts
import { principalId } from 'mayura/auth';
import { createAgentServer } from 'mayura/server';
import { createAggregateRunRecords } from 'mayura/storage-contracts';
import { createPostgresStore } from 'mayura/storage-postgres';
import { neonAuthAuthenticator } from '@mayurajs/auth-neon';

// The pooled string; one connection per instance on functions, a few on a long-running server.
const store = createPostgresStore({ connectionString: process.env['DATABASE_URL']!, schema: 'mayura', pool: { max: 1 } });
const ready = store.initialize();

export const authenticate = neonAuthAuthenticator({
  authUrl: process.env['NEON_AUTH_BASE_URL']!, // https://ep-xxx.neonauth.<region>.aws.neon.tech/neondb/auth
  identity: session => session.emailVerified ? {
    principalId: principalId('neon', session.userId),
    projectId: 'support',
    agentIds: ['support.assistant'],
    capabilities: session.role === 'admin' ? ['runs:submit', 'runs:read', 'runs:cancel'] : ['runs:submit', 'runs:read'],
  } : null,
});

const api = createAgentServer({
  publicOrigin: 'https://agents.example.com', mounted: true, agents, authenticate,
  runRecords: createAggregateRunRecords(store),
  runExecution: 'request',
});

/** Answer one request to Mayura's API. */
export async function handle(request: Request): Promise<Response> {
  await ready;
  return api.fetch(request);
}
```

This is the module from [Deploy Mayura on Vercel](vercel.md), with Neon Auth in place of a placeholder `authenticate`.
That guide adds the route files, the cron route that advances workflows, and what we measured with exactly this
database on a real deployment. On a long-running server, drop `runExecution: 'request'` and raise `pool.max`, or use
the application module from [Deployment](../../../docs/guides/deployment.md#the-application-module).

`NEON_AUTH_BASE_URL` is your project's Neon Auth URL, from the **Auth** page in the Neon console. It isn't a secret:
`neonAuthAuthenticator` uses it to find your project's public keys.

## 3. What Neon Auth tokens prove

Neon Auth signs a JWT for each signed-in user. `neonAuthAuthenticator` accepts one only if:

- it is signed with EdDSA (Ed25519) by a key from `<authUrl>/.well-known/jwks.json`;
- its issuer and audience are both your Neon Auth URL's origin;
- it carries `exp` and hasn't expired, with 5 seconds of leeway for clock differences;
- it names a user (`sub`), and that user isn't banned. A ban with a `banExpires` in the past no longer counts.

Your `identity` mapping does the rest. The example only lets in users whose email is verified, and gives admins one
extra capability. Mayura never grants anything the mapping doesn't return, and a mapping that returns something the
server can't use answers `503`, never lets the caller in.

The tokens last 15 minutes, so a user who signs out or is banned can keep calling your agents with a token they
already hold until it expires. If that matters, check the user in `identity`: Neon Auth keeps its data in the
`neon_auth` schema of the same database, which your server can query.

In the browser, Neon Auth signs users in with an HTTP-only cookie. For a separate backend such as your agent server, Neon's
client hands out the JWT itself with `authClient.token()`; call it again when the token expires. Send it as the bearer
token:

```ts
import { createClient } from 'mayura/client';

const agents = createClient({
  baseUrl: 'https://agents.example.com/',
  token: async () => {
    const { data, error } = await authClient.token();
    if (error) throw error;
    return data.token;
  },
});
const run = await agents.submit('support.assistant', { message: 'Where is my order?' }, { idempotencyKey: crypto.randomUUID() });
```

## 4. At the edge, with Neon's serverless driver

`mayura/storage-postgres` opens TCP sockets through `pg`, and Vercel's Edge runtime has none. There,
`mayura/storage-postgres/driver` runs the same store on a pool you create, and Neon's WebSocket `Pool` is one. Two rules
come from the driver:

- **Use `Pool`, not `neon()`.** The HTTP query function runs single queries and non-interactive transactions, but
  Mayura runs each operation as an interactive transaction on a client it checks out with `connect()`. The `Pool`
  gives real sessions over a WebSocket.
- **One pool per request.** On edge runtimes a WebSocket can't outlive the request that opened it, so Neon says to
  create the pool, use it and close it inside one handler.

Mayura can't end the pool for you, because it never ends a pool it didn't create. And it may still be reading from the
database after `fetch` returns, while an event stream's body is being sent. So end the pool once the last byte is out:

```ts
// src/mayura-edge.ts
import { Pool } from '@neondatabase/serverless';
import { createAgentServer } from 'mayura/server';
import { createAggregateRunRecords } from 'mayura/storage-contracts';
import { createPostgresStore } from 'mayura/storage-postgres/driver';

type WaitUntil = (work: Promise<unknown>) => void;

/** Answer one request on an edge runtime, with a pool that lives as long as the response. */
export async function handleEdge(request: Request, waitUntil: WaitUntil): Promise<Response> {
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    const store = createPostgresStore({ driver: pool, schema: 'mayura' });
    await store.initialize();
    const api = createAgentServer({
      publicOrigin: 'https://agents.example.com', mounted: true, agents, authenticate,
      runRecords: createAggregateRunRecords(store),
      runExecution: 'request',
    });
    const response = await api.fetch(request);
    if (!response.body) { waitUntil(pool.end()); return response; }
    const { readable, writable } = new TransformStream();
    waitUntil(response.body.pipeTo(writable).finally(() => pool.end()));
    return new Response(readable, response);
  } catch (error) {
    waitUntil(pool.end());
    throw error;
  }
}
```

On Vercel, pass `waitUntil` from `@vercel/functions` and serve the function at `/v1/*` on your public origin, where
`mayura/client` expects the API. The cron route that advances workflows follows the same pattern: open a pool, call
`runOnce({ budgetMs })` and end the pool in a `finally`.

Every request opens a store and initializes it: one short transaction that checks Mayura's schema. That is the cost of
a pool that can't outlive its request.

**Time limits are tighter at the edge.** A Vercel Edge function must begin its response within 25 seconds, and a
request-bound run answers only after the run has finished. Keep each agent's `limits.maxDurationMs`, plus the server's
`requestTimeoutMs`, under that. The same goes for the cron sweep: its budget plus your longest tool's `timeoutMs` must
fit in 25 seconds.

Unless you need the edge, prefer the Node.js runtime. Vercel itself recommends migrating from Edge to Node.js, and
Next.js 16.3 no longer supports `runtime = 'edge'` in route files. [Edge runtimes](../../../docs/guides/deployment.md#edge-runtimes)
covers the other platforms, including Cloudflare Workers, where a `pg` Pool also works; see
[Run Mayura on Cloudflare Workers](cloudflare-workers.md).

## 5. Migrate over the direct connection

Functions never change the schema themselves. Run the migration from CI before each release, with the direct string:

```bash
npx mayura migrate --app dist/src/app.js
```

Give that one step the direct connection string as `DATABASE_URL`, and keep the pooled one for everything that serves
traffic. Version 1 is the baseline for Mayura 1.x: `migrate` creates Mayura's tables if they are missing and checks the
version. Back up the schema the same way, with `pg_dump -Fc -n mayura` over the direct connection; see
[Back up and restore](../../../docs/guides/storage.md#back-up-and-restore).

## Watch your branches

A Neon branch is a copy of a database at a point in time, and with Neon Auth it copies your users and sessions too. That makes them good for previews and tests. It also copies Mayura's schema, workflows in flight included.

Mayura guarantees that a workflow step with side effects never runs twice, but that guarantee lives in one store. A
branch is a second store. If a worker or a cron route on a preview deployment advances a branch copied from
production, it finds production's due workflows and runs their next steps, against real payment providers, email
services and APIs, a second time.

To keep previews safe:

- **Don't advance workflows on previews** that point at a copy of production. Vercel runs cron jobs on production
  deployments only, which helps, but a worker you start yourself has no such guard.
- **Branch without the data** where you can. Neon documents
  [schema-only branches](https://neon.com/docs/guides/branching-schema-only), which copy the tables and none of the rows.
- **Give previews their own tool credentials**, such as test-mode payment keys, so a step that does run can't reach a
  real customer.

## Good to know

- **Scale to zero has a short cold start.** A compute suspends after 5 minutes without activity by default, and the
  next connection waits a few hundred milliseconds while it restarts. That fits well within the store's
  `connectionTimeoutMs` (5 seconds by default), but shows up in the first request's latency.
- **Watch the connection count** on long-running servers: each process keeps up to its pool's `max` connections. If
  you see connection errors under load, check that serving processes use the pooled string.
- **Storage errors never contain SQL or credentials.** If the database is unreachable, calls fail with
  `STORAGE_UNAVAILABLE`; check the run before retrying anything with effects.
- **Keep Mayura's tables in their own schema.** Your tables, Neon Auth's `neon_auth` schema and Mayura's `mayura` schema
  can share one database. A schema keeps data apart; it isn't an authorization boundary.

## Next steps

- [Deploy Mayura on Vercel](vercel.md): the full function setup on Neon, and what we measured.
- [Neon Auth tokens](../../../docs/integrations/auth-neon.md): every option and error.
- [Mayura with Supabase](supabase.md): the same pattern on Supabase's database and Auth.
