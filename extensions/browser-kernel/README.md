# @mayurajs/browser-kernel

[Kernel](https://www.kernel.sh/docs) browsers for `mayura/browser`: hosted Chromium, created over Kernel's browsers
API and driven over CDP, from any runtime, with no dependency.

```bash
npm install mayura @mayurajs/browser-kernel
```

```ts
import { createBrowsers } from 'mayura/browser';
import { kernelBrowsers } from '@mayurajs/browser-kernel';

const browsers = createBrowsers(kernelBrowsers({ apiKey }), {
  maxBrowsers: 2, maxLifetimeMs: 30 * 60_000,
  origins: ['https://example.com'],
});
const browser = await browsers.open();
await browser.goto('https://example.com/');
await browser.release();
```

- Each browser is created when opened and deleted when released. Kernel keeps a browser running for as long as it is
  connected, so its lifetime is kept by `createBrowsers`, which releases it then. Once nothing is connected (this
  process stopped, say), Kernel deletes it after `standbyTimeoutSeconds`: 60 by default.
- **Stealth is off**, since in Kernel it also turns on a captcha solver; turn it on with `stealth`. No proxy is used.
  Labels become the browser's tags.
- `liveViewUrl` is Kernel's live view, a link with a token in it: by default it only shows the browser
  (`liveView: 'view'`); `'interact'` lets whoever has the link use it too; `false` gives none and runs the browser
  headless.
- Treat the CDP URL as a secret, as Kernel does not say what it carries: Mayura never logs it.
- Origins are enforced inside the browser, by intercepting its requests over CDP. This has not yet been tried against
  Kernel itself: should its connection not allow that, opening a browser fails rather than running unchecked.
- Options: `apiKey`, `liveView`, `stealth`, `region` (`us-east`, `eu-west`, `ap-southeast`), `standbyTimeoutSeconds`,
  `maxLifetimeMs` (24 hours), `fetch`, `baseUrl`.

See the [browser guide](https://mayurajs.com/docs/guides/browsers/). Apache-2.0.
