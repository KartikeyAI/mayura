# @mayurajs/browser-browser-use

[Browser Use Cloud](https://docs.browser-use.com/cloud/browser/quickstart) browsers for `mayura/browser`: hosted
Chromium, created over Browser Use's browsers API (v2) and driven over CDP, from any runtime, with no dependency. This
is Browser Use's browser infrastructure, not its agent: Mayura's own agent drives the browser.

```bash
npm install mayura @mayurajs/browser-browser-use
```

```ts
import { createBrowsers } from 'mayura/browser';
import { browserUseBrowsers } from '@mayurajs/browser-browser-use';

const browsers = createBrowsers(browserUseBrowsers({ apiKey }), {
  maxBrowsers: 2, maxLifetimeMs: 30 * 60_000,
  origins: ['https://example.com'],
});
const browser = await browsers.open();
await browser.goto('https://example.com/');
await browser.release();
```

- Each browser is created when opened and stopped when released. **A Browser Use browser outlives its connection**:
  only stopping ends it, so one not released runs until its lifetime, given to Browser Use as its timeout (whole
  minutes, up to 4 hours). Browser Use charges for that timeout up front and refunds what a stop leaves unused. A
  browser that already stopped counts as released.
- **No proxy and no captcha solving**, though Browser Use's own defaults are a US proxy and captcha solving on; ask for
  them with `proxyCountryCode` and `solveCaptchas`. Recording is off. Labels become metadata (at most 10).
- There is no live view unless `liveView: true`: whoever has Browser Use's live link may be able to use the browser,
  not only watch it.
- Treat the CDP URL as a secret, as Browser Use does not say what it carries: Mayura never logs it.
- Origins are enforced inside the browser, by intercepting its requests over CDP. This has not yet been tried against
  Browser Use itself: should its connection not allow that, opening a browser fails rather than running unchecked.
- Options: `apiKey`, `liveView`, `proxyCountryCode`, `solveCaptchas`, `maxLifetimeMs` (4 hours), `fetch`, `baseUrl`.

See the [browser guide](https://mayurajs.com/docs/guides/browsers/). Apache-2.0.
