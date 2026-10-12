---
title: "Browser Use Cloud browsers"
description: "Drive Browser Use Cloud's hosted Chromium from your own agents with @mayurajs/browser-browser-use: setup, timeouts, proxies, live view and errors."
package: "@mayurajs/browser-browser-use"
vendor: "Browser Use"
logo: "browser-use"
website: "https://browser-use.com"
area: "browsers"
---

[Browser Use Cloud](https://browser-use.com) hosts Chromium browsers you drive over the Chrome DevTools Protocol.
`@mayurajs/browser-browser-use` plugs those browsers into [`mayura/browser`](../guides/browsers.md), so agents get them
through the same `createBrowsers` limits, origins and tools as the Chrome installed on your machine. This is Browser
Use's browser infrastructure, not its agent: your Mayura agent drives the browser. The package creates and stops
browsers over Browser Use's browsers API (v2) with `fetch` and drives them over CDP: no Browser Use SDK, no other
dependencies, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/browser-browser-use
```

## Credentials

Create an API key in [Browser Use Cloud](https://cloud.browser-use.com) under **API Keys**. The package sends it as the
`x-browser-use-api-key` header. It reads nothing from the environment: pass the key in yourself, for example from
`BROWSER_USE_API_KEY`.

## Use it

```ts
import { browserPerRun, browserTools, createBrowsers } from 'mayura/browser';
import { browserUseBrowsers } from '@mayurajs/browser-browser-use';

const browsers = createBrowsers(browserUseBrowsers({ apiKey: process.env.BROWSER_USE_API_KEY ?? '' }), {
  maxBrowsers: 2,
  maxLifetimeMs: 30 * 60_000,
  origins: ['https://example.com', 'https://*.example.com'],
});

const browser = await browsers.open({ lifetimeMs: 10 * 60_000, labels: { team: 'research' } });
try {
  await browser.goto('https://example.com/');
  console.log((await browser.snapshot()).text);
} finally {
  await browser.release(); // a Browser Use browser outlives its connection: always release it
}

// Or give each run a browser as tools. A run grants tool:web.<tool> for each tool it calls, effect:read and
// browser:web:read; actions such as web.click also need effect:write and browser:web:act.
const perRun = browserPerRun(browsers);
const tools = browserTools(perRun.source, { name: 'web', act: true });
```

`createBrowsers` enforces your limits (how many browsers, how long each lives, which origins pages may load from)
before Browser Use is called. See [Browsers](../guides/browsers.md) for per-run browsers, every method and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your Browser Use Cloud API key. |
| `liveView` | `false` | Give each browser Browser Use's live link as `liveViewUrl`. |
| `proxyCountryCode` | none | Route browsing through Browser Use's proxy in this country, as a two-letter lowercase code such as `us`. Browser Use's own default is `us`. |
| `solveCaptchas` | `false` | Let Browser Use solve captchas. Browser Use's own default is on. |
| `maxLifetimeMs` | 4 hours | The longest lifetime: 1 minute to 4 hours. |
| `baseUrl` | `https://api.browser-use.com` | Browser Use's API. Must be https (or `localhost`/`127.0.0.1`). |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Browsers

- Each browser is created when you open it and stopped when you release it. Its screen is your viewport, at least
  320 × 320.
- **A Browser Use browser outlives its connection**: only stopping ends it. The browser's lifetime becomes its timeout
  in whole minutes (rounded up, at most 240), so Browser Use stops one you did not release then.
- Browser Use charges for that timeout up front and refunds what a stop leaves unused.
- `release()` stops the browser. If that is refused, the package asks for its status: one that is gone or `stopped`
  counts as released.
- **No proxy and no captcha solving**, though Browser Use's own defaults are a US proxy and captcha solving on. Recording
  is off.
- `labels` become the browser's metadata, at most 10; more fail the open with `INVALID_INPUT`.

## Live view and CDP

There is no live view unless you pass `liveView: true`, because whoever has Browser Use's live link may be able to use
the browser, not only watch it. Treat the link as a secret.

The CDP endpoint is Browser Use's CDP URL: a `wss://` WebSocket, or an `https://` address the package asks for its
WebSocket URL (plain `ws://` and `http://` only on this machine). If that lookup fails, the browser is stopped and the
open fails. Treat the URL as a secret: Browser Use does not say what it carries, and Mayura never logs it. Each browser
is yours alone, so `browser.cdp` is there for another client, such as [Stagehand](browser-stagehand.md), to drive it
alongside.

## Origins

Origins are enforced inside the browser: Mayura intercepts every request the browser makes over CDP and blocks those to
origins you did not allow, as the [guide](../guides/browsers.md#origins) describes. Should a connection not allow that
interception, opening the browser fails rather than running unchecked.

## Errors

Failures reach you as a `BrowserError` with a `reason`, mapped from Browser Use's HTTP status. Nothing Browser Use wrote
reaches the message.

| `reason` | When |
| --- | --- |
| `authentication` | The key is wrong or lacks permission (401, 403). |
| `quota` | Your plan or balance refused the browser (402). |
| `rate_limited` | Browser Use's rate or concurrency limits refused the call (429). |
| `gone` | The browser no longer exists (404, 410). |
| `timeout` | Browser Use gave up on a call (408, 504). |
| `unavailable` | Browser Use failed or could not be reached (5xx), or the CDP address did not lead to a WebSocket. |
| `rejected` | Browser Use refused the request for another reason. |
| `invalid_response` | A reply was missing its browser id or CDP URL, the id was malformed, or the URL was not secure. |

Configuration mistakes, such as a three-letter country code or a lifetime over 4 hours, fail with `INVALID_CONFIG` when
you call `browserUseBrowsers()`, before anything is sent.

## How it is tested

- Unit tests run the package against a fake Browser Use browsers API that checks every request: the body with no proxy,
  captchas and recording off, timeouts in whole minutes, the minimum screen, labels as metadata, the stop, the live
  view only when asked, and failures mapped without Browser Use's text.
- The [browser conformance suite](../guides/browsers.md#writing-a-provider) runs against browsers served by the Chrome
  or Edge installed on the test machine behind that fake API.
- `scripts/live/browser-browser-use.mjs` runs the suite's public-page checks on a real Browser Use browser (live view,
  opening and snapshotting a page, origins enforced, following a link and a screenshot): all passed on October 6, 2026.

## Related

- [Browsers](../guides/browsers.md): limits, origins, per-run browsers and tools.
- [Steel browsers](browser-steel.md): another hosted browser that outlives its connection.
- [Live browser viewer](browser-viewer.md): a view-only live view for any browser.
