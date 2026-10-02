# @mayurajs/browser-browserbase

[Browserbase](https://docs.browserbase.com) browsers for `mayura/browser`: hosted Chromium sessions, created over
Browserbase's sessions API and driven over CDP, from any runtime, with no dependency.

```bash
npm install mayura @mayurajs/browser-browserbase
```

```ts
import { createBrowsers } from 'mayura/browser';
import { browserbaseBrowsers } from '@mayurajs/browser-browserbase';

const browsers = createBrowsers(browserbaseBrowsers({ apiKey }), {
  maxBrowsers: 3, maxLifetimeMs: 30 * 60_000,
  origins: ['https://example.com'],
});
const browser = await browsers.open();
console.log(browser.liveViewUrl); // watch it in your browser
await browser.goto('https://example.com/');
await browser.release();
```

- Each browser is a session: created when opened, released (`REQUEST_RELEASE`) when done. It is not kept alive, so it
  also ends when its connection does, and Browserbase ends it at its lifetime (at least a minute, at most 6 hours; 15
  minutes on the free plan) should neither happen. A session that already ended counts as released.
- **Captcha solving, session recording and session logs are off**, though Browserbase turns them on by default; turn
  them on with `solveCaptchas` and `recordSession`. Proxies are not used. Labels become the session's `userMetadata`.
- `liveViewUrl` is Browserbase's debugger view of the session, valid for its lifetime; anyone with it can watch and
  use the browser. Turn it off with `liveView: false`.
- Origins are enforced inside the browser, by intercepting its requests over CDP. This has not yet been tried against
  Browserbase itself: should its connection not allow that, opening a browser fails rather than running unchecked.
- Treat the connect URL as a secret, as Browserbase does not say what it carries: Mayura never logs it.
- Options: `apiKey`, `projectId`, `region`, `liveView`, `solveCaptchas`, `recordSession`, `blockAds`, `maxLifetimeMs`
  (6 hours), `fetch`, `baseUrl`.

See the [browser guide](https://mayurajs.com/docs/guides/browsers/). Apache-2.0.
