---
title: "BrowserView browsers"
description: "Drive BrowserView's hosted Chromium sessions from agents with @mayurajs/browser-browserview: setup, session tokens, live view, origins and errors."
package: "@mayurajs/browser-browserview"
vendor: "BrowserView"
logo: "browserview"
website: "https://browserview.io"
area: "browsers"
---

[BrowserView](https://browserview.io) runs hosted Chromium sessions you drive over the Chrome DevTools Protocol.
`@mayurajs/browser-browserview` plugs BrowserView into [`mayura/browser`](../guides/browsers.md), so agents get
BrowserView sessions through the same `createBrowsers` limits, origins and tools as the Chrome installed on your
machine. It creates and releases sessions over BrowserView's sessions API with `fetch` and drives them over CDP: no
BrowserView SDK and no other dependencies. It runs as is on Node and Bun; on Workers and Deno, give `createBrowsers` a
`webSocket` that can send headers (see [CDP](#cdp)).

## Install

```bash
npm install mayura @mayurajs/browser-browserview
```

## Credentials

BrowserView calls the credential an API key; it starts with `bv_live_`. Create one in your BrowserView account, as its
[docs](https://browserview.io/docs) describe. The package sends it as a bearer token. It reads nothing from the
environment: pass the key in yourself, for example from `BROWSERVIEW_API_KEY`.

## Use it

```ts
import { browserPerRun, browserTools, createBrowsers } from 'mayura/browser';
import { browserViewBrowsers } from '@mayurajs/browser-browserview';

const browsers = createBrowsers(browserViewBrowsers({ apiKey: process.env.BROWSERVIEW_API_KEY ?? '' }), {
  maxBrowsers: 2,
  maxLifetimeMs: 15 * 60_000,
  origins: ['https://example.com', 'https://*.example.com'],
});

const browser = await browsers.open({ lifetimeMs: 10 * 60_000, labels: { team: 'research' } });
try {
  console.log(browser.liveViewUrl); // BrowserView's watch link, with a token in it: treat it as a secret
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
before BrowserView is called. See [Browsers](../guides/browsers.md) for per-run browsers, every method and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your BrowserView API key (`bv_live_...`). |
| `liveView` | `'view'` | `'view'` gives BrowserView's watch link as `liveViewUrl`, `'interact'` its viewer, whose holder can use the browser, `false` gives none. |
| `stealth` | `false` | BrowserView's stealth mode. BrowserView's own default is on. |
| `idleTimeoutSeconds` | `0` (none) | End a session after this many seconds without activity. |
| `maxLifetimeMs` | 4 hours | The longest lifetime: 1 s to 4 hours. BrowserView's free plan allows 15 minutes. |
| `baseUrl` | `https://sessions.browserview.io` | BrowserView's API. Must be https (or `localhost`/`127.0.0.1`). |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Sessions

- Each browser is one BrowserView session, created when you open it. Its screen is your viewport, kept to 320–3,840 ×
  240–2,160.
- **Sessions are not kept alive** (`keep_alive: false`), though BrowserView's own default is to keep them: a session
  ends shortly after its connection does.
- The browser's lifetime becomes the session's timeout in whole seconds (rounded up), so BrowserView ends it even if a
  release never comes. There is no idle timeout unless you give `idleTimeoutSeconds`.
- `release()` releases the session; BrowserView's release is idempotent, and one it no longer has answers 404 (`gone`),
  which `createBrowsers` counts as released.
- **Stealth is off**, though BrowserView turns it on by default. Proxies, captcha solving, downloads, recording and
  BrowserView's own agent are off in every session.
- `labels` become the session's metadata.

## Live view

`liveViewUrl` is a link with a token in it: treat it as a secret. By default it is BrowserView's watch link;
`liveView: 'interact'` gives its viewer instead, which lets whoever has the link use the browser. Both must be paths on
BrowserView's own service; anything else gives no live view.

## CDP

BrowserView gives each session a CDP address on its own service and a session token. The package asks that address,
with the token, for the browser's WebSocket URL; if that fails, it releases the session and the open fails with
`unavailable`.

The CDP connection needs the token in an `x-session-token` header, which `browser.cdp.headers` carries for other
clients too. Node and Bun send headers on a WebSocket; Workers and Deno cannot, so there you give `createBrowsers` a
`webSocket` function `(url, headers) => socket` that opens the connection with those headers (on Workers, a `fetch`
with an `Upgrade: websocket` header and the socket it returns, accepted). Mayura never logs the token.

Each session is yours alone, so `browser.cdp` is there for another client, such as [Stagehand](browser-stagehand.md),
to drive it alongside.

## Origins

Origins are enforced inside the browser: Mayura intercepts every request the session makes over CDP and blocks those to
origins you did not allow, as the [guide](../guides/browsers.md#origins) describes. Should a connection not allow that
interception, opening the browser fails rather than running unchecked.

## Errors

Failures reach you as a `BrowserError` with a `reason`, mapped from BrowserView's HTTP status. Nothing BrowserView wrote
reaches the message.

| `reason` | When |
| --- | --- |
| `authentication` | The key is wrong or lacks permission (401, 403). |
| `quota` | Your plan refused the session (402). |
| `rate_limited` | BrowserView's rate or concurrency limits refused the call (429). |
| `gone` | The session no longer exists (404, 410). |
| `timeout` | BrowserView gave up on a call (408, 504). |
| `unavailable` | BrowserView failed or could not be reached (5xx), or the session's CDP address did not describe its browser. |
| `rejected` | BrowserView refused the request for another reason. |
| `invalid_response` | A reply was missing its session id, CDP address or token, the id was malformed, or the CDP address was not a path on BrowserView's service. |

Configuration mistakes, such as a negative idle timeout or a lifetime over 4 hours, fail with `INVALID_CONFIG` when you
call `browserViewBrowsers()`, before anything is sent.

## How it is tested

- Unit tests run the package against a fake BrowserView sessions API that checks every request: the body with stealth,
  proxies, captchas, downloads, recording and the agent off, the screen bounds, the token sent to the CDP address and
  not the key, the watch link and viewer, the release, and failures mapped without BrowserView's text.
- The [browser conformance suite](../guides/browsers.md#writing-a-provider) runs against sessions served by the Chrome
  or Edge installed on the test machine behind that fake API, with connections refused unless they carry the session
  token.
- `scripts/live/browser-browserview.mjs` runs the suite's public-page checks on a real BrowserView session (live view,
  opening and snapshotting a page, origins enforced, following a link and a screenshot): all passed on October 6, 2026.

## Related

- [Browsers](../guides/browsers.md): limits, origins, per-run browsers and tools.
- [Cloudflare Browser Run browsers](browser-cloudflare.md): another CDP connection that needs a header.
- [Live browser viewer](browser-viewer.md): a live view for any browser, local ones included.
