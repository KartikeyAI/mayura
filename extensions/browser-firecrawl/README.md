# @mayurajs/browser-firecrawl

[Firecrawl](https://docs.firecrawl.dev) for Mayura, two ways, from any runtime with no dependency:

- `firecrawlBrowsers` — browsers for `mayura/browser`, as Firecrawl Interact sessions driven over CDP.
- `firecrawlTools` — Firecrawl's web data as tools: scrape a page, map a site, and, when enabled, search the web,
  crawl a site or extract structured data.

```bash
npm install mayura @mayurajs/browser-firecrawl
```

```ts
import { firecrawlTools } from '@mayurajs/browser-firecrawl';

const tools = firecrawlTools({ apiKey, origins: ['https://docs.example.com'], crawl: true });
// Tools: web.scrape, web.map (web:web:read) and web.crawl (web:web:crawl).
```

## Tools

| Tool | Permission | Option |
| --- | --- | --- |
| `<name>.scrape`: a page as markdown (the default), html, its links or a summary | `web:<name>:read` | always |
| `<name>.map`: a site's pages, optionally matching a search | `web:<name>:read` | always |
| `<name>.search`: web search results (titles, URLs, descriptions) | `web:<name>:search` | `search: true` |
| `<name>.crawl`: up to `maxCrawlPages` pages of a site, as markdown | `web:<name>:crawl` | `crawl: true` |
| `<name>.extract`: structured data from a page, by prompt and optional JSON Schema | `web:<name>:extract` | `extract: true` |

- **`origins` is required**: the sites the tools may read, as `createBrowsers` takes them, or `'all'`. A URL outside
  them is refused, and comes back as the tool's result so the model can choose another. Search results are not bound
  by it, but reading them is. A crawl stays on its site, and pages a redirect took elsewhere are left out.
- Firecrawl fetches the pages from its own servers, with TLS checked (Firecrawl's own default skips it). Page content
  is the tools' result for the model to read: treat it as untrusted text.
- Content is cut at `maxPageBytes` (64 KiB). A crawl polls Firecrawl until done, and is cancelled when the call is,
  or after `crawlTimeoutMs` (5 minutes), so it stops spending. `costMicros` charges each tool's calls to the run's
  budget; Firecrawl bills credits on its side.
- Extraction uses Firecrawl's JSON format on one page, with its model.
- Options: `apiKey`, `name` (`web`), `origins`, `search`, `crawl`, `extract`, `maxPageBytes`, `maxCrawlPages` (10, at most
  100), `crawlTimeoutMs`, `costMicros`, `fetch`, `baseUrl`.

## Browsers

```ts
import { createBrowsers } from 'mayura/browser';
import { firecrawlBrowsers } from '@mayurajs/browser-firecrawl';

const browsers = createBrowsers(firecrawlBrowsers({ apiKey }), { maxBrowsers: 2, maxLifetimeMs: 10 * 60_000, origins: ['https://example.com'] });
```

- Each browser is an Interact session: created when opened, deleted when released. Firecrawl ends it at its lifetime
  (30 s to an hour) or after `activityTimeoutSeconds` (300) without activity.
- `liveViewUrl` is Firecrawl's live view: view-only by default; `liveView: 'interact'` gives the interactive one, which
  lets whoever has the link use the browser; `false` gives none.
- Treat the CDP URL as a secret, as Firecrawl's docs differ on what it carries: Mayura never logs it.
- Origins are enforced inside the browser, by intercepting its requests over CDP. This has not yet been tried against
  Firecrawl itself: should its connection not allow that, opening a browser fails rather than running unchecked.
- Options: `apiKey`, `liveView`, `activityTimeoutSeconds`, `maxLifetimeMs` (1 hour), `fetch`, `baseUrl`.

See the [browser guide](https://mayurajs.com/docs/guides/browsers/). Apache-2.0.
