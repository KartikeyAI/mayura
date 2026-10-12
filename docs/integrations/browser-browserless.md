---
title: "Browserless browsers"
description: "Give agents fresh hosted or self-hosted Browserless browsers with @mayurajs/browser-browserless: setup, regions, options, origins and errors."
package: "@mayurajs/browser-browserless"
vendor: "Browserless"
logo: "browserless"
website: "https://www.browserless.io"
area: "browsers"
---

[Browserless](https://www.browserless.io) runs headless browsers behind a CDP WebSocket, hosted or on your own servers.
`@mayurajs/browser-browserless` plugs Browserless into [`mayura/browser`](../guides/browsers.md), so agents get
Browserless browsers through the same `createBrowsers` limits, origins and tools as the Chrome installed on your
machine. There is no session API in between: each browser is one CDP connection, which Browserless answers with a fresh
browser and ends when it closes. No Browserless SDK, no other dependencies, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/browser-browserless
```

## Credentials

Browserless calls the credential an API token; find it in your [Browserless account](https://account.browserless.io).
For your own Browserless, it is the token you started it with. The package reads nothing from the environment: pass the
token in yourself, for example from `BROWSERLESS_TOKEN`.

## Use it

```ts
import { browserPerRun, browserTools, createBrowsers } from 'mayura/browser';
import { browserlessBrowsers } from '@mayurajs/browser-browserless';

const browsers = createBrowsers(
  browserlessBrowsers({ token: process.env.BROWSERLESS_TOKEN ?? '', region: 'production-lon' }),
  {
    maxBrowsers: 2,
    maxLifetimeMs: 15 * 60_000,
    origins: ['https://example.com', 'https://*.example.com'],
  },
);

const browser = await browsers.open({ lifetimeMs: 5 * 60_000 });
try {
  await browser.goto('https://example.com/');
  console.log((await browser.snapshot()).text);
} finally {
  await browser.release(); // closes the connection, which ends the browser
}

// Or give each run a browser as tools. A run grants tool:web.<tool> for each tool it calls, effect:read and
// browser:web:read; actions such as web.click also need effect:write and browser:web:act.
const perRun = browserPerRun(browsers);
const tools = browserTools(perRun.source, { name: 'web', act: true });
```

For your own Browserless, pass `endpoint` instead of `region`, such as
`browserlessBrowsers({ token, endpoint: 'wss://browserless.internal' })`. See [Browsers](../guides/browsers.md) for
per-run browsers, every method and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `token` | required | Your Browserless API token (letters, digits, `_`, `.` and `-`). |
| `region` | `production-sfo` | The hosted region: `production-sfo`, `production-lon` or `production-ams`. Not with `endpoint`. |
| `endpoint` | the region's `wss://<region>.browserless.io` | Your own Browserless, as a `wss://` URL without a query or credentials. Plain `ws://` only on this machine. |
| `blockAds` | `false` | Ask Browserless to block ads. |
| `stealth` | `false` | Browserless's stealth mode. |
| `maxLifetimeMs` | 1 hour | The longest lifetime: 1 s to 24 hours. Browserless's hosted plans allow 2 minutes to an hour; longer is for your own Browserless. |

## Browsers and connections

- Each browser is one connection to Browserless, and Browserless launches a fresh browser for it. Nothing is kept
  between browsers: this is not Browserless's persistent Session API.
- The connection carries the browser's lifetime as its `timeout`, so Browserless ends the browser then at the latest.
- `release()` closes the connection, which ends the browser. There is no API call to make.
- Ad blocking and stealth are off unless you ask; no proxy is used.
- There is no live view, and `labels` are not sent.

## CDP

The token travels in the connection's query (`?token=...&timeout=...`), as Browserless takes it. Treat the URL as a
secret: Mayura never logs it.

Because every connection starts a browser of its own, another client could not join this one: the provider marks its
endpoint `joinable: false` and a browser has no `browser.cdp`. [Stagehand](browser-stagehand.md) and
[agent-browser](browser-agent-browser.md) tools cannot run on a Browserless browser.

## Origins

Origins are enforced inside the browser: Mayura intercepts every request the browser makes over CDP and blocks those to
origins you did not allow, as the [guide](../guides/browsers.md#origins) describes. Should a connection not allow that
interception, opening the browser fails rather than running unchecked.

## Errors

The package makes no HTTP calls of its own, so failures come from the CDP connection. A connection Browserless refuses,
for a wrong token, a plan limit or an outage, fails the open with a `BrowserError` whose `reason` is `unavailable`:
browsers' WebSocket API does not say why. After the browser's lifetime, calls fail with `gone`.

Configuration mistakes fail with `INVALID_CONFIG` when you call `browserlessBrowsers()`, before anything connects: a
token with other characters, an unknown region, both a region and an endpoint, an endpoint that is not `wss://` (or
`ws://` on this machine) or carries a query or credentials, or a lifetime over 24 hours.

## How it is tested

- Unit tests check the connection URL: the region's host or your endpoint, the token and timeout in its query, ad
  blocking and stealth only when asked, and `joinable: false`.
- The [browser conformance suite](../guides/browsers.md#writing-a-provider) runs with each connection answered by a
  browser launched from the Chrome or Edge installed on the test machine, as Browserless launches one per connection.
- `scripts/live/browser-browserless.mjs` runs the suite's public-page checks on real hosted Browserless browsers
  (opening and snapshotting a page, origins enforced, following a link and a screenshot): all passed on October 6,
  2026.

## Related

- [Browsers](../guides/browsers.md): limits, origins, per-run browsers and tools.
- [Browserbase browsers](browser-browserbase.md): sessions with a live view that other clients can join.
- [Cloudflare Browser Run browsers](browser-cloudflare.md): another browser service you reach over CDP.
