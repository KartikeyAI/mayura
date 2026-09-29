---
title: "Support"
description: "Supported Node.js versions, platforms and package managers, how to get help with Mayura, and how to report a bug."
---

This page lists the environments Mayura is built and tested for, and where to go when something does not work.

## Node.js

Mayura runs on Node.js 22 and 24:

| Line | Minimum version | Supported until |
|---|---|---|
| Node.js 22 | 22.12.0 | 2027-04-30 |
| Node.js 24 | 24.14.1 | 2028-04-30 |

The package's `engines` field declares exactly this range (`>=22.12.0 <23 || >=24.14.1 <25`). Each line is supported
while it is in active or maintenance LTS; see [Versioning](versioning.md).

Mayura is published as ES modules. Use it from an ES module project (`"type": "module"` in `package.json`, or `.mjs`
files) with TypeScript's `NodeNext` module setting. CommonJS projects are not supported.

The browser entry points (`mayura/client`, its `headless`, `forms` and `workflows` subpaths, and
`mayura/client-react`) also run in browsers. Everything else needs Node.js.

## Platforms

| Platform | Status |
|---|---|
| Linux, x64 | Supported. Tested in CI, and clean installs are verified in Alpine Linux containers on Node.js 22 and 24. |
| Windows, x64 | Supported. Tested in CI, and clean installs are verified on Windows 11 with Node.js 24. |
| macOS | Tested in CI on Node.js 22 and 24. Not yet part of the verified install matrix. |

Serverless functions on Vercel are supported on those Node.js versions, with runs that finish inside their request and
workflows advanced on a schedule; see [Deployment](../guides/deployment.md#serverless-functions). AWS Lambda and Google
Cloud Run functions, Vercel Cron and Next.js route handlers are experimental: they pass the same local tests but have
not yet run on those platforms, and their setup may change in any release. Edge runtimes (Cloudflare Workers, Deno and Bun) are planned
for 1.1.

Other environments may work but are not supported: Arm Linux and Windows, edge runtimes, and Node.js versions outside
the table above.

## Package managers

Installs are verified with npm (npm 10 on Node.js 22, npm 11 on Node.js 24). Yarn and pnpm are not currently
verified for consumer projects.

The optional packages that some entry points need (see [Entry points](../reference/entry-points.md)) are declared
with the exact versions Mayura is tested with:

| Package | Version |
|---|---|
| `better-sqlite3` | 13.0.3 |
| `pg` | 8.23.0 |
| `quickjs-emscripten-core`, `@jitl/quickjs-wasmfile-release-sync` | 0.32.0 |
| `react` | 18.3 or 19 |

Install those versions. npm reports a peer dependency conflict if you install a different one. Projects created by
`mayura init` already list the right versions.

## Getting help

- **Read the docs for your version.** The documentation ships inside the `mayura` package, in
  `node_modules/mayura/docs`, so it always matches the version you have installed.
- **Look at a working example.** The [starters](../cli/init.md) are complete applications with tests.
- **Ask or report on GitHub.** Open an issue at
  [github.com/KartikeyAI/mayura/issues](https://github.com/KartikeyAI/mayura/issues).

Support is community support on a best-effort basis. Release candidates and `0.x` releases carry no response-time
commitment, and only the latest pre-release is supported: upgrade to it before reporting a problem.

## Reporting a bug

A good bug report includes:

- the `mayura` version (`npx mayura --version`), your Node.js version (`node --version`) and your operating system;
- the smallest code that shows the problem, ideally built on `scriptedModel` from `mayura/testing` so it runs without
  a model provider;
- what you expected, and what happened instead, including the error `code` and message.

Leave out API keys, tokens, customer data and full logs. Mayura's error messages are designed to be safe to share;
your own logs may not be.

**Do not report security vulnerabilities in public issues.** Follow [Security](security.md) instead.

## Related

- [Installation](../installation.md)
- [Versioning](versioning.md)
- [Security](security.md)
- [Entry points](../reference/entry-points.md)
