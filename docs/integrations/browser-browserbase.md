---
title: "Browserbase browsers"
description: "Drive Browserbase's hosted Chromium sessions from agents with @mayurajs/browser-browserbase: setup, options, live view, origins and errors."
package: "@mayurajs/browser-browserbase"
vendor: "Browserbase"
logo: "browserbase"
website: "https://www.browserbase.com"
area: "browsers"
---

[Browserbase](https://www.browserbase.com) runs hosted Chromium sessions you drive over the Chrome DevTools Protocol.
`@mayurajs/browser-browserbase` plugs Browserbase into [`mayura/browser`](../guides/browsers.md), so agents get
Browserbase sessions through the same `createBrowsers` limits, origins and tools as the Chrome installed on your
machine. It creates and releases sessions over Browserbase's sessions API with `fetch` and drives them over CDP: no
Browserbase SDK, no other dependencies, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/browser-browserbase
```

## Credentials

Create an API key in the [Browserbase dashboard](https://www.browserbase.com/settings) under **Settings**. The package
sends it as the `x-bb-api-key` header. It reads nothing from the environment: pass the key in yourself, for example
from `BROWSERBASE_API_KEY`. Sessions go to the key's own project unless you pass `projectId`.

## Use it

```ts
import { browserPerRun, browserTools, createBrowsers } from 'mayura/browser';
import { browserbaseBrowsers } from '@mayurajs/browser-browserbase';

const browsers = createBrowsers(browserbaseBrowsers({ apiKey: process.env.BROWSERBASE_API_KEY ?? '' }), {
  maxBrowsers: 3,
  maxLifetimeMs: 30 * 60_000,
  origins: ['https://example.com', 'https://*.example.com'],
});

const browser = await browsers.open({ lifetimeMs: 10 * 60_000, labels: { team: 'research' } });
try {
  console.log(browser.liveViewUrl); // Browserbase's debugger view: treat it as a secret
  await browser.goto('https://example.com/');
  console.log((await browser.snapshot()).text);
} finally {
  await browser.release();
}

// Or give each run a browser as tools. A run grants tool:web.<tool> for each tool it calls, effect:read and
// browser:web:read; actions such as web.click also need effect:write and browser:web:act.
const perRun = browserPerRun(browsers);
const tools = browserTools(perRun.source, { name: 'web', act: true });
```

`createBrowsers` enforces your limits (how many browsers, how long each lives, which origins pages may load from)
before Browserbase is called. See [Browsers](../guides/browsers.md) for per-run browsers, every method and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your Browserbase API key. |
| `projectId` | the key's project | The project sessions belong to. |
| `region` | Browserbase's (`us-west-2`) | Where sessions run: `us-west-2`, `us-east-1`, `eu-central-1` or `ap-southeast-1`. |
| `liveView` | `true` | Give each browser a `liveViewUrl`. |
| `solveCaptchas` | `false` | Let Browserbase solve captchas. Browserbase's own default is on. |
| `recordSession` | `false` | Let Browserbase record sessions and keep their logs. Browserbase's own default is on. |
| `blockAds` | `false` | Block ads. |
| `maxLifetimeMs` | 6 hours | The longest lifetime: 1 minute to 6 hours. Browserbase's free plan allows 15 minutes. |
| `baseUrl` | `https://api.browserbase.com` | Browserbase's API. Must be https (or `localhost`/`127.0.0.1`). |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Sessions

- Each browser is one Browserbase session, created when you open it with your viewport and `labels` (as the session's
  `userMetadata`).
- Sessions are not kept alive (`keepAlive: false`): a session also ends when its connection does.
- The browser's lifetime becomes the session's timeout, rounded up to whole seconds and kept between 1 minute and 6
  hours, so Browserbase ends the session even if a release never comes.
- `release()` asks Browserbase to end the session (`REQUEST_RELEASE`). If that is refused, the package asks for the
  session's status: one that is gone or has ended (`COMPLETED`, `TIMED_OUT` or `ERROR`) counts as released.
- Captcha solving, recording and session logs are off, though Browserbase turns them on by default. No proxy is
  configured.

## Live view and CDP

`liveViewUrl` is Browserbase's fullscreen debugger view of the session, valid for the browser's lifetime. Anyone with
it can watch and use the browser: treat it as a secret, or turn it off with `liveView: false`. If the package cannot get
the view, it releases the session and the open fails.

The CDP endpoint is Browserbase's connect URL. It must be `wss://` (plain `ws://` only on this machine). Treat it as a
secret: Browserbase does not say what it carries, and Mayura never logs it. Each session is yours alone, so
`browser.cdp` is there for another client, such as [Stagehand](browser-stagehand.md), to drive it alongside.

## Origins

Origins are enforced inside the browser: Mayura intercepts every request the session makes over CDP and blocks those to
origins you did not allow, as the [guide](../guides/browsers.md#origins) describes. Should a connection not allow that
interception, opening the browser fails rather than running unchecked.

## Errors

Failures reach you as a `BrowserError` with a `reason`, mapped from Browserbase's HTTP status. Nothing Browserbase wrote
reaches the message.

| `reason` | When |
| --- | --- |
| `authentication` | The key is wrong or lacks permission (401, 403). |
| `quota` | Your plan refused the session (402). |
| `rate_limited` | Browserbase's rate or concurrency limits refused the call (429). |
| `gone` | The session no longer exists (404, 410). |
| `timeout` | Browserbase gave up on a call (408, 504). |
| `unavailable` | Browserbase failed or could not be reached (5xx). |
| `rejected` | Browserbase refused the request for another reason. |
| `invalid_response` | A reply was missing its session id or connect URL, the id was malformed, the connect URL was not a secure WebSocket, or the debugger view had no URL. |

Configuration mistakes, such as an unknown region or a lifetime under a minute or over 6 hours, fail with
`INVALID_CONFIG` when you call `browserbaseBrowsers()`, before anything is sent.

## How it is tested

- Unit tests run the package against a fake Browserbase sessions API that checks every request: the session body with
  captchas, recording and logs off, the timeout bounds, the release, and failures mapped without Browserbase's text.
- The [browser conformance suite](../guides/browsers.md#writing-a-provider) runs against sessions served by the Chrome
  or Edge installed on the test machine behind that fake API.
- `scripts/live/browser-browserbase.mjs` runs the suite's public-page checks on a real Browserbase session (live view,
  opening and snapshotting a page, origins enforced, following a link and a screenshot): all passed on October 6, 2026.

## Related

- [Browsers](../guides/browsers.md): limits, origins, per-run browsers and tools.
- [Stagehand tools](browser-stagehand.md): natural-language tools on a Browserbase browser.
- [Live browser viewer](browser-viewer.md): a live view for any browser, local ones included.
