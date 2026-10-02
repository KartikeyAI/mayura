# @mayurajs/browser-cloudflare

[Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/) (formerly Browser Rendering) browsers for
`mayura/browser`, reached from outside a Worker over Browser Run's session API and CDP, with no dependency.

```bash
npm install mayura @mayurajs/browser-cloudflare
```

```ts
import { createBrowsers } from 'mayura/browser';
import { cloudflareBrowsers } from '@mayurajs/browser-cloudflare';

const browsers = createBrowsers(cloudflareBrowsers({ accountId, apiToken }), {
  maxBrowsers: 3, maxLifetimeMs: 10 * 60_000,
  origins: ['https://example.com'],
});
const browser = await browsers.open();
await browser.goto('https://example.com/');
await browser.release();
```

- `apiToken` needs the **Browser Rendering - Edit** permission. It travels as `Authorization: Bearer` on the
  WebSocket: Node and Bun send it; on runtimes whose WebSocket cannot send headers, give `createBrowsers` a
  `webSocket` that can.
- Each browser is a Browser Run session: acquired when opened, driven over CDP at the session's own address, and
  closed when released. Should the release never come, such as when this process stopped, Cloudflare ends the session
  `keepAliveMs` after its last connection closes (60 s by default; 10 s to 10 minutes, as Cloudflare's pages give 10
  or 20 minutes as the most). `createBrowsers` keeps its lifetime.
- A second client over `browser.cdp` (such as Stagehand or `@mayurajs/browser-viewer`) joins the same browser, with
  the same origins enforced.
- `liveView`: each browser's `liveViewUrl` is a Browser Run live view of its page, read only by default (`'view'`);
  `'interact'` lets whoever has the link use the browser; `false` gives none. The link carries a signed token and
  lasts for the browser's lifetime, up to an hour.
- Cloudflare's limits apply: on its free plan, 10 browser-minutes a day, 3 browsers at once, and a new browser every
  20 seconds.
- Inside a Worker, Cloudflare's Browser binding is the way to a browser; this package is for everywhere else. For
  Browser Run's REST actions (markdown, screenshots, crawls), see `@mayurajs/cloudflare-quick-action`.
- Origins are enforced inside the browser, by intercepting its requests over CDP. This has not yet been tried against
  Browser Run itself: should its connection not allow that, opening a browser fails rather than running unchecked.
- Options: `accountId`, `apiToken`, `keepAliveMs`, `liveView`, `maxLifetimeMs` (1 hour), `fetch`, `baseUrl`.

See the [browser guide](https://mayurajs.com/docs/guides/browsers/). Apache-2.0.
