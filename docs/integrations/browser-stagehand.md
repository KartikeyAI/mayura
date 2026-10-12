---
title: "Stagehand tools"
description: "Give agents Stagehand 3's extract, observe and act on a Mayura browser with @mayurajs/browser-stagehand: setup, model, permissions, costs and limits."
package: "@mayurajs/browser-stagehand"
vendor: "Stagehand"
logo: "browserbase"
website: "https://www.stagehand.dev"
area: "browsers"
---

[Stagehand](https://www.stagehand.dev) is Browserbase's natural-language browser automation library.
`@mayurajs/browser-stagehand` turns it into tools on a [`mayura/browser`](../guides/browsers.md) browser: `extract`
(what a page says), `observe` (what can be done on it) and, when enabled, `act` (do what an instruction says). Stagehand
drives the same browser alongside Mayura over the browser's CDP endpoint (`browser.cdp`), so the browser's origins,
lifetime and limits still hold, including for pages Stagehand opens.

Stagehand 3 (`@browserbasehq/stagehand`, 3.7.3 or a later 3.x) is a peer you install yourself, loaded when a tool
first needs it. Stagehand runs on Node only, so this package does too.

## Install

```bash
npm install mayura @mayurajs/browser-stagehand @browserbasehq/stagehand@3
```

Stagehand 4 is not supported: it loads a Chrome extension that hosted browsers cannot take.

## Credentials

Stagehand calls its own model, outside Mayura, so it needs a key for that model's provider, such as a Google AI Studio
key for `google/...` models. Pass it in `model`; the package reads nothing from the environment and Stagehand reads no
keys from it here. Suggested variables: `STAGEHAND_MODEL` for the model name, and the provider's own key variable, such
as `GEMINI_API_KEY`.

## Use it

```ts
import { createRuntime, defineAgent, z } from 'mayura';
import { browserPerRun, createBrowsers } from 'mayura/browser';
import { localBrowsers } from 'mayura/browser/local';
import { stagehandTools } from '@mayurajs/browser-stagehand';

const browsers = createBrowsers(localBrowsers(), {
  maxBrowsers: 2,
  maxLifetimeMs: 30 * 60_000,
  origins: ['https://shop.example.com'],
});
const perRun = browserPerRun(browsers);

const tools = stagehandTools(perRun.source, {
  model: { modelName: 'google/gemini-3.5-flash', apiKey: process.env.GEMINI_API_KEY ?? '' },
  act: true,
  costMicros: { extract: 5_000, observe: 5_000, act: 10_000 },
});

const shopper = defineAgent({
  id: 'shop.assistant',
  version: '1',
  instructions: 'The browser is open on https://shop.example.com. Use the stagehand tools to answer.',
  input: z.object({ question: z.string() }),
  output: z.object({ answer: z.string() }),
  tools,
  model,
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: {
    allow: [
      'model:openai.responses',
      'tool:stagehand.extract', 'tool:stagehand.observe', 'effect:read', 'stagehand:stagehand:read',
      'tool:stagehand.act', 'effect:write', 'stagehand:stagehand:act',
    ],
  },
  limits: { maxCostMicros: 200_000 },
});
// Release each run's browser when it ends, with perRun.release(runId) in an onFinally hook (see the browser guide).
```

`source` may be one browser, or a function giving the run's browser, such as `browserPerRun(...).source`. The browser
can come from any provider whose browsers Stagehand can join (see [Which browsers](#which-browsers)).

| Tool | What it does | Permission | Option |
| --- | --- | --- | --- |
| `<name>.extract` | What the page says about something, by an instruction such as "the price of the first product", as text. | `stagehand:<name>:read` | always |
| `<name>.observe` | The elements and actions matching an instruction, such as "the search box" (at most 50). | `stagehand:<name>:read` | always |
| `<name>.act` | Does what an instruction says, such as "click the sign in button"; returns `success`, a message and the action taken. | `stagehand:<name>:act` | `act: true` |

`extract` and `observe` read (`effect:read`); `act` writes (`effect:write`). Each takes `{ instruction }`, at most 2,000
characters.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `model` | required | Stagehand's model: `'provider/model'`, or `{ modelName, apiKey, baseURL }`. |
| `name` | `stagehand` | Names the tools and their permissions: lowercase letters, digits, `_` and `-`, starting with a letter. |
| `act` | `false` | Add `<name>.act`. |
| `timeoutMs` | 120 s | The longest one Stagehand call may take: 1 s to 10 minutes. The tool's own timeout is 30 s longer. |
| `maxResultBytes` | 64 KiB | The most bytes of an extraction returned to the model: 1 KiB to 4 MiB. Longer ones are cut and marked `truncated: true`. |
| `costMicros` | `0` each | What each call costs at most, by tool (`extract`, `observe`, `act`), charged to the run's budget. |
| `stagehand` | loaded when needed | Stagehand's class, for a Stagehand you import yourself, or a fake in tests. |

## How Stagehand runs

- One Stagehand per browser, attached when a tool first needs it, connected to `browser.cdp`, and pointed at the
  browser's active tab.
- It is kept alive (`keepAlive: true`): closing it disconnects and leaves the browser to Mayura, which ends it at its
  lifetime or release. A Stagehand that failed to start is made again on the next call.
- Stagehand's logging is off.

## Costs

Stagehand spends model tokens on every call, on your model provider's account, outside Mayura's model adapters. Mayura
cannot see that usage, so give `costMicros` an upper bound per tool: each call is then charged to the run's budget, and
a run without budget left for it is stopped before the call.

## Which browsers

Stagehand needs to reach this very browser, alone, with a CDP connection that needs no headers. It works with
browsers from `mayura/browser/local`, [Browserbase](browser-browserbase.md), [Steel](browser-steel.md),
[Hyperbrowser](browser-hyperbrowser.md), [Kernel](browser-kernel.md), [Browser Use](browser-browser-use.md),
[Anchor](browser-anchor.md) and [Firecrawl](browser-firecrawl.md). It does not work with:

- [BrowserView](browser-browserview.md) or [Cloudflare Browser Run](browser-cloudflare.md), whose CDP connections need
  headers;
- [Browserless](browser-browserless.md), whose every connection starts a browser of its own;
- a browser shared through `cdpBrowsers`, where Stagehand could act on others' pages.

## Errors

A failure fails the tool call:

| Code | When |
| --- | --- |
| `INVALID_CONFIG` | Stagehand 3 is not installed; or the browser has no CDP endpoint to join, is shared (`cdpBrowsers`), or needs headers on its CDP connection. |
| `INVALID_INPUT` | The browser has ended. |
| `PERMISSION_DENIED` | The run lacks the tool's grants; the run is blocked before Stagehand is called. |

An `act` Stagehand could not do is not an error: it comes back as `{ success: false, message }`, so the model can try
something else. Configuration mistakes, such as a model without a provider prefix or a timeout under a second, fail with
`INVALID_CONFIG` when you call `stagehandTools()`.

## How it is tested

- Unit tests run the tools against a fake Stagehand that records how it is made and called: one per browser, kept
  alive, with the model given, on the active tab; results bounded; failed actions reported; refused browsers (no
  endpoint, shared, headers, ended); a Stagehand made again after failing to start; a browser per run; and a call
  blocked without its permission.
- `scripts/live/browser-stagehand.mjs` runs the real Stagehand 3 with a real model on a Mayura browser (the local
  Chrome) against the conformance fixture pages: extract, observe and act passed on October 12, 2026, with
  `google/gemini-3.5-flash-lite` and `google/gemini-3.5-flash`.

## Related

- [Browsers](../guides/browsers.md): limits, origins, per-run browsers and the built-in browser tools.
- [agent-browser tools](browser-agent-browser.md): Vercel Labs' agent-browser commands on a Mayura browser.
- [Browserbase browsers](browser-browserbase.md): hosted browsers Stagehand can drive.
- [Costs and budgets](../concepts/costs-and-budgets.md): how `costMicros` reaches the run's budget.
