---
title: "Hyperbrowser browsers"
description: "Drive Hyperbrowser's hosted Chromium sessions from agents with @mayurajs/browser-hyperbrowser: setup, options, live view, origins and errors."
package: "@mayurajs/browser-hyperbrowser"
vendor: "Hyperbrowser"
logo: "hyperbrowser"
website: "https://hyperbrowser.ai"
area: "browsers"
---

[Hyperbrowser](https://hyperbrowser.ai) runs hosted Chromium sessions you drive over the Chrome DevTools Protocol.
`@mayurajs/browser-hyperbrowser` plugs Hyperbrowser into [`mayura/browser`](../guides/browsers.md), so agents get
Hyperbrowser sessions through the same `createBrowsers` limits, origins and tools as the Chrome installed on your
machine. It creates and stops sessions over Hyperbrowser's sessions API with `fetch` and drives them over CDP: no
Hyperbrowser SDK, no other dependencies, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/browser-hyperbrowser
```

## Credentials

Create an API key in the [Hyperbrowser dashboard](https://app.hyperbrowser.ai) under **API Keys**. The package sends it
as the `x-api-key` header. It reads nothing from the environment: pass the key in yourself, for example from
`HYPERBROWSER_API_KEY`.

## Use it

```ts
import { browserPerRun, browserTools, createBrowsers } from 'mayura/browser';
import { hyperbrowserBrowsers } from '@mayurajs/browser-hyperbrowser';

const browsers = createBrowsers(hyperbrowserBrowsers({ apiKey: process.env.HYPERBROWSER_API_KEY ?? '' }), {
  maxBrowsers: 2,
  maxLifetimeMs: 30 * 60_000,
  origins: ['https://example.com', 'https://*.example.com'],
});

const browser = await browsers.open({ lifetimeMs: 10 * 60_000 });
try {
  console.log(browser.liveViewUrl); // view only, with a token in it: treat it as a secret
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
before Hyperbrowser is called. See [Browsers](../guides/browsers.md) for per-run browsers, every method and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your Hyperbrowser API key. |
| `liveView` | `'view'` | `'view'` gives a view-only `liveViewUrl`, `'interact'` lets its holder use the browser too, `false` gives none. |
| `solveCaptchas` | `false` | Let Hyperbrowser solve captchas. |
| `adblock` | `false` | Block ads. |
| `region` | Hyperbrowser's default | Where sessions run, as Hyperbrowser names regions (lowercase letters, digits and dashes). |
| `maxLifetimeMs` | 12 hours | The longest lifetime: 1 minute to 12 hours. |
| `baseUrl` | `https://api.hyperbrowser.ai` | Hyperbrowser's API. Must be https (or `localhost`/`127.0.0.1`). |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Sessions

- Each browser is one Hyperbrowser session, created when you open it with your viewport as its screen size.
- Sessions are not kept alive: a session also stops when its connection does.
- The browser's lifetime becomes the session's timeout in whole minutes (1 to 720, rounded up), so Hyperbrowser stops
  it even if a release never comes.
- `release()` stops the session. If that is refused, the package asks for the session's status: one that is `closed`
  or `error` counts as released, and one Hyperbrowser no longer knows fails with `gone`, which `createBrowsers` treats
  as released. One Hyperbrowser failed to close (`close-error`) does not count, as it may still run.
- Off in every session: proxies, stealth, web and video recording, and saved downloads. Captcha solving and ad
  blocking are off unless you turn them on.
- Hyperbrowser has no labels for sessions, so `labels` are not sent.

## Live view and CDP

`liveViewUrl` is Hyperbrowser's live view, a link with a token in it: treat it as a secret. By default it only shows the
session (`viewOnlyLiveView`); `liveView: 'interact'` lets whoever has the link use the browser too.

The CDP endpoint is Hyperbrowser's WebSocket endpoint, which must be `wss://` (plain `ws://` only on this machine).
Treat it as a secret: Hyperbrowser does not say what it carries, and Mayura never logs it. Each session is yours alone,
so `browser.cdp` is there for another client, such as [Stagehand](browser-stagehand.md), to drive it alongside.

## Origins

Origins are enforced inside the browser: Mayura intercepts every request the session makes over CDP and blocks those to
origins you did not allow, as the [guide](../guides/browsers.md#origins) describes. Should a connection not allow that
interception, opening the browser fails rather than running unchecked.

## Errors

Failures reach you as a `BrowserError` with a `reason`, mapped from Hyperbrowser's HTTP status. Nothing Hyperbrowser
wrote reaches the message.

| `reason` | When |
| --- | --- |
| `authentication` | The key is wrong or lacks permission (401, 403). |
| `quota` | Your plan refused the session (402). |
| `rate_limited` | Hyperbrowser's rate or concurrency limits refused the call (429). |
| `gone` | The session no longer exists (404, 410). |
| `timeout` | Hyperbrowser gave up on a call (408, 504). |
| `unavailable` | Hyperbrowser failed or could not be reached (5xx), or a stop failed on a session still open. |
| `rejected` | Hyperbrowser refused the request for another reason. |
| `invalid_response` | A reply was missing its session id or WebSocket endpoint, the id was malformed, or the endpoint was not a secure WebSocket. |

Configuration mistakes, such as a region with spaces or a lifetime under a minute or over 12 hours, fail with
`INVALID_CONFIG` when you call `hyperbrowserBrowsers()`, before anything is sent.

## How it is tested

- Unit tests run the package against a fake Hyperbrowser sessions API that checks every request: the session body with
  proxies, stealth, captchas, recording and saved downloads off, timeouts in whole minutes, the live view's mode, the
  stop, and failures mapped without Hyperbrowser's text.
- The [browser conformance suite](../guides/browsers.md#writing-a-provider) runs against sessions served by the Chrome
  or Edge installed on the test machine behind that fake API.
- `scripts/live/browser-hyperbrowser.mjs` runs the suite's public-page checks on a real Hyperbrowser session (live view,
  opening and snapshotting a page, origins enforced, following a link and a screenshot): all passed on October 6, 2026.

## Related

- [Browsers](../guides/browsers.md): limits, origins, per-run browsers and tools.
- [Kernel browsers](browser-kernel.md): another hosted browser with a view-only live view.
- [Live browser viewer](browser-viewer.md): a live view for any browser, local ones included.
