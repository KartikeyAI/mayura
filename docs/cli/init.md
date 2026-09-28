---
title: "Create a project"
description: "Create a Mayura project from a starter or a template with mayura init, interactively or with flags, then validate and inspect it."
---

`mayura init` creates a new project. You choose between two kinds of starting point:

- A **starter** is a complete application you can run, test and ship: configuration read from the environment,
  tests and CI. Four are servers, with a worker, a Dockerfile and a compose file; `cli-agent` is a command-line
  assistant. Start here for a real project.
- A **template** is one small file that shows one feature, with a `package.json` and `tsconfig.json` around it. Start
  here to learn a single idea.

Both run offline out of the box: no API key and no network.

```bash
npx mayura init
```

## The interactive wizard

Run `mayura init` with no options in a terminal and it asks, in order:

1. **Start from**: a starter or a template.
2. **Which one**, with a one-line summary of each.
3. **Which model provider** (starters only). Templates use scripted test models and need no provider.
4. **Where should it go?** The default is `./<name>`.

It then shows the plan: how many files it will create, and any existing files it would replace. Replacing files
needs an explicit yes, and the answer defaults to no. After it writes the files it prints the next steps:

```text
cd refunds
npm install
npm run dev
```

For a template the next steps are `npm install`, `npm run build` and `npm start`. Press Ctrl+C at any question to
cancel; nothing is written, and the command exits with code 1.

The wizard needs a terminal on both input and output. With `--json`, or when input or output is piped, use the flags
below instead.

### Choosing a model provider

For a starter, the wizard offers:

| Choice | What it asks for |
|---|---|
| Offline (the default) | Nothing. The starter uses rule-based stand-in models. |
| OpenAI, Anthropic | Model (Anthropic defaults to `claude-sonnet-5`) and API key |
| Groq, Google Gemini, Mistral, DeepSeek, xAI, OpenRouter, Together, Fireworks | Model and API key. These use the provider's OpenAI-compatible chat-completions endpoint. DeepSeek is set up with its beta endpoint, JSON mode and strict tool calls (`MAYURA_MODEL_OUTPUT=json_object`, `MAYURA_MODEL_STRICT_TOOLS=true`), and its model defaults to `deepseek-flash`. |
| Cloudflare AI Gateway | Account ID, gateway name, the gateway token (for an authenticated gateway, saved as `MAYURA_MODEL_GATEWAY_TOKEN`), a `provider/model` name such as `deepseek/deepseek-flash`, and the provider's key (optional when the gateway stores it). A `deepseek/` model gets DeepSeek's settings, and an `openai/` model sends its output limit as `max_completion_tokens` (`MAYURA_MODEL_TOKEN_LIMIT_FIELD`). |
| Azure OpenAI | Resource name, deployment name, API version, model and API key |
| Another OpenAI-compatible provider | An HTTPS URL ending in `/chat/completions`, a short id for the provider, model and API key |

For every real provider it also asks for your prices (dollars per million input and output tokens, from the
provider's pricing page) and two spending caps: the most one model call may cost (default $0.05) and the most one
agent run may cost (default $0.50). Mayura needs these because it accounts for every call's cost before making it;
see [Costs and budgets](../concepts/costs-and-budgets.md).

The API key is typed masked. The wizard writes these settings to a `.env` file in the new project, readable only by
you, and never prints the key or puts it in the plan:

```text
MAYURA_MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=<your key>
MAYURA_MODEL=claude-sonnet-5
MAYURA_MODEL_INPUT_MICROS_PER_MILLION_TOKENS=3000000
MAYURA_MODEL_OUTPUT_MICROS_PER_MILLION_TOKENS=15000000
MAYURA_MODEL_MAX_CALL_COST_MICROS=50000
MAYURA_MAX_RUN_COST_MICROS=500000
```

OpenAI uses `OPENAI_API_KEY`. Compatible providers use `MAYURA_MODEL_API_KEY` plus `MAYURA_MODEL_PROVIDER_ID`,
`MAYURA_MODEL_ENDPOINT` and `MAYURA_MODEL_AUTH`. The starters' `.gitignore` excludes `.env`, and `mayura dev` loads it.
If the directory already has a `.env`, the wizard leaves it untouched and tells you to add the settings yourself (each
starter's `.env.example` lists them). You can switch providers later by editing `.env`.

## Non-interactive: plan, then apply

With flags, `init` is plan-first. Without `--apply` it writes nothing and prints what it would do:

```bash
mayura init --starter approval-workflow --directory ./refunds
mayura init --starter approval-workflow --directory ./refunds --apply
```

| Option | Meaning |
|---|---|
| `--starter <name>` or `--template <name>` | What to create. Give exactly one. |
| `--directory <dir>` | Where to create it. Required. A relative path is resolved from the current directory. |
| `--apply` | Write the files. |
| `--confirm <digest>` | Allow replacing existing files. Only with `--apply`. |

The plan lists every file with its operation (`create`, `replace` or `unchanged`) and a SHA-256 digest of its
content. For a file it would replace, the JSON plan also includes a short text diff. The whole plan has one `digest`.

If the plan replaces any existing file, `--apply` alone is refused. Review the replacements, then run the command again
with the digest the plan printed:

```bash
mayura init --template basic-agent --directory ./my-agent --apply --confirm <plan digest>
```

The digest covers the target directory and the exact before and after content of every file, so it only works for the
plan you reviewed. If any target file changes between planning and writing, nothing is written. The target directory
must not be, or pass through, a symbolic link.

The project name comes from the directory's last segment, lower-cased (for example `./Refunds` becomes `refunds`).
The generated `package.json` pins `mayura` to the CLI's exact version.

Every new project also gets an `AGENTS.md`, with a `CLAUDE.md` that points to it. It tells AI coding assistants to
read the documentation shipped inside the installed `mayura` package, so they follow the API of the version you
actually have.

## Starters

`mayura starters` lists them. Each one runs offline with `npm run dev` and `npm test`, and ends its README with what
it does not do. The server starters use SQLite locally and PostgreSQL when `DATABASE_URL` is set.

| Starter | What it is |
|---|---|
| `approval-workflow` | Refund approvals. An intake agent opens a durable workflow that checks policy, waits for an operator to approve the exact payment in the operator console, issues it and notifies the customer. Includes a reviewed migration of in-flight runs from workflow v1 to v2. |
| `support-agent` | Customer support chat with a React UI and streamed replies. Order tools act only for the signed-in customer, memory is kept per customer, card numbers, emails and phone numbers are redacted, and opening a return starts a durable follow-up workflow. |
| `research-team` | Multi-agent research as one durable workflow: a planner, up to four parallel researchers over a source library and a writer whose citations are checked, under one shared budget. The report is stored as a content-addressed artifact, with optional OpenTelemetry traces. |
| `event-automation` | Signed webhooks start durable workflow runs in which a triage agent acts on a ticket tracker through MCP tools under explicit permissions. Forged, stale and replayed deliveries start nothing, and assigning an urgent ticket waits for operator approval. |
| `cli-agent` | A command-line assistant: `assistant chat`, or one request such as `assistant list files in src`, about the folder you run it in. File tools stay inside that folder and never open `.env` files, you confirm every write, skills load from `skills/`, and replies stream. `npm run dev` starts the chat. |

Browse the source at
[packages/cli/starters](https://github.com/KartikeyAI/mayura/blob/main/packages/cli/starters).

## Templates

`mayura templates` lists them. Each creates `src/index.ts`, `package.json`, `tsconfig.json`, `README.md` and
`mayura.project.json`. They use scripted test models, so they run without a key.

| Template | What it shows | Extra packages |
|---|---|---|
| `typed-tool-runner` | An agent calling a typed tool | `zod` |
| `basic-agent` | The smallest agent with a structured answer | `zod` |
| `durable-approval` | A durable workflow step that waits for human approval, on SQLite | `better-sqlite3`, `zod` |
| `parallel-research` | Two child agents run in parallel and joined | `zod` |
| `native-memory` | Scoped memory with provenance, correction and deletion | `better-sqlite3` |
| `guarded-streaming-app` | An authenticated local server, guarded output and the browser client | none |
| `code-mode-workflow` | An approval-gated durable Code Mode workflow in the QuickJS sandbox | `better-sqlite3`, `quickjs-emscripten-core`, `@jitl/quickjs-wasmfile-release-sync` |
| `capability-policy` | A tool that needs an explicit permission, granted and denied | `zod` |

Browse the source at
[packages/cli/templates](https://github.com/KartikeyAI/mayura/blob/main/packages/cli/templates).

## mayura.project.json, validate and inspect

Every project has a `mayura.project.json`: a plain JSON catalog of its agents, workflows and tools. The CLI reads it
without importing any of your code.

```json
{
  "format": "mayura.project.v1",
  "name": "approval-workflow",
  "template": "approval-workflow",
  "definitions": [
    { "kind": "agent", "id": "refunds.intake", "version": "1", "source": "src/intake.ts" },
    { "kind": "workflow", "id": "refunds.approval", "version": "2", "source": "src/workflow.ts" }
  ],
  "tools": [
    { "id": "refunds.issue", "version": "1", "effects": "write", "capabilities": ["payments:refund"] }
  ]
}
```

```bash
mayura validate --file ./refunds/mayura.project.json
mayura inspect --file ./refunds/mayura.project.json
```

`validate` checks the file's shape and prints the project name. `inspect` lists its definitions and tools with their
effects and capabilities. The rules are strict: exactly these keys, a lower-case `name`, `template` set to a known
starter or template name, `source` paths under `src/` ending in `.ts`, and no duplicate definition.

## Good to know

- The catalog is descriptive. Nothing checks it against your code, so update it when you add an agent, workflow or
  tool.
- `init` never runs `npm install` for you.

## Related

- [CLI overview](overview.md)
- [Develop with mayura dev](dev.md)
- [Model providers](../guides/model-providers.md)
- [Quickstart](../quickstart.md)
