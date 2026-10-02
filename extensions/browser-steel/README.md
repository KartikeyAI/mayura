# @mayurajs/browser-steel

[Steel](https://docs.steel.dev) browsers for `mayura/browser`: hosted Chromium sessions, created over Steel's sessions
API and driven over CDP, from any runtime, with no dependency.

```bash
npm install mayura @mayurajs/browser-steel
```

```ts
import { createBrowsers } from 'mayura/browser';
import { steelBrowsers } from '@mayurajs/browser-steel';

const browsers = createBrowsers(steelBrowsers({ apiKey }), {
  maxBrowsers: 3, maxLifetimeMs: 15 * 60_000,
  origins: ['https://example.com'],
});
const browser = await browsers.open();
await browser.goto('https://example.com/');
await browser.release();
```

- Each browser is a session: created when opened, released when done. **A Steel session outlives its connection**, so
  one not released keeps running, and billing, until its timeout, which is the browser's lifetime (at least 15 s;
  Steel's plans cap it at 15 minutes, an hour or 24 hours). `inactivityTimeoutMs` ends it sooner when idle. A session
  that already ended counts as released.
- Captcha solving, ad blocking and proxies are off unless asked for. Steel has no labels for sessions, so `labels` are
  not sent.
- `liveViewUrl` is Steel's session viewer. It needs no sign-in, so anyone with the URL can see the session: by default
  it only shows (`liveView: 'view'`); `'interact'` lets them use it too, and `false` gives none.
- The key travels on the CDP WebSocket as Steel asks (`apiKey` in its query): treat the URL as a secret; Mayura never
  logs it.
- Origins are enforced inside the browser, by intercepting its requests over CDP. This has not yet been tried against
  Steel itself: should its connection not allow that, opening a browser fails rather than running unchecked.
- Options: `apiKey`, `liveView`, `solveCaptcha`, `blockAds`, `inactivityTimeoutMs`, `maxLifetimeMs` (24 hours), `fetch`,
  `baseUrl`.

See the [browser guide](https://mayurajs.com/docs/guides/browsers/). Apache-2.0.
