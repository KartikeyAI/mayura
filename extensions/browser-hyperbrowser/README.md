# @mayurajs/browser-hyperbrowser

[Hyperbrowser](https://hyperbrowser.ai/docs) browsers for `mayura/browser`: hosted Chromium sessions, created over
Hyperbrowser's sessions API and driven over CDP, from any runtime, with no dependency.

```bash
npm install mayura @mayurajs/browser-hyperbrowser
```

```ts
import { createBrowsers } from 'mayura/browser';
import { hyperbrowserBrowsers } from '@mayurajs/browser-hyperbrowser';

const browsers = createBrowsers(hyperbrowserBrowsers({ apiKey }), {
  maxBrowsers: 1, maxLifetimeMs: 30 * 60_000,
  origins: ['https://example.com'],
});
const browser = await browsers.open();
await browser.goto('https://example.com/');
await browser.release();
```

- Each browser is a session: created when opened, stopped when done. It is not kept alive, so it also stops when its
  connection does, and Hyperbrowser stops it at its lifetime (whole minutes, 1 to 720) should neither happen. A session
  that already ended counts as released; one Hyperbrowser failed to close (`close-error`) does not.
- Proxies, stealth, captcha solving, ad blocking, recording and saved downloads are off unless asked for. Hyperbrowser
  has no labels for sessions, so `labels` are not sent.
- `liveViewUrl` is Hyperbrowser's live view, with a token in it: by default it only shows the session
  (`liveView: 'view'`); `'interact'` lets whoever has the link use it too, and `false` gives none.
- Treat the WebSocket URL as a secret, as Hyperbrowser does not say what it carries: Mayura never logs it.
- Origins are enforced inside the browser, by intercepting its requests over CDP. This has not yet been tried against
  Hyperbrowser itself: should its connection not allow that, opening a browser fails rather than running unchecked.
- Options: `apiKey`, `liveView`, `solveCaptchas`, `adblock`, `region`, `maxLifetimeMs` (12 hours), `fetch`, `baseUrl`.

See the [browser guide](https://mayurajs.com/docs/guides/browsers/). Apache-2.0.
