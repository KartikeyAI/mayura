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

Code Mode lets a model write a small program that calls your tools. Mayura never runs that program in your process:

- `mayura/adapter-code-quickjs` runs it in a separate child process, in a fresh QuickJS interpreter with memory, stack
  and CPU limits. Inside, there is no file system, network, environment, process or module access; the only way out
  is a bounded bridge to tools you allowed, which go through the normal checks.
- `mayura/adapter-code-docker` adds an outer container: no network, read-only root file system, non-root user, no
  Linux capabilities, and limits on processes, memory, CPU and open files. It runs only an image you pinned by digest,
  optionally with a signed promotion statement.

Both adapters are defence in depth and have not had an independent security audit. They are not qualified for
running hostile code from many tenants. The QuickJS adapter must be enabled explicitly with `allowTestAdapter: true`.
See [Code Mode](../guides/code-mode.md).

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
