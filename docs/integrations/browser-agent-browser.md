---
title: "agent-browser tools"
description: "Run Vercel Labs' agent-browser commands as permission-gated tools on a Mayura browser with @mayurajs/browser-agent-browser: setup, commands and limits."
package: "@mayurajs/browser-agent-browser"
vendor: "agent-browser"
logo: "vercel"
website: "https://github.com/vercel-labs/agent-browser"
area: "browsers"
---

[agent-browser](https://github.com/vercel-labs/agent-browser) is Vercel Labs' browser command line for agents: it reads
pages as compact snapshots with `@e` refs and acts on them. `@mayurajs/browser-agent-browser` turns a short list of its
commands into tools on a [`mayura/browser`](../guides/browsers.md) browser. The command line drives the same browser
alongside Mayura over the browser's CDP endpoint (`browser.cdp`), so the browser's origins, lifetime and limits still
hold.

The package has no dependency of its own, but it starts the agent-browser command line as a child process, so it runs
on Node only. You install agent-browser yourself.

## Install

```bash
npm install mayura @mayurajs/browser-agent-browser
npm install -g agent-browser
```

The package looks for `agent-browser` on the `PATH`; give `cli` to run it from elsewhere. It needs no credentials.

## Use it

```ts
import { createRuntime, defineAgent, z } from 'mayura';
import { browserPerRun, browserTools, createBrowsers } from 'mayura/browser';
import { localBrowsers } from 'mayura/browser/local';
import { agentBrowserTools } from '@mayurajs/browser-agent-browser';

const browsers = createBrowsers(localBrowsers(), {
  maxBrowsers: 2,
  maxLifetimeMs: 30 * 60_000,
  origins: ['https://example.com'],
});
const perRun = browserPerRun(browsers);

const tools = [
  // web.goto opens pages, kept to the origins; agent-browser reads and acts on them.
  ...browserTools(perRun.source, { name: 'web' }),
  ...agentBrowserTools(perRun.source, { act: true }),
];

const assistant = defineAgent({
  id: 'site.assistant',
  version: '1',
  instructions: 'Open pages with web.goto. Read them with agent.read (snapshot -i) and act on @refs with agent.act.',
  input: z.object({ task: z.string() }),
  output: z.object({ result: z.string() }),
  tools,
  model,
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: {
    allow: [
      'model:openai.responses',
      'tool:web.goto', 'browser:web:read',
      'tool:agent.read', 'agent-browser:agent:read', 'effect:read',
      'tool:agent.act', 'agent-browser:agent:act', 'effect:write',
    ],
  },
});
// Release each run's browser when it ends, with perRun.release(runId) in an onFinally hook (see the browser guide).
```

`source` may be one browser, or a function giving the run's browser, such as `browserPerRun(...).source`.

## Tools and commands

Each tool takes `{ command, args }`, with at most 10 arguments.

| Tool | Commands | Permission | Option |
| --- | --- | --- | --- |
| `<name>.read` | `snapshot` (flags `-i` interactive only, `-c` compact, `-d <depth>`, `-s <selector>`), `get text\|html\|value\|attr\|title\|url\|count\|box`, `is visible\|enabled\|checked` | `agent-browser:<name>:read` | always |
| `<name>.act` | `click`, `dblclick`, `fill`, `type`, `press`, `hover`, `focus`, `check`, `uncheck`, `select`, `scroll`, `scrollintoview`, `wait` | `agent-browser:<name>:act` | `act: true` |
| `<name>.eval` | `eval` | `agent-browser:<name>:evaluate` | `evaluate: true` |

`<name>.read` reads (`effect:read`); `<name>.act` and `<name>.eval` write (`effect:write`).

- **Only these commands run, with only the flags listed.** No other argument may start with `-`. Nothing that writes
  files, reaches credentials, cookies or the network setup, or starts other servers is available.
- **Navigation stays with the browser.** Open pages with the browser's own `goto`, or the `browserTools` `goto`
  tool, which keep to the origins. agent-browser's `read <url>` fetches from your machine directly, outside the
  browser, and its `open` did not complete over CDP in testing (agent-browser 0.38.2 on Windows), so neither is offered.
- Whatever a command does in the page, the page's requests are still checked against the browser's origins.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | `agent` | Names the tools and their permissions: lowercase letters, digits, `_` and `-`, starting with a letter. |
| `cli` | `['agent-browser']` | The agent-browser command line, as program and arguments, such as `['node', '/path/to/agent-browser.js']`. |
| `act` | `false` | Add `<name>.act`. |
| `evaluate` | `false` | Add `<name>.eval`, which runs JavaScript in the page. |
| `timeoutMs` | 60 s | The longest one command may take: 1 s to 10 minutes. The tool's own timeout is 15 s longer. |
| `maxResultBytes` | 64 KiB | The most bytes of a result returned to the model: 1 KiB to 4 MiB. |

## How commands run

- The command line runs without a shell, as `agent-browser --cdp <browser.cdp.url> --session <id> --json <command>`.
- Each browser gets an agent-browser session of its own (`mayura-<uuid>`), so refs from a snapshot hold for the next
  command. Once the browser has ended, the next call closes its session.
- A timeout or cancellation stops the command.
- Results are agent-browser's own JSON, as `{ ok: true, ... }`, without its bookkeeping (`lifecycle`). What agent-browser
  could not do comes back as `{ ok: false, error }`, so the model can try something else.
- A result over `maxResultBytes` is cut: a snapshot is shortened and marked `truncated: true`; anything else comes back
  as `{ ok: false, error }` saying it was too large.

## Which browsers

agent-browser needs to reach this very browser, alone, with a CDP connection that needs no headers. It works with
browsers from `mayura/browser/local` and hosted browsers that are yours alone, such as
[Browserbase](browser-browserbase.md) or [Kernel](browser-kernel.md). It does not work with
[BrowserView](browser-browserview.md) or [Cloudflare Browser Run](browser-cloudflare.md) (headers),
[Browserless](browser-browserless.md) (every connection starts a browser of its own), or a browser shared through
`cdpBrowsers`, where it could act on others' pages.

## Errors

| Code | When | Comes back as |
| --- | --- | --- |
| `INVALID_INPUT` | A command, flag or argument outside the list, the wrong number of arguments, or the browser has ended. | the tool's result, `{ error, message }` |
| `INVALID_CONFIG` | agent-browser was not found at `cli`; or the browser has no CDP endpoint to join, is shared, or needs headers. | a failed call |
| `TIMEOUT` | agent-browser did not answer within `timeoutMs`. | a failed call |
| `TOOL_FAILED` | agent-browser could not be started, or did not answer in JSON. | a failed call |
| `CANCELLED` | The run was cancelled during a command. | a failed call |
| `PERMISSION_DENIED` | The run lacks the tool's grants; the run is blocked before agent-browser runs. | a blocked run |

Configuration mistakes, such as an empty `cli` or a timeout under a second, fail with `INVALID_CONFIG` when you call
`agentBrowserTools()`.

## How it is tested

- Unit tests run the tools against a stand-in command line that records its arguments and answers in agent-browser's
  JSON: the CDP endpoint and one session per browser, commands and flags refused outside the list (without running
  anything), failures reported, results bounded, timeouts, a missing command line, refused browsers, the session closed
  once its browser ended, and a call blocked without its permission.
- An integration test runs the real agent-browser (0.38.2) on a browser launched from the Chrome installed on the test
  machine: a snapshot with refs, fill and press in the same session, `get` and `is`, a page `fetch` to another origin
  kept blocked, and no session left behind.
- It has not been run against a hosted browser yet.

## Related

- [Browsers](../guides/browsers.md): limits, origins, per-run browsers and the built-in browser tools.
- [Stagehand tools](browser-stagehand.md): natural-language extract, observe and act on a Mayura browser.
- [Permissions](../concepts/permissions.md): how `tool:`, `effect:` and capability grants combine.
