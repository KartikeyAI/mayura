---
title: "Firecrawl browsers and web tools"
description: "Use Firecrawl from agents with @mayurajs/browser-firecrawl: Interact sessions as browsers, and scrape, map, search, crawl and extract as tools."
package: "@mayurajs/browser-firecrawl"
vendor: "Firecrawl"
logo: "firecrawl"
website: "https://www.firecrawl.dev"
area: "browsers"
---

[Firecrawl](https://www.firecrawl.dev) turns web pages into data for models, and hosts browsers you can drive.
`@mayurajs/browser-firecrawl` brings both to Mayura:

- `firecrawlBrowsers`: browsers for [`mayura/browser`](../guides/browsers.md), as Firecrawl Interact sessions driven
  over CDP, with the same `createBrowsers` limits, origins and tools as the Chrome installed on your machine.
- `firecrawlTools`: Firecrawl's web data as permission-gated tools, kept to the origins you allow: scrape a page, map
  a site and, when enabled, search the web, crawl a site or extract structured data. See
  [Web data without a browser](../guides/browsers.md#web-data-without-a-browser).

Both talk to Firecrawl's v2 API with `fetch`: no Firecrawl SDK, no other dependencies, and they run on every runtime
Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/browser-firecrawl
```

## Credentials

Create an API key (it starts with `fc-`) in the [Firecrawl dashboard](https://www.firecrawl.dev/app/api-keys) under
**API Keys**. The package sends it as a bearer token. It reads nothing from the environment: pass the key in yourself,
for example from `FIRECRAWL_API_KEY`.

## Use the tools

```ts
import { createRuntime, defineAgent, z } from 'mayura';
import { firecrawlTools } from '@mayurajs/browser-firecrawl';

const web = firecrawlTools({
  apiKey: process.env.FIRECRAWL_API_KEY ?? '',
  origins: ['https://docs.example.com'],
  crawl: true,
  maxCrawlPages: 20,
  costMicros: { scrape: 1_000, map: 1_000, crawl: 20_000 },
});

const researcher = defineAgent({
  id: 'docs.researcher',
  version: '1',
  instructions: 'Answer from the documentation at https://docs.example.com. Use web.map to find pages and web.scrape to read them.',
  input: z.object({ question: z.string() }),
  output: z.object({ answer: z.string() }),
  tools: web,
  model,
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: {
    allow: ['model:openai.responses', 'tool:web.scrape', 'tool:web.map', 'tool:web.crawl', 'effect:read', 'web:web:read', 'web:web:crawl'],
  },
  limits: { maxCostMicros: 200_000 },
});
const outcome = await runtime.submit(researcher, { input: { question: 'How do I rotate keys?' } }).result();
```

Every tool reads (`effects: 'read'`), so a call needs `tool:<name>.<tool>`, `effect:read` and the tool's permission:

| Tool | Permission | Option |
| --- | --- | --- |
| `<name>.scrape`: a page as markdown (the default), html, its links or a summary | `web:<name>:read` | always |
| `<name>.map`: a site's pages (up to 500, 100 by default), optionally matching a search | `web:<name>:read` | always |
| `<name>.search`: web search results (titles, URLs, descriptions; up to 10, 5 by default) | `web:<name>:search` | `search: true` |
| `<name>.crawl`: up to `maxCrawlPages` pages of a site, as markdown, optionally only paths matching a regular expression | `web:<name>:crawl` | `crawl: true` |
| `<name>.extract`: structured data from one page, by prompt and an optional JSON Schema | `web:<name>:extract` | `extract: true` |

### Tool options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your Firecrawl API key. |
| `origins` | required | The sites the tools may read, as `createBrowsers` takes them, or `'all'`. |
| `name` | `web` | Names the tools and their permissions: lowercase letters, digits, `_` and `-`, starting with a letter. |
| `search` | `false` | Add `<name>.search`. |
| `crawl` | `false` | Add `<name>.crawl`. |
| `extract` | `false` | Add `<name>.extract`. |
| `maxPageBytes` | 64 KiB | The most bytes of a page's content (or extracted data) returned to the model: 1 KiB to 4 MiB. |
| `maxCrawlPages` | `10` | The most pages one crawl reads: 1 to 100. |
| `crawlTimeoutMs` | 5 minutes | The longest one crawl runs before it is cancelled: 10 s to 1 hour. |
| `costMicros` | `0` each | What each call costs at most, by tool (`scrape`, `map`, `search`, `crawl`, `extract`), charged to the run's budget. |
| `baseUrl` | `https://api.firecrawl.dev` | Firecrawl's API. Must be https (or `localhost`/`127.0.0.1`). |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

### What the tools do

- **Origins.** Every URL a tool reads must be within `origins`; one outside them comes back as the tool's result,
  `{ error: 'PERMISSION_DENIED', message }`, so the model can choose another. Search results are not bound by
  `origins`, but reading them is. A crawl stays on its site (no external links, no subdomains), and pages a redirect
  took elsewhere are left out.
- **Off-machine.** Firecrawl fetches the pages from its own servers, with TLS checked (Firecrawl's own default skips
  it), main content only. Page content is the tools' result for the model to read: treat it as untrusted text.
- **Limits.** Content is cut at `maxPageBytes` and marked `truncated: true`. Extracted data larger than that comes back
  as a `LIMIT_EXCEEDED` result.
- **Crawls.** A crawl polls Firecrawl every 2 seconds until it completes. One cancelled with the run, or running past
  `crawlTimeoutMs`, is cancelled at Firecrawl too, so it stops spending.
- **Extraction** uses Firecrawl's JSON format on one page, with Firecrawl's model.
- **Costs.** `costMicros` charges each call to the run's budget; Firecrawl bills credits on its side.

## Use the browsers

```ts
import { browserPerRun, browserTools, createBrowsers } from 'mayura/browser';
import { firecrawlBrowsers } from '@mayurajs/browser-firecrawl';

const browsers = createBrowsers(firecrawlBrowsers({ apiKey: process.env.FIRECRAWL_API_KEY ?? '' }), {
  maxBrowsers: 2,
  maxLifetimeMs: 10 * 60_000,
  origins: ['https://example.com', 'https://*.example.com'],
});

const browser = await browsers.open({ lifetimeMs: 5 * 60_000 });
try {
  console.log(browser.liveViewUrl); // view only: treat it as a secret
  await browser.goto('https://example.com/');
  console.log((await browser.snapshot()).text);
} finally {
  await browser.release();
}

// Or give each run a browser as tools; see the browser guide for the grants they need.
const perRun = browserPerRun(browsers);
const tools = browserTools(perRun.source, { name: 'site', act: true });
```

### Browser options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your Firecrawl API key. |
| `liveView` | `'view'` | `'view'` gives a view-only `liveViewUrl`, `'interact'` Firecrawl's interactive view, whose holder can use the browser, `false` gives none. |
| `activityTimeoutSeconds` | `300` | End a browser after this long without activity: 10 to 3,600. |
| `maxLifetimeMs` | 1 hour | The longest lifetime: 30 s to 1 hour. |
| `baseUrl` | `https://api.firecrawl.dev` | Firecrawl's API. Must be https (or `localhost`/`127.0.0.1`). |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

### Sessions

- Each browser is one Interact session, created when you open it and deleted when you release it. Firecrawl ends it at
  its lifetime (given as its `ttl` in seconds, at least 30) or after `activityTimeoutSeconds` without activity.
- `release()` deletes the session. One deleted already answers 404 (`gone`), which `createBrowsers` counts as released.
- The session is not given your viewport or labels; `createBrowsers` sets the viewport over CDP.
- The CDP endpoint must be `wss://` (plain `ws://` only on this machine). Treat it as a secret, as Firecrawl's docs
  differ on what it carries: Mayura never logs it. Each session is yours alone, so `browser.cdp` is there for another
  client, such as [Stagehand](browser-stagehand.md), to drive it alongside.
- Origins are enforced inside the browser: Mayura intercepts every request the session makes over CDP and blocks those
  to origins you did not allow, as the [guide](../guides/browsers.md#origins) describes. Should a connection not allow
  that interception, opening the browser fails rather than running unchecked.

## Errors

Browsers fail with a `BrowserError` whose `reason` is mapped from Firecrawl's HTTP status, without anything Firecrawl
wrote: `authentication` (401, 403), `quota` (402), `rate_limited` (429), `gone` (404, 410), `timeout` (408, 504),
`unavailable` (5xx), `rejected` (other refusals), and `invalid_response` when a reply lacks a session id or a secure
CDP URL.

Tool calls fail the call, again without Firecrawl's text, except for mistakes the model can put right:

| Code | When | Comes back as |
| --- | --- | --- |
| `PERMISSION_DENIED` | A URL is outside `origins`. | the tool's result |
| `INVALID_INPUT` | A URL is not http(s). | the tool's result |
| `LIMIT_EXCEEDED` | Extracted data is larger than `maxPageBytes`. | the tool's result |
| `BUDGET_EXCEEDED` | Firecrawl answered 402: your credits ran out. | a failed call |
| `TOOL_FAILED` | Firecrawl refused the request, did not succeed, or a crawl failed or was cancelled. | a failed call |
| `TIMEOUT` | A crawl ran past `crawlTimeoutMs`; it is cancelled. | a failed call |
| `CANCELLED` | The run was cancelled during a crawl; it is cancelled. | a failed call |

Configuration mistakes, such as missing `origins`, a tool name with spaces or `maxCrawlPages` over 100, fail with
`INVALID_CONFIG` when you call `firecrawlTools()` or `firecrawlBrowsers()`, before anything is sent.

## How it is tested

- Unit tests run both against a fake Firecrawl API that checks every request: the tools' permissions and costs, TLS
  checked, truncation, origins refused as results, map and search bodies, crawls polled, kept to their site and
  cancelled when cancelled, timed out or failed, extraction bounded, a call blocked without its permission, and the
  Interact session's `ttl`, live views and delete.
- The [browser conformance suite](../guides/browsers.md#writing-a-provider) runs against sessions served by the Chrome
  or Edge installed on the test machine behind that fake API.
- `scripts/live/browser-firecrawl.mjs` runs the suite's public-page checks on a real Interact session (live view,
  opening and snapshotting a page, origins enforced, following a link and a screenshot): all passed on October 6, 2026.
  The same script also calls scrape, map and extract against Firecrawl.

## Related

- [Browsers](../guides/browsers.md): limits, origins, per-run browsers and tools.
- [Cloudflare quick actions](cloudflare-quick-action.md): Browser Run's markdown, links, scrape, screenshot, JSON and
  crawl as tools.
- [Permissions](../concepts/permissions.md): how `tool:`, `effect:` and capability grants combine.
