# @mayurajs/cloudflare-quick-action

[Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/quick-actions/)'s quick actions for Mayura —
one call renders a page in Cloudflare's browser and gives back what was asked for — as a client and as tools, from
any runtime with no dependency.

```bash
npm install mayura @mayurajs/cloudflare-quick-action
```

```ts
import { cloudflareQuickActions, quickActionTools } from '@mayurajs/cloudflare-quick-action';

const actions = cloudflareQuickActions({ accountId, apiToken });
const markdown = await actions.markdown({ url: 'https://example.com/' });

const tools = quickActionTools(actions, { origins: ['https://docs.example.com'], screenshot: true });
// cloudflare.markdown, cloudflare.links, cloudflare.scrape and cloudflare.screenshot, permission web:cloudflare:read.
```

`apiToken` needs the **Browser Rendering - Edit** permission.

## The client

`cloudflareQuickActions({ accountId, apiToken })` has `markdown`, `content` (the rendered HTML), `links`, `scrape`
(elements by CSS selector), `screenshot` (PNG), `pdf`, `json` (structured data by Cloudflare's model, billed as Workers
AI), and `crawl.start`, `crawl.status` and `crawl.cancel`. Each takes the page's `url`, and optionally
`allowRequestPattern`: regular expressions, outside which the page loads nothing. A failure names only its HTTP
status, never what Cloudflare wrote.

## Tools

| Tool | Permission | Option |
| --- | --- | --- |
| `<name>.markdown`, `<name>.links`, `<name>.scrape` | `web:<name>:read` | always |
| `<name>.screenshot`: the page as an image | `web:<name>:read` | `screenshot: true` |
| `<name>.json`: structured data, by prompt and optional JSON Schema | `web:<name>:extract` | `json: true` |
| `<name>.crawl`: up to `maxCrawlPages` pages of a site, as markdown | `web:<name>:crawl` | `crawl: true` |

- **`origins` is required**: the sites the tools may read, as `createBrowsers` takes them, or `'all'`. A URL outside
  them is refused, and comes back as the tool's result so the model can choose another. The page Cloudflare renders
  is also kept to them: it loads no scripts, images or frames from elsewhere (`allowRequestPattern`).
- A crawl stays on its site, polls until done, keeps only pages read within `origins`, and is cancelled when its call
  is or after `crawlTimeoutMs` (5 minutes), so it stops spending.
- Content is cut at `maxPageBytes` (64 KiB). `costMicros` charges each tool's calls to the run's budget; Cloudflare
  bills browser time on its side (its free plan allows 10 browser-minutes a day, and REST calls slowly).
- Page content is the tools' result for the model to read: treat it as untrusted text.
- Options: `name` (`cloudflare`), `origins`, `screenshot`, `json`, `crawl`, `maxPageBytes`, `maxCrawlPages` (10, at most
  100), `crawlTimeoutMs`, `costMicros`.

For a browser to drive, see `@mayurajs/browser-cloudflare`. Apache-2.0.
