---
title: "Using Mayura with AI coding agents"
description: "Point Claude Code, Cursor, Codex and other coding assistants at documentation that matches your installed Mayura version."
---

Coding assistants write better Mayura code when they read the documentation for the version you actually have
installed, instead of guessing from memory. Mayura ships everything an assistant needs inside the package, and
`mayura init` tells assistants where to find it.

## What's in the package

After `npm install mayura`, these are in `node_modules/mayura/`:

| File | What it is |
|---|---|
| `docs/` | This documentation, as Markdown, for the installed version. Start at `docs/README.md`. |
| `llms.txt` | An index of every page with a one-line description, in the [llms.txt](https://llmstxt.org) format. |
| `llms-full.txt` | All of the documentation in one file, for assistants that prefer to load everything at once. |
| `lib/<entry point>/dist/*.d.ts` | The exact types of every entry point, with doc comments. |

Because these come from the package, they always match the code your project runs, even offline.

## Projects created by `mayura init`

Every project `mayura init` creates has an `AGENTS.md` that tells assistants:

- where the documentation is (`node_modules/mayura/docs/` and `llms-full.txt`);
- what the project is and which `npm run` scripts it has;
- the rules assistants most often get wrong: import paths, explicit permissions, cost limits in micros, strict
  schemas for real models (`.nullable()`, not `.optional()`), checking `result.status`, keeping keys out of code, and testing offline.

It also has a `CLAUDE.md` that imports `AGENTS.md`, for assistants that read that file instead. Edit both freely; they
are yours.

## Adding Mayura guidance to an existing project

If your project already has an `AGENTS.md` (or `CLAUDE.md`, `.cursorrules`, `copilot-instructions.md`), add this:

```text
## Mayura

This project uses Mayura (`mayura` on npm). Before writing Mayura code, read the documentation for the installed
version: node_modules/mayura/docs/README.md (index) or node_modules/mayura/llms-full.txt (everything in one file).

- Import from `mayura` or `mayura/<entry point>`, never `@mayura/...`.
- Grant permissions explicitly: `model:<adapter id>`, `tool:<tool id>`, `effect:<read|write|host>`, capabilities.
- Costs are in micros (1,000,000 = $1); set `limits.maxCostMicros` for runs that use paid models.
- Check `result.status` before `result.output`; `outcome_unknown` means reconcile, never retry blindly.
- Test offline with `scriptedModel` from `mayura/testing`.
```

## The CLI works well for agents

- `npx mayura --help` lists every command, and `--help` after any command explains it.
- `--json` (or any piped output) prints one JSON document per command, with a `status` field, so an agent can read
  results reliably. Errors are JSON on stderr with a `code` and a `message`.
- `mayura init` is plan-first: without `--apply` it writes nothing and prints every file it would create. It never
  replaces a file unless it is run again with `--apply --confirm` and the plan's digest, so an agent can't overwrite
  your work by accident.
- The CLI never prompts for a token. Commands that talk to a server read it from standard input (`--token-stdin`), so
  it never appears in the command line or the agent's transcript.

## Online

The same index is at the root of the repository:
[llms.txt](https://github.com/KartikeyAI/mayura/blob/main/llms.txt).

## Related

- [Quickstart](quickstart.md)
- [mayura init](cli/init.md)
- [CLI overview](cli/overview.md)
- [Entry points](reference/entry-points.md)
