---
title: "Credits"
description: "The open-source projects and open standards Mayura is built on, what each one does in Mayura, and its license."
---

Mayura stands on the work of many open-source projects. This page credits the main ones: what Mayura uses each one
for, and its license. Every project keeps its own copyright and license terms; Mayura itself is licensed under
Apache-2.0. The exact versions are pinned in the repository's lockfile.

## Installed with Mayura

`npm install mayura` installs these, and nothing else.

| Project | What Mayura uses it for | License |
|---|---|---|
| [Hono](https://hono.dev) and [@hono/node-server](https://github.com/honojs/node-server) | The HTTP server behind `mayura/server-node` and `mayura serve`. | MIT |
| [Clack](https://github.com/bombshell-dev/clack) | The prompts of the `mayura init` wizard and of terminal chat. | MIT |
| [Zod](https://zod.dev) | Schemas for agent and tool inputs and outputs: the `z` that `mayura` exports. | MIT |

## Installed when you need them

Optional peer dependencies: a project installs one only when it imports the entry point that needs it. See
[Installation](../installation.md).

| Project | What Mayura uses it for | License |
|---|---|---|
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | SQLite storage in `mayura/storage-sqlite`. | MIT |
| [node-postgres](https://node-postgres.com) (`pg`) | PostgreSQL storage in `mayura/storage-postgres`. | MIT |
| [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) | The QuickJS sandbox that runs model-written code in [Code Mode](../guides/code-mode.md). | MIT |
| [React](https://react.dev) | The hooks and components of `mayura/client-react`. | MIT |

## The operator console

The [operator console](../guides/operator-console.md) is built into a static bundle that ships inside the package.

| Project | What Mayura uses it for | License |
|---|---|---|
| [React](https://react.dev) | The console's interface. | MIT |
| [Radix UI](https://www.radix-ui.com) | Accessible dialogs, menus and other primitives. | MIT |
| [Tailwind CSS](https://tailwindcss.com) | Styling. | MIT |
| [Lucide](https://lucide.dev) | Icons. | ISC |

## Building and testing Mayura

These are used to build and test Mayura. None of them ship in the package.

| Project | What Mayura uses it for | License |
|---|---|---|
| [TypeScript](https://www.typescriptlang.org) | The language Mayura is written in, and its type checking. | Apache-2.0 |
| [Vitest](https://vitest.dev) | Unit and integration tests. | MIT |
| [fast-check](https://fast-check.dev) | Property-based tests. | MIT |
| [Vite](https://vite.dev) | Builds the operator console and this website. | MIT |
| [pnpm](https://pnpm.io) | The package manager of the repository's workspace. | MIT |

## This website

| Project | What it does here | License |
|---|---|---|
| [TanStack Start](https://tanstack.com/start) and [TanStack Router](https://tanstack.com/router) | Routing, and prerendering every page to static HTML. | MIT |
| [Shiki](https://shiki.style) | Syntax highlighting of code examples. | MIT |
| [Marked](https://marked.js.org) | Turns these Markdown pages into HTML. | MIT |
| [Tailwind CSS](https://tailwindcss.com) | Styling. | MIT |
| [Geist](https://vercel.com/font) and Geist Mono, through [Fontsource](https://fontsource.org) | The typefaces, served from this site. | OFL-1.1 |
| [svgl](https://github.com/pheralb/svgl) | The logos of the products Mayura works with, on the home page. Each logo is a trademark of its owner. | MIT |

## Open standards

Mayura implements or follows these specifications, so it works with the tools around it.

| Standard | Where Mayura uses it |
|---|---|
| [Standard Schema](https://standardschema.dev) | Agents and tools accept any compliant validator, not only Zod. |
| [Model Context Protocol](https://modelcontextprotocol.io) | Calling tools on MCP servers, in [MCP tools](../guides/mcp.md). |
| [OpenTelemetry](https://opentelemetry.io) (OTLP) | Exporting logs, traces and metrics, in [Observability](../guides/observability.md). |
| [llms.txt](https://llmstxt.org) | The documentation index for AI coding assistants, in [Using Mayura with AI coding agents](../ai-agents.md). |
| [Semantic Versioning](https://semver.org) | Version numbers and what they promise, in [Versioning](versioning.md). |

Thank you to everyone who builds and maintains these projects.
