---
title: "Security"
description: "Mayura's security model: what it protects, what your code is trusted with, and how to report a vulnerability."
---

Mayura is a library that runs inside your own Node.js processes. It does not host your agents or see your data. This
page explains what Mayura enforces for you, what it leaves to your application, and how to report a security problem.

## Your code is trusted

Your tools, schemas, guards, hooks, model adapters and authentication callback run in your process with its full
authority. Mayura's permissions decide what the **runtime** is allowed to start, such as which models and tools an
agent may call. They do not sandbox your own code: a tool's `execute` function can still import any Node.js module.
Review tools, and the packages they use, like any other server code.

The one kind of code Mayura treats as untrusted is a program a model writes in **Code Mode** (see below).

## Permissions are explicit

Nothing is allowed by default. A run can call a model or a tool only if its permissions list it, for example
`model:openai.responses` or `tool:orders.lookup`, and a tool that declares capabilities needs those granted too. Model
output never grants anything: when a model asks for a tool, the call goes through the same checks as any other,
namely permission, input schema, guards, budget and timeout, before it runs. See
[Permissions](../concepts/permissions.md).

Costs are capped the same way. A run's default cost limit is 0, so a paid model call is refused until you set a limit;
see [Costs and budgets](../concepts/costs-and-budgets.md).

## No ambient credentials, no telemetry

- **Credentials are passed explicitly.** Model provider adapters take the API key you give them and send requests only
  to their fixed provider endpoint (or the one endpoint you configure). Mayura's packages do not look for keys in
  environment variables, files or cloud metadata. Reading configuration from the environment is your application's
  choice, as the starters do in their own `src/config.ts`.
- **Nothing phones home.** Importing or constructing Mayura opens no network connection. There is no telemetry.
  Exporters, such as `mayura/exporter-otlp`, send data only to the endpoint you configure, and they send metadata
  (timings, statuses, counts), not prompts or outputs.

## Tool effects and outcome_unknown

Every tool declares its effects: `none`, `read`, `write` or `host`. This matters when something goes wrong partway.

If a tool with effects fails after it started (it timed out, the process crashed, the connection dropped), Mayura
cannot know whether the effect happened. The call's outcome is then `outcome_unknown`, and Mayura **never repeats it
automatically**: a refund that may have been paid is not paid again. Durable workflows record every dispatch, so after
a restart they reconcile from that record instead of replaying. To say a call did nothing, throw `ToolRefusal` from
`execute` before any effect; the outcome is then an ordinary failure.

Effects are at least once with deduplication, not exactly once across arbitrary external APIs. For a non-idempotent
API, pass an idempotency key to the provider or reconcile from its records. See [Tools](../concepts/tools.md) and
[Outcomes](../concepts/outcomes.md).

## Code Mode sandboxing

Code Mode lets a model write a small program that calls your tools. Mayura never runs that program in your process,
and never falls back to doing so when a sandbox is unavailable. Two sandboxes ship with Mayura, both qualified for
production use within the guarantees below. They have not had an independent security audit.

**What every execution gets, in both sandboxes:**

- **A fresh interpreter in a fresh process.** Each execution starts a new worker process with a new QuickJS
  interpreter compiled to WebAssembly. Nothing survives from one execution to the next, and the worker is killed when
  the execution ends, however it ends.
- **No host APIs.** The program sees standard JavaScript and `tools.call`, nothing else: no `require`, `import`,
  `process`, `fetch`, network, file system, timers or environment. The `Function` constructor and `eval` compile code
  inside the same interpreter, not in Node.js. The program is compiled and run by QuickJS; its text is never evaluated
  by the host's JavaScript engine.
- **One narrow bridge.** `tools.call` sends a bounded JSON request to the host, which checks it against the program's
  tool list and limits and then calls your broker, with the tool's permissions, schemas, guards and budget. Data
  crossing the bridge in either direction is re-validated as plain JSON (no `__proto__`, `constructor` or `prototype`
  keys, no accessors), so a program cannot pollute host prototypes. The bridge captures its own copies of `JSON`
  before the program starts, so a program that replaces globals changes only its own view.
- **Hard limits.** `cpuMillis` counts the time the interpreter spends running the program and stops it with an
  interrupt the program cannot catch, including in `finally` blocks and promise loops. `memoryBytes` is enforced by the
  WebAssembly memory itself: it cannot grow further, so the allocation fails inside the interpreter. Recursion is
  bounded; a deeper native recursion that exhausts the host stack ends the execution cleanly. Results larger than
  `maxOutputBytes` are refused before they leave the interpreter. A program flooding `tools.call` is answered inside
  the sandbox after `maxToolCalls`; the host never sees more requests than that. `wallTimeMillis` bounds everything,
  and the worker also stops itself at that deadline if the host process disappears.
- **Errors that leak nothing.** Outcome messages are written by Mayura. What the program threw is returned separately
  as `programError`, bounded, and never logged or persisted by Mayura.

**`mayura/adapter-code-quickjs`** runs the worker as a Node.js child process of your application, under the Node.js
permission model: it can read only installed packages (the `node_modules` directory that holds Mayura and QuickJS),
and cannot write files, start processes or worker threads, load native addons, use WASI or open the inspector. It
runs with an empty environment (on Windows, Node.js still passes the variables Windows requires, such as `PATH` and
`USERPROFILE`) and with code generation from strings disabled. Its limit is that the worker is an ordinary process of
your user on your host, sharing its network: code that escaped both QuickJS and V8's WebAssembly sandbox could make
network connections and read installed packages. Use it for programs that models write for your own users.

**`mayura/adapter-code-docker`** runs the same worker, under the same permission model, inside a new container for
each execution:

- no network (`--network=none`), a read-only root file system, a private IPC namespace;
- an unprivileged user (UID/GID 65532), all Linux capabilities dropped, `no-new-privileges`, Docker's default seccomp
  profile;
- at most 16 processes and 64 open files, one CPU, `memoryBytes` plus 256 MiB of memory with no extra swap, and a
  `noexec,nosuid,nodev` `tmpfs` of `scratchBytes` at `/tmp`;
- no log driver, so tool data on the worker's streams is never written to daemon logs;
- an image named by exact content digest and never pulled, whose provenance label must match the SPDX digest you
  configured; optionally a signed, unexpired promotion statement of a clean vulnerability scan, checked before every
  execution;
- the container is force-removed when the execution ends, times out or is cancelled.

Its limit is the one every container shares: the host kernel. For hostile programs from many tenants, run it with a
user-space kernel such as gVisor (`runtime: 'runsc'`) and a rootless daemon (`host`), on hosts that hold no other
secrets. The Docker daemon and CLI are trusted: whoever controls them controls the sandbox.

**Neither sandbox** judges whether a program is correct or safe to run, and neither limits what your tools do when a
program calls them within its permissions. Grant a program only the tools it needs, and require approval of the
program digest for anything with write effects (see [Code Mode](../guides/code-mode.md)).

## The HTTP server

`mayura/server` and `mayura/server-node` verify every bearer token with your `authenticate` callback, never by trusting
what the token claims. Tokens are never accepted in query strings, cookies carry no authority, and browser origins must
be listed exactly (no wildcards). Each route needs a specific capability, such as `workflows:control`. The production
host requires an HTTPS public origin, refuses requests for any other host name and sends HSTS. Requests, bodies,
streams and concurrency are all bounded. See [Server and client](../guides/server-and-client.md).

The quality of authentication is yours: a weak `authenticate` callback weakens everything behind it.

## Secrets in practice

- **Local development:** keep keys in the project's `.env`. `mayura init` writes it readable only by you, the starters'
  `.gitignore` excludes it, and `mayura dev` loads it without printing values.
- **Production:** set secrets in the real environment or a secret manager. `mayura serve` and `mayura worker` do not
  read `.env`.
- **Server tokens:** the starters store only SHA-256 digests of tokens in configuration. The CLI accepts an operator
  token only on stdin (`--token-stdin`), never as an argument; see [Operate a server](../cli/operations.md).
- **Errors are safe to log.** Mayura's public errors carry a code and a fixed message, never a credential or a raw
  provider response.

## Limits

- Mayura has no built-in protection against denial of service beyond its request limits. Put rate limiting in front
  of a public server.
- Anyone with your database credentials bypasses every application check. A separate schema per installation is
  isolation, not authorization.
- If a proxy terminates TLS, keep the plain-HTTP listener reachable only through that proxy.
- Mayura's releases are pre-releases until 1.0.0 and are not yet approved for production use or hostile code.

## Reporting a vulnerability

Please report security problems privately. **Do not open a public issue**, and do not include live credentials or
sensitive logs anywhere public.

1. Use GitHub's private reporting: **Security → Report a vulnerability** on
   [KartikeyAI/mayura](https://github.com/KartikeyAI/mayura/security).
2. If that is not available, email dev@rokad.co with "Mayura security" in the subject.

The project owner triages each report, shares it only with the people needed to fix it, and coordinates a fix, an
advisory and credit with you. Public disclosure happens once a fix is available, or on a date agreed with you.
Pre-releases carry no response-time commitment. A security fix never silently widens permissions or changes where data
is sent. The full policy is in
[SECURITY.md](https://github.com/KartikeyAI/mayura/blob/main/SECURITY.md).

## Related

- [Permissions](../concepts/permissions.md)
- [Code Mode](../guides/code-mode.md)
- [Server and client](../guides/server-and-client.md)
- [Support](support.md)
- [Versioning](versioning.md)
