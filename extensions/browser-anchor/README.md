# @mayurajs/browser-anchor

[Anchor Browser](https://docs.anchorbrowser.io) browsers for `mayura/browser`: hosted Chromium sessions, created over
Anchor's sessions API and driven over CDP, from any runtime, with no dependency.

```bash
npm install mayura @mayurajs/browser-anchor
```

```ts
import { createBrowsers } from 'mayura/browser';
import { anchorBrowsers } from '@mayurajs/browser-anchor';

const browsers = createBrowsers(anchorBrowsers({ apiKey }), {
  maxBrowsers: 2, maxLifetimeMs: 30 * 60_000,
  origins: ['https://example.com'],
});
const browser = await browsers.open();
await browser.goto('https://example.com/');
await browser.release();
```

- Each browser is a session: created when opened, ended when released. Anchor ends it at its lifetime, given as its
  maximum duration in whole minutes (Anchor's docs disagree on its default, so it is always given), and
  `idleTimeoutMinutes` (1 by default) after nothing is connected, such as when this process stops.
- **Recording and ad blocking are off**, though Anchor's own defaults are on; turn them on with `recording` and
  `adblock`. No proxy and no captcha solving. Labels become the session's tags, as `key=value`.
- `liveViewUrl` is Anchor's live view: by default it only shows the session (`liveView: 'view'`); `'interact'` lets
  whoever has the link use it too, and `false` gives none and runs the browser headless.
- Anchor answers ending a session it no longer has with "invalid API key or session id" (401). Since the key worked
  when the session was created, that counts as already ended.
- Anchor's CDP URL carries the API key: treat it as a secret; Mayura never logs it.
- Origins are enforced inside the browser, by intercepting its requests over CDP. This has not yet been tried against
  Anchor itself: should its connection not allow that, opening a browser fails rather than running unchecked.
- Options: `apiKey`, `liveView`, `adblock`, `recording`, `idleTimeoutMinutes`, `maxLifetimeMs` (24 hours), `fetch`,
  `baseUrl`.

See the [browser guide](https://mayurajs.com/docs/guides/browsers/). Apache-2.0.
