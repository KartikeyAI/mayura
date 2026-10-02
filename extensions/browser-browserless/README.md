# @mayurajs/browser-browserless

[Browserless](https://docs.browserless.io) browsers for `mayura/browser`, hosted or self-hosted: each is a fresh
browser that Browserless launches when its CDP connection opens and ends when it closes. From any runtime, with no
dependency.

```bash
npm install mayura @mayurajs/browser-browserless
```

```ts
import { createBrowsers } from 'mayura/browser';
import { browserlessBrowsers } from '@mayurajs/browser-browserless';

const browsers = createBrowsers(browserlessBrowsers({ token }), {
  maxBrowsers: 2, maxLifetimeMs: 15 * 60_000,
  origins: ['https://example.com'],
});
const browser = await browsers.open();
await browser.goto('https://example.com/');
await browser.release();
```

- Each browser is one connection to Browserless: nothing is kept between browsers (this is not Browserless's
  persistent Session API). Releasing the browser closes the connection, which ends it; Browserless ends it at its
  lifetime, given as the connection's `timeout`, should that never happen. Browserless's plans cap a browser at 2
  minutes to an hour.
- Since every connection is a browser of its own, a browser gives no `cdp` endpoint to other clients: Stagehand and
  `@mayurajs/browser-agent-browser` cannot join it.
- Hosted regions are `production-sfo` (the default), `production-lon` and `production-ams`. For your own Browserless,
  give `endpoint`, such as `wss://browserless.internal`; plain `ws://` only on this machine.
- Ad blocking and stealth are off unless asked for; no proxy is used. There is no live view.
- The token travels in the connection's query, as Browserless takes it: treat the URL as a secret; Mayura never logs it.
- Origins are enforced inside the browser, by intercepting its requests over CDP. This has not yet been tried against
  Browserless itself: should its connection not allow that, opening a browser fails rather than running unchecked.
- Options: `token`, `region`, `endpoint`, `blockAds`, `stealth`, `maxLifetimeMs` (1 hour).

See the [browser guide](https://mayurajs.com/docs/guides/browsers/). Apache-2.0.
