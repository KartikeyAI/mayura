---
title: "Porting a Node.js agent framework to Workers, Deno, Bun and Vercel Edge"
description: "What stopped Mayura from running outside Node.js, the portable helpers that replaced Node APIs, what stays Node-only, and how CI holds every runtime to Node's results."
date: 2026-10-12
tags: edge, Cloudflare Workers, Deno, Bun, Vercel
---

Mayura 1.0 ran on Node.js. Mayura 1.1 also runs on Cloudflare Workers, Vercel Edge Functions, Deno and Bun, apart from
a short list of entry points that need Node. This paper describes how the port was done: the blockers we found, why
we replaced them the way we did, which entry points stay Node-only and why, how CI checks that every runtime gives the
same results as Node, and what has not yet been proven on a real deployment.

## Summary

- **The blockers were few and specific:** `node:crypto` for hashing, the global `Buffer` for byte work, `process` for
  configuration, TCP sockets for PostgreSQL, and one bundler that resolves package subpaths its own way.
- **The replacements are small portable helpers** in `mayura/core/host`: `sha256`, `sha256Hex`, `utf8ByteLength`,
  `toBase64Url` and `fromBase64Url`. They produce byte-for-byte the same results as the Node APIs they replace, because
  durable records already hold those results.
- **13 of the package's 70 entry points stay Node-only**, because they start processes, load native modules, use the
  filesystem or listen on a port. The other 57 are checked to bundle without any Node API.
- **Two checks run in CI.** `pnpm edge:check` bundles every entry point the way edge bundlers do and fails on any Node
  API outside the Node-only list. `pnpm test:runtimes` runs the same probe on Node, Bun, Deno, workerd and Vercel's
  Edge VM and fails when any result differs from Node's.
- **Still experimental:** deployed Cloudflare Workers and Deno Deploy. They run the same code as CI's workerd and Deno,
  but have not yet run as deployments.

## 1. What "runs on the edge" has to mean

An edge runtime is not a smaller Node.js. Cloudflare Workers without `nodejs_compat` and Vercel Edge Functions offer
web-standard APIs only: `fetch`, `Request` and `Response`, `TextEncoder`, Web Crypto, streams, timers. There is no
`node:` module, no `Buffer`, no `process`, no filesystem and, on Vercel Edge, no TCP socket. Deno and Bun implement
much of Node's API, but not all of it identically, and code that works there may still fail on Workers.

So "it runs" has two parts, and the port treated them separately:

1. **It loads.** The entry point's code, bundled the way the platform bundles it, references nothing the runtime
   lacks. This is a static property, and it can be checked without running anything.
2. **It behaves the same.** For a framework whose durable records hold digests, cursors and encoded vectors, "close
   enough" is a bug. A workflow started on Node and advanced on Workers must compute the same definition hash, or the
   run refuses to continue. So the check is equality with Node's results, not the absence of exceptions.

We aimed at the strictest targets: workerd at an old compatibility date without `nodejs_compat`, and Vercel's Edge VM,
which is checked to define no `Buffer`, `process` or `require` at all. Code that runs there runs on the others.

## 2. The blockers

Bundling every entry point for a browser-like platform and recording each Node built-in it reached gave a short list.

**`node:crypto`.** Mayura hashes a lot. A workflow definition's digest pins every durable run to the exact definition
it started with. Storage schemas have digests. Memory scope keys and cursors are hashed. Almost
all of it used `createHash('sha256')` from `node:crypto`, in workflows, storage, memory, remote memory and code mode.

**The global `Buffer`.** Used for three jobs: counting UTF-8 bytes against size limits (`Buffer.byteLength`), base64
and base64url encoding, and packing embedding vectors as little-endian floats (`writeFloatLE`, `readFloatLE`).

**`process`.** Reading `process.env` is the obvious one. Mayura's packages already avoided it on principle (adapters
take keys explicitly and never look in the environment), so the remaining uses were in Node-only code such as the CLI
and the Docker sandbox. The edge-specific consequence is for applications: on Workers without `nodejs_compat` and on
Vercel Edge, configuration comes from the platform's bindings and is passed in.

**TCP sockets.** `mayura/storage-postgres` opens connections through `pg`, which needs `node:net`. Vercel Edge has no
TCP sockets at all.

**Subpath resolution.** A Vercel Edge preview deployment failed with "referencing unsupported modules" on
imports such as `mayura/workflows/lifecycle`, which loaded fine everywhere else. Vercel's Edge bundler resolved nested
subpaths by file path rather than through the package's `exports` map. The fix is in the package layout: every subpath
also has a file at its own path (`workflows/lifecycle/index.js`, with its declarations) that re-exports the module,
`exports` points at it, and the bundle check requires it. Both kinds of resolution now reach the same module.

## 3. The host helpers

The replacements live in `packages/core/src/bytes.ts` and are exported from `mayura/core/host`:

```ts
import { fromBase64Url, sha256, sha256Hex, toBase64Url, utf8ByteLength } from 'mayura/core/host';

sha256Hex('Grüße, 世界 🌏');           // 64 lowercase hex characters, as createHash('sha256') gives
utf8ByteLength('🌏');                  // 4, as Buffer.byteLength gives
toBase64Url(new Uint8Array([251, 255])); // '-_8', as Buffer#toString('base64url') gives
fromBase64Url('-_8');                  // Uint8Array [251, 255]
sha256(new Uint8Array([0, 1, 254, 255])); // the 32-byte digest
```

### 3.1 Why a synchronous SHA-256 in JavaScript

Every runtime on the list has Web Crypto, and `crypto.subtle.digest('SHA-256', …)` would have been the obvious
replacement. It returns a promise. Much of Mayura's hashing happens in synchronous code: a workflow definition
computes its digest when it is built, and size and identity checks run inside synchronous validation.
Making those paths asynchronous would have changed public APIs to remove a Node dependency, which is the wrong trade.

So `sha256` is synchronous everywhere. Where the runtime exposes Node's crypto module through
`process.getBuiltinModule`, it uses that; elsewhere it runs SHA-256 (FIPS 180-4) in JavaScript. The detection is
guarded so that a runtime without `process` simply takes the second path:

```ts
const nativeCreateHash = ((): ((algorithm: 'sha256') => NativeHash) | undefined => {
  try {
    const host = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const crypto = typeof host?.getBuiltinModule === 'function' ? host.getBuiltinModule('node:crypto') as { createHash?: (algorithm: string) => NativeHash } | undefined : undefined;
    return typeof crypto?.createHash === 'function' ? algorithm => crypto.createHash!(algorithm) : undefined;
  } catch { return undefined; }
})();
```

Where code is already asynchronous, Web Crypto is used directly: JWT verification in `mayura/auth` and S3 request
signing in `mayura/files` call `crypto.subtle`, and `crypto.randomUUID()` is the Web Crypto global everywhere.

### 3.2 Byte-for-byte, not approximately

Durable records written by Mayura 1.0 on Node hold digests, base64 vectors and cursors. If the portable helpers
disagreed with Node's APIs in a single case, a stored record would stop matching after an upgrade, on Node itself. So
the helpers are tested against the APIs they replace (`packages/core/test/bytes.test.ts`):

- `sha256Hex` equals `createHash('sha256')` for fixed samples chosen around the 55, 56, 63, 64 and 65-byte padding
  boundaries, and for property-based inputs (fast-check) including binary strings, graphemes and lone surrogates, on
  both the native and the JavaScript path. A second test removes `process.getBuiltinModule` and checks the JavaScript
  path alone.
- `utf8ByteLength` equals `Buffer.byteLength`, including lone surrogates, which both count as U+FFFD.
- `toBase64Url` equals `Buffer#toString('base64url')`, and `fromBase64Url` reads back what `Buffer` wrote.

Each module that used Node changed by a line or two. Memory's vector packing shows the pattern:

```js
const bytes = new Uint8Array(vector.length * 4); const view = new DataView(bytes.buffer);
vector.forEach((value, index) => view.setFloat32(index * 4, value, true));
return bytesToBase64(bytes);
```

`DataView` with `littleEndian: true` writes the same bytes `writeFloatLE` did, so stored vectors from 1.0 still decode.

### 3.3 PostgreSQL over a pool you own

For PostgreSQL the answer was not a helper but a seam. `mayura/storage-postgres/driver` runs the same store on a
pg-compatible pool that you create, and does not import `pg`:

```ts
import { createPostgresStore } from 'mayura/storage-postgres/driver';

const store = createPostgresStore({ driver: pool, schema: 'mayura' });
await store.initialize();
```

On Vercel Edge, `pool` is a WebSocket pool such as `Pool` from `@neondatabase/serverless`. On Workers with
`nodejs_compat`, Deno and Bun, a `pg` Pool works too. The pool must hand out real sessions, because each operation
runs as one transaction on a client from `connect()`; single-query HTTP drivers do not work. Mayura never ends a pool
it did not create. The data, schema and migrations are the same as with a connection string, so a Node worker and an
edge function can share one database. On Workers, `@mayurajs/storage-d1` keeps everything in D1 instead. See
[Storage](../../../docs/guides/storage.md#a-pool-you-own).

## 4. What stays Node-only, and why

`scripts/edge-check.mjs` keeps the list, with a reason for each entry:

| Entry point | Why it needs Node |
|---|---|
| `mayura/cli`, `mayura/cli/deploy` | the command line; deployment tools run as child processes |
| `mayura/server-node` | the Node HTTP server (`mayura/server` is the portable request handler) |
| `mayura/terminal` | the terminal |
| `mayura/skills` | loads skills from the filesystem |
| `mayura/artifacts` | the local artifact store writes to the filesystem (`mayura/artifacts/files` is the portable one) |
| `mayura/storage`, `mayura/storage-sqlite` | SQLite through a native module |
| `mayura/storage-postgres` | `pg` needs TCP sockets; use `mayura/storage-postgres/driver` |
| `mayura/sandbox/docker` | runs Docker as a child process or over its local socket |
| `mayura/browser/local` | launches the installed Chrome or Edge |
| `mayura/adapter-code-docker`, `mayura/adapter-code-quickjs` | run untrusted Code Mode programs in separate processes |

The list is short because of a rule the codebase already had: keep infrastructure out of the core. Agents, tools,
the runtime, workflows, memory, the server's request handler, model providers and most integrations depended on
`fetch` and plain JavaScript already. Where a portable twin exists, it is a separate entry point
(`storage-postgres/driver`, `artifacts/files`, `server`), so choosing it is an import, not a configuration flag.

The Code Mode sandboxes are Node-only for a reason worth stating: they are the security boundary for programs a model
writes, and they rely on starting a fresh process per execution under Node's permission model, or a container. An edge
isolate is a different boundary, and porting them would mean qualifying a new one.

## 5. How CI checks every runtime

### 5.1 `pnpm edge:check`: does it load?

The script bundles every entry point of the package with rolldown, for the browser platform with the `edge-light`,
`worker` and `browser` conditions, as an edge bundler would. A plugin records every Node built-in module the bundle
reaches and which file reached it; a second pass looks for the global `Buffer` and `process` in the output. An entry
point outside the Node-only list that reaches either fails the build, and so does a Node-only entry that no longer
exists. Running it on this repository after `pnpm build` prints:

```text
57 entry points are edge-compatible; 13 are Node-only.
```

`node scripts/edge-check.mjs --report` prints what each entry point reaches. For the Node-only ones it is what you
would expect: `child_process`, `fs`, `net`, `worker_threads`, `http`.

### 5.2 `pnpm test:runtimes`: does it behave the same?

`scripts/runtime-probe.mjs` is one offline probe: a scripted model, an in-memory store, no network. It runs six
checks, each returning a deterministic value:

| Check | What it returns |
|---|---|
| hashing | SHA-256 of an empty string, of mixed-script text with an emoji, and of raw bytes |
| agent run with a tool | the output of an agent that calls `math.add` |
| server fetch handler | a run submitted to `createAgentServer` with a `Request`, then polled until it succeeds |
| durable workflow with a tool step | the output, and the definition hash stored in the run's record |
| memory pages and embeddings | a page cursor, two pages of records, and an embedding vector |
| PostgreSQL store on a driver pool | the error code when the pool cannot connect |

`scripts/runtime-check.mjs` runs the probe on Node first, as the reference, then on:

- **Bun** and **Deno**, as executables on the probe file (Deno with `--node-modules-dir=manual`, so it resolves the
  probe's imports through the workspace's `node_modules` as Node does);
- **workerd**, Cloudflare's runtime, with the probe bundled into a Worker at compatibility date `2024-09-01` and no
  `nodejs_compat`: no `node:` modules, no `Buffer`, no `process`;
- **Vercel's Edge VM** (`@edge-runtime/vm`), with the probe bundled as one script, after checking that `Buffer`,
  `process` and `require` are all undefined.

Each check's value is compared with Node's using `isDeepStrictEqual`. A digest, cursor or encoding that differs fails
as surely as an exception. In CI, the `runtimes` job runs both scripts with `--require bun,deno,workerd,edge`, so a
missing runtime is a failure rather than a skip; it pins Bun 1.4.2 and Deno 2.9.6.

Locally, without Bun or Deno installed, the same command reports what it could run. On this repository (Windows 11,
Node.js 24) it printed `node: 6/6`, `workerd: 6/6` and `edge: 6/6`, and skipped Bun and Deno. The commit that made
Deno resolve the probe records 6/6 on Windows with Deno 2.9.7 and on Linux with Deno 2.3.1.

### 5.3 On a real platform

Vercel Edge is also tested on a real preview deployment: request-bound agent runs, and a timer workflow advanced by
one-shot invocations, with PostgreSQL through Neon's WebSocket pool. A deployment is what found the subpath resolution
problem in section 2; the local checks had passed. That is the reason for the "experimental" label on the platforms
that have not had one.

## 6. Running there

Porting the code is half of it; the other half is the execution model. An edge function is a serverless function with
a tighter budget, so Mayura runs there the way it runs on Vercel Functions:

- runs finish inside their request (`runExecution: 'request'`);
- workflows advance from a scheduled invocation of `worker.runOnce({ budgetMs })`, a Cron Trigger on Workers, a Vercel
  Cron route, or `Deno.cron`;
- pools are small and migrations run from your pipeline, not from the function;
- each run's `maxDurationMs` stays within the platform's limits: CPU time on Workers, time to first byte and total
  duration on Vercel Edge.

On Workers, one module answers requests and advances workflows:

```ts
// src/worker.ts
export default {
  fetch: (request: Request) => handle(request),
  scheduled: (_controller: unknown, _env: unknown, context: { waitUntil(work: Promise<unknown>): void }) => {
    context.waitUntil(advanceWorkflows());
  },
};
```

Durable workflows make this safe for the same reason they are safe on serverless platforms: a step is recorded as
`dispatching` before its tool is called, and an invocation stopped mid-effect is settled by a later one, never
re-run. See [Never twice](side-effects-never-twice.md) and [Deploy Mayura on Vercel](../integrations/vercel.md).

## 7. Alternatives considered

**Depend on Node compatibility layers.** Workers' `nodejs_compat` and Deno's Node support would have covered much of
the original code. But compatibility layers differ in what they implement and how, Vercel Edge has none, and a
framework that needs a flag to load is one more thing for users to get wrong. Targeting web standards, and testing at
the strictest settings, makes the flags optional.

**Asynchronous hashing with Web Crypto.** Rejected for the synchronous paths, as in section 3.1, because it would have
changed public APIs. Used where code is already asynchronous.

**A hashing dependency.** A third-party SHA-256 would work, but the core keeps third-party dependencies to a minimum,
and the function is a few dozen lines with a reference implementation (`node:crypto`) to test against.

**Separate builds per runtime.** Export conditions can serve different code to different runtimes. One build is
simpler to test: the code Node runs is the code workerd runs, so equality with Node is meaningful.

## 8. What is still experimental, and other limits

- **Deployed Cloudflare Workers and Deno Deploy.** They run the same code as CI's workerd and Deno but have not yet
  run as deployments, and their setup may change in any release. The [D1 store](../../../docs/integrations/storage-d1.md)
  is tested on Cloudflare's D1 implementation in Miniflare (workerd); its live check against a real account has not
  passed yet.
- **The static check is a heuristic for globals.** `edge:check` finds Node modules reliably, because the bundler
  resolves them. For `Buffer` and `process` it searches the bundled code for the common uses (`Buffer.from`,
  `process.env` and similar). An unusual reference could pass it; the runtime probe is the second line of defence.
- **The probe covers paths, not everything.** Six checks exercise agents, the server handler, a durable workflow,
  memory and the driver store. The other edge-compatible entry points are checked to bundle without Node APIs, but are
  not each run on every runtime.
- **Platform limits are yours to respect.** CPU time on Workers and response deadlines on Vercel Edge bound how long a
  run can take. A run that needs longer belongs on a Node server or worker.
- **Node remains the reference.** Node.js 22 and 24 are the supported Node lines; Bun 1.4 and Deno 2.9 are the
  versions tested. See [Support](../../../docs/project/support.md#edge-and-other-javascript-runtimes).

## Further reading

- [Deployment: edge runtimes](../../../docs/guides/deployment.md#edge-runtimes): setting up a Worker, a Vercel Edge
  route or Deno Deploy.
- [Support](../../../docs/project/support.md#edge-and-other-javascript-runtimes): the runtimes, versions and the
  Node-only list.
- [Storage](../../../docs/guides/storage.md): the driver store, D1 and the other stores.
- [Deploy Mayura on Vercel](../integrations/vercel.md): the serverless setup the edge builds on.
