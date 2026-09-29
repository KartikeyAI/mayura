---
title: "Installation"
description: "Requirements, the optional packages each part of Mayura needs, and TypeScript settings."
---

```bash
npm install mayura
```

pnpm, Yarn and Bun work too. Schemas need nothing else: `mayura` exports `z`, which is [Zod](https://zod.dev) 4, so
`import { defineTool, z } from 'mayura'` is all these docs use. Any other validator that implements
[Standard Schema](https://standardschema.dev) works as well, including a copy of Zod your project already has.

## Requirements

- **Node.js 22** (22.12.0 or later) or **Node.js 24** (24.14.1 or later). See [Supported platforms](project/support.md).
- **ES modules.** Mayura is published as ES modules only: use `"type": "module"` in `package.json`, `.mjs`/`.mts`
  files, or a bundler.
- **TypeScript** is optional but recommended. Mayura's types are tested with TypeScript 7 and these settings:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true
  }
}
```

`NodeNext` (or `Bundler`) module resolution is needed for subpath imports such as `mayura/provider-openai`.

## One package, many entry points

`mayura` is the core: agents, tools, the runtime and shared types. Everything else is a subpath of the same package,
so there is only one version to keep up to date:

```ts
import { createRuntime, defineAgent, defineTool } from 'mayura';
import { openAIResponses } from 'mayura/provider-openai';
import { defineWorkflowLifecycle } from 'mayura/workflows/lifecycle';
import { createSqliteStore } from 'mayura/storage-sqlite';
```

Importing an entry point loads only that part. See [Entry points](reference/entry-points.md) for the full list.

## Optional packages

Parts that need a native module or a large library declare it as an optional peer dependency. Install it only if you
use that part. Mayura is tested with better-sqlite3 13.0.3, pg 8.23.0 and QuickJS 0.32.0, and accepts later versions
in the same major line (for QuickJS, the same minor), so an existing compatible install is not a conflict:

| You use | Install |
|---|---|
| `mayura/storage-sqlite` | `npm install better-sqlite3@13` |
| `mayura/storage-postgres` | `npm install pg@8` |
| `mayura/storage` (both adapters) | both of the above |
| `mayura/adapter-code-quickjs` | `npm install quickjs-emscripten-core@0.32 @jitl/quickjs-wasmfile-release-sync@0.32` |
| `mayura/client-react`, `mayura/client-react/components` | `npm install react` (React 18.3 or 19) |

Everything else, including the CLI, the HTTP server and the terminal chat, installs with `mayura` itself. The Docker
Code Mode adapter (`mayura/adapter-code-docker`) needs a Docker engine at run time, not an npm package.

## The CLI

The `mayura` command is included. Run it with `npx mayura` (or `pnpm exec mayura`), or from your `package.json`
scripts once `mayura` is a dependency:

```bash
npx mayura --version
npx mayura --help
```

See the [CLI overview](cli/overview.md).

## Pre-releases

Release candidates are published under the `next` tag:

```bash
npm install mayura@next
```

See [Versioning and stability](project/versioning.md) for what each kind of release promises.

## Documentation in your project

The package includes this documentation (`node_modules/mayura/docs/`) and `llms.txt` / `llms-full.txt` for AI
assistants, matching the exact version you installed. See [Using Mayura with AI coding agents](ai-agents.md).
