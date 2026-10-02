# @mayurajs/browser-browserview

[BrowserView](https://browserview.io/docs) browsers for `mayura/browser`: hosted Chromium sessions, created over
BrowserView's sessions API and driven over CDP, with no dependency.

```bash
npm install mayura @mayurajs/browser-browserview
```

```ts
import { createBrowsers } from 'mayura/browser';
import { browserViewBrowsers } from '@mayurajs/browser-browserview';

const browsers = createBrowsers(browserViewBrowsers({ apiKey }), {
  maxBrowsers: 2, maxLifetimeMs: 15 * 60_000,
  origins: ['https://example.com'],
});
const browser = await browsers.open();
await browser.goto('https://example.com/');
await browser.release();
```

- Each browser is a session: created when opened, released when done. **It is not kept alive** (BrowserView's own
  default is to keep it), so it also ends shortly after its connection does; BrowserView ends it at its lifetime,
  given as its timeout (BrowserView's plans cap it at 15 minutes or 4 hours). Release is idempotent.
- **Stealth is off**, though BrowserView turns it on by default; turn it on with `stealth`. Proxies, captcha solving,
  downloads, recording and BrowserView's agent are off. No idle timeout unless `idleTimeoutSeconds`. Labels become
  metadata.
- BrowserView's CDP connection needs the session's token in an `x-session-token` header. Node and Bun send it; on
  Workers or Deno, give `createBrowsers` a `webSocket` that can.
- `liveViewUrl` is BrowserView's watch link by default (`liveView: 'view'`); `'interact'` gives its viewer, whose token
  lets whoever has the link use the browser; `false` gives none.
- Origins are enforced inside the browser, by intercepting its requests over CDP. This has not yet been tried against
  BrowserView itself: should its connection not allow that, opening a browser fails rather than running unchecked.
- Options: `apiKey`, `liveView`, `stealth`, `idleTimeoutSeconds`, `maxLifetimeMs` (4 hours), `fetch`, `baseUrl`.

See the [browser guide](https://mayurajs.com/docs/guides/browsers/). Apache-2.0.
