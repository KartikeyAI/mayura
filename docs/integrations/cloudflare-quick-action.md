---
title: "Cloudflare quick actions"
description: "Read web pages through Cloudflare Browser Run's quick actions with @mayurajs/cloudflare-quick-action: a client, and markdown, links, scrape and crawl tools."
package: "@mayurajs/cloudflare-quick-action"
vendor: "Cloudflare"
logo: "cloudflare"
website: "https://www.cloudflare.com"
area: "browsers"
---

[Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/quick-actions/) (formerly Browser Rendering)
has quick actions: one REST call renders a page in Cloudflare's browser and gives back what you asked for, such as its
markdown, links or a screenshot. `@mayurajs/cloudflare-quick-action` brings them to Mayura two ways:

- `cloudflareQuickActions`: a client for every quick action.
- `quickActionTools`: the actions as permission-gated tools, kept to the origins you allow, both for the URLs the model
  asks for and for what the rendered page loads. See
  [Web data without a browser](../guides/browsers.md#web-data-without-a-browser).

It talks to Cloudflare's API with `fetch`: no Cloudflare SDK, no other dependencies, and it runs on every runtime
Mayura runs on. For a browser to drive, see [Cloudflare Browser Run browsers](browser-cloudflare.md).

## Install

```bash
npm install mayura @mayurajs/cloudflare-quick-action
```

## Credentials

You need your account id (32 hex characters, on the account's overview page in the
[Cloudflare dashboard](https://dash.cloudflare.com)) and an API token. Create the token under
[**My Profile > API Tokens**](https://dash.cloudflare.com/profile/api-tokens) with the **Browser Rendering - Edit**
permission; the package needs nothing else. The package reads nothing from the environment: pass both in yourself, for
example from `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_BROWSER_TOKEN`.

## Use the tools

```ts
import { createRuntime, defineAgent, z } from 'mayura';
import { cloudflareQuickActions, quickActionTools } from '@mayurajs/cloudflare-quick-action';

const actions = cloudflareQuickActions({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
  apiToken: process.env.CLOUDFLARE_BROWSER_TOKEN ?? '',
});

const web = quickActionTools(actions, {
  origins: ['https://docs.example.com'],
  screenshot: true,
  crawl: true,
  costMicros: { markdown: 1_000, links: 1_000, scrape: 1_000, screenshot: 2_000, crawl: 20_000 },
});

const researcher = defineAgent({
  id: 'docs.researcher',
  version: '1',
  instructions: 'Answer from https://docs.example.com. Use cloudflare.links to find pages and cloudflare.markdown to read them.',
  input: z.object({ question: z.string() }),
  output: z.object({ answer: z.string() }),
  tools: web,
  model,
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: {
    allow: [
      'model:openai.responses', 'effect:read', 'web:cloudflare:read', 'web:cloudflare:crawl',
      'tool:cloudflare.markdown', 'tool:cloudflare.links', 'tool:cloudflare.scrape',
      'tool:cloudflare.screenshot', 'tool:cloudflare.crawl',
    ],
  },
  limits: { maxCostMicros: 200_000 },
});
```

Every tool reads (`effects: 'read'`), so a call needs `tool:<name>.<tool>`, `effect:read` and the tool's permission:

| Tool | What it returns | Permission | Option |
| --- | --- | --- | --- |
| `<name>.markdown` | The rendered page as markdown. | `web:<name>:read` | always |
| `<name>.links` | The page's links (at most 1,000), optionally only visible ones or only on the same site. | `web:<name>:read` | always |
| `<name>.scrape` | The text and attributes of the elements matching 1 to 20 CSS selectors. | `web:<name>:read` | always |
| `<name>.screenshot` | A PNG of the visible page, or all of it, as an image the model sees. | `web:<name>:read` | `screenshot: true` |
| `<name>.json` | Structured data from the page by Cloudflare's model, by prompt and an optional JSON Schema. | `web:<name>:extract` | `json: true` |
| `<name>.crawl` | Up to `maxCrawlPages` pages of a site as markdown, optionally only URLs matching a wildcard pattern. | `web:<name>:crawl` | `crawl: true` |

### Tool options

| Option | Default | Meaning |
| --- | --- | --- |
| `origins` | required | The sites the tools may read, as `createBrowsers` takes them, or `'all'`. |
| `name` | `cloudflare` | Names the tools and their permissions: lowercase letters, digits, `_` and `-`, starting with a letter. |
| `screenshot` | `false` | Add `<name>.screenshot`. |
| `json` | `false` | Add `<name>.json`. |
| `crawl` | `false` | Add `<name>.crawl`. |
| `maxPageBytes` | 64 KiB | The most bytes of a page's content, of a scrape in all, or of extracted data, returned to the model: 1 KiB to 4 MiB. |
| `maxCrawlPages` | `10` | The most pages one crawl reads: 1 to 100. |
| `crawlTimeoutMs` | 5 minutes | The longest one crawl runs before it is cancelled: 10 s to 1 hour. |
| `costMicros` | `0` each | What each call costs at most, by tool (`markdown`, `links`, `scrape`, `screenshot`, `json`, `crawl`), charged to the run's budget. |

### What the tools do

- **Origins, twice.** Every URL a tool reads must be within `origins`; one outside them comes back as the tool's result,
  `{ error: 'PERMISSION_DENIED', message }`, so the model can choose another. The page Cloudflare renders is kept to
  them too: the tools send `allowRequestPattern` built from your origins (`originPatterns(origins)`), so the page loads
  no scripts, images or frames from elsewhere. With `origins: 'all'`, no pattern is sent.
- **Crawls** stay on their site (no subdomains, no external links), poll Cloudflare every 2 seconds until done, and keep
  only pages read and within `origins`. One cancelled with the run, or running past `crawlTimeoutMs`, is cancelled at
  Cloudflare too, so it stops spending. One Cloudflare ends without completing fails.
- **Limits.** Markdown, each crawled page and a scrape in all are cut at `maxPageBytes` and marked `truncated: true`.
  Extracted data over it, or a screenshot over 16 MiB, comes back as a `LIMIT_EXCEEDED` result.
- **Off-machine.** Cloudflare fetches and renders the pages. Page content is the tools' result for the model to read:
  treat it as untrusted text.

## Costs

`costMicros` charges each call to the run's budget. Cloudflare bills browser time on its side, and `json` uses Workers
AI, billed as such. On Cloudflare's free plan, browser time is 10 minutes a day and REST calls are rate limited (about
one every 10 seconds).

## The client

`cloudflareQuickActions({ accountId, apiToken })` gives every quick action. Each takes the page's `url` and, optionally,
`allowRequestPattern` (regular expressions; the page loads only what matches one), and an optional `{ signal }`.

| Method | Returns |
| --- | --- |
| `markdown(request)` | The page as markdown. |
| `content(request)` | The page's HTML once rendered. |
| `links(request)` | Its links; `visibleLinksOnly` and `excludeExternalLinks` narrow them. |
| `scrape({ ..., selectors })` | For each of 1 to 20 CSS selectors, the matching elements' text, HTML and attributes. |
| `screenshot({ ..., fullPage })` | A PNG, as bytes. |
| `pdf(request)` | A PDF, as bytes. |
| `json({ ..., prompt, schema })` | Structured data by Cloudflare's model; needs a prompt, a schema, or both. |
| `crawl.start(request)` | A crawl job's id. Takes `limit` (10 by default), `depth`, `formats`, `includePatterns`, `excludePatterns`; never subdomains or external links. |
| `crawl.status(id, { cursor, limit })` | Its status (`running`, `completed`, `errored`, `cancelled_due_to_timeout`, `cancelled_due_to_limits`, `cancelled_by_user`), counts and records. |
| `crawl.cancel(id)` | Cancels it. |

The client checks only that `url` is http(s): keeping to origins is the tools' job, or yours. Its options are
`accountId`, `apiToken`, `baseUrl` (`https://api.cloudflare.com`; https, or `localhost`/`127.0.0.1`) and `fetch`.

## Errors

The client fails with a `MayuraError` whose message names only the HTTP status, never what Cloudflare wrote:

| Code | When |
| --- | --- |
| `TOOL_FAILED` | Cloudflare refused the request (any HTTP error; 429 says it is rate limiting), or its answer was not valid. |
| `INVALID_INPUT` | A URL that is not http(s), selectors out of range, `json` with neither prompt nor schema, a malformed crawl id. |

In the tools, `INVALID_INPUT`, `PERMISSION_DENIED` and `LIMIT_EXCEEDED` come back as the tool's result, `{ error,
message }`, for the model to put right. Other failures fail the call: `TOOL_FAILED`, `TIMEOUT` (a crawl past
`crawlTimeoutMs`) and `CANCELLED` (the run was cancelled during a crawl).

Configuration mistakes, such as an account id that is not 32 hex characters, missing `origins` or `maxCrawlPages` over
100, fail with `INVALID_CONFIG` when you call `cloudflareQuickActions()` or `quickActionTools()`, before anything is
sent.

## How it is tested

- Unit tests run the client and tools against a fake Browser Run API that checks every request: each action's path,
  token and body, failures without Cloudflare's text, crawls kept to their site, started, polled and cancelled, the
  request patterns built from origins, the tools' permissions, pages bounded, other sites refused as results,
  screenshots as images, JSON bounded, and a call blocked without its permission.
- `scripts/live/cloudflare-quick-action.mjs` runs each action once against Cloudflare on a public page (markdown,
  content, links, scrape, screenshot, a tool call with `allowRequestPattern`, and a crawl): all 7 checks passed on
  October 6, 2026.

## Related

- [Browsers](../guides/browsers.md): browsers, origins and web data without a browser.
- [Cloudflare Browser Run browsers](browser-cloudflare.md): a Browser Run session to drive over CDP.
- [Firecrawl browsers and web tools](browser-firecrawl.md): scrape, map, search, crawl and extract as tools.
