---
title: "Steel browsers"
description: "Drive Steel's hosted Chromium sessions from agents with @mayurajs/browser-steel: setup, options, session lifetimes, live view and errors."
package: "@mayurajs/browser-steel"
vendor: "Steel"
logo: "steel"
website: "https://steel.dev"
area: "browsers"
---

[Steel](https://steel.dev) runs hosted Chromium sessions you drive over the Chrome DevTools Protocol.
`@mayurajs/browser-steel` plugs Steel into [`mayura/browser`](../guides/browsers.md), so agents get Steel sessions
through the same `createBrowsers` limits, origins and tools as the Chrome installed on your machine. It creates and
releases sessions over Steel's sessions API with `fetch` and drives them over CDP: no Steel SDK, no other dependencies,
and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/browser-steel
```

## Credentials

Create an API key in the [Steel dashboard](https://app.steel.dev) under **API Keys**. The package sends it as the
`steel-api-key` header, and on the CDP WebSocket URL as Steel asks. It reads nothing from the environment: pass the key
in yourself, for example from `STEEL_API_KEY`.

## Use it

```ts
import { browserPerRun, browserTools, createBrowsers } from 'mayura/browser';
import { steelBrowsers } from '@mayurajs/browser-steel';

const browsers = createBrowsers(steelBrowsers({ apiKey: process.env.STEEL_API_KEY ?? '', inactivityTimeoutMs: 120_000 }), {
  maxBrowsers: 3,
  maxLifetimeMs: 15 * 60_000,
  origins: ['https://example.com', 'https://*.example.com'],
});

const browser = await browsers.open({ lifetimeMs: 10 * 60_000 });
try {
  console.log(browser.liveViewUrl); // Steel's session viewer, view only: treat it as a secret
  await browser.goto('https://example.com/');
  console.log((await browser.snapshot()).text);
} finally {
  await browser.release(); // a Steel session outlives its connection: always release it
}

// Or give each run a browser as tools. A run grants tool:web.<tool> for each tool it calls, effect:read and
// browser:web:read; actions such as web.click also need effect:write and browser:web:act.
const perRun = browserPerRun(browsers);
const tools = browserTools(perRun.source, { name: 'web', act: true });
```

`createBrowsers` enforces your limits (how many browsers, how long each lives, which origins pages may load from)
before Steel is called. See [Browsers](../guides/browsers.md) for per-run browsers, every method and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your Steel API key. |
| `liveView` | `'view'` | `'view'` gives a view-only `liveViewUrl`, `'interact'` lets its holder use the browser too, `false` gives none. |
| `solveCaptcha` | `false` | Let Steel solve captchas. |
| `blockAds` | `false` | Block ads. |
| `inactivityTimeoutMs` | unset | End a session after this long without CDP commands or input. At least 1 s, and shorter than the browser's lifetime. |
| `maxLifetimeMs` | 24 hours | The longest lifetime: 15 s to 24 hours. Steel's plans cap it at 15 minutes, an hour or 24 hours. |
| `baseUrl` | `https://api.steel.dev` | Steel's API. Must be https (or `localhost`/`127.0.0.1`). |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Sessions

- Each browser is one Steel session, created when you open it with your viewport.
- **A Steel session outlives its connection.** One you do not release keeps running, and billing, until its timeout.
  The browser's lifetime becomes that timeout (at least 15 s), so Steel ends it then at the latest;
  `inactivityTimeoutMs` ends an idle one sooner.
- `release()` calls Steel's release endpoint. If that is refused, the package asks for the session's status: one that
  is gone, `released` or `failed` counts as released.
- Captcha solving, ad blocking and proxies are off unless you ask (`useProxy` is always `false`).
- Steel has no labels for sessions, so `labels` are not sent.

## Live view and CDP

`liveViewUrl` is Steel's session viewer. It needs no sign-in, so anyone with the URL can see the session: treat it as a
secret. By default it only shows the browser; `liveView: 'interact'` lets its holder click and type too.

The CDP endpoint is Steel's WebSocket URL, which must be `wss://` (plain `ws://` only on this machine), with your API
key added as its `apiKey` query parameter, as Steel asks. Treat it as a secret: Mayura never logs it. Each session is
yours alone, so `browser.cdp` is there for another client, such as [Stagehand](browser-stagehand.md), to drive it
alongside.

## Origins

Origins are enforced inside the browser: Mayura intercepts every request the session makes over CDP and blocks those to
origins you did not allow, as the [guide](../guides/browsers.md#origins) describes. Should a connection not allow that
interception, opening the browser fails rather than running unchecked.

## Errors

Failures reach you as a `BrowserError` with a `reason`, mapped from Steel's HTTP status. Nothing Steel wrote reaches the
message.

| `reason` | When |
| --- | --- |
| `authentication` | The key is wrong or lacks permission (401, 403). |
| `quota` | Your plan refused the session (402). |
| `rate_limited` | Steel's rate or concurrency limits refused the call (429). |
| `gone` | The session no longer exists (404, 410). |
| `timeout` | Steel gave up on a call (408, 504). |
| `unavailable` | Steel failed or could not be reached (5xx). |
| `rejected` | Steel refused the request for another reason. |
| `invalid_response` | A reply was missing its session id or WebSocket URL, the id was malformed, or the URL was not a secure WebSocket. |

Configuration mistakes, such as a lifetime under 15 s or an inactivity timeout under 1 s, fail with `INVALID_CONFIG`
when you call `steelBrowsers()`, before anything is sent. An inactivity timeout not shorter than a browser's lifetime
fails that open with `INVALID_INPUT`.

## How it is tested

- Unit tests run the package against a fake Steel sessions API that checks every request: the session body with
  captchas, ads and proxies off, the minimum timeout, the key on the WebSocket, the viewer's mode, the release, and
  failures mapped without Steel's text.
- The [browser conformance suite](../guides/browsers.md#writing-a-provider) runs against sessions served by the Chrome
  or Edge installed on the test machine behind that fake API.
- `scripts/live/browser-steel.mjs` runs the suite's public-page checks on a real Steel session (live view, opening and
  snapshotting a page, origins enforced, following a link and a screenshot): all passed on October 6, 2026.

## Related

- [Browsers](../guides/browsers.md): limits, origins, per-run browsers and tools.
- [Browserbase browsers](browser-browserbase.md): sessions that end with their connection.
- [Live browser viewer](browser-viewer.md): a live view for any browser, local ones included.
