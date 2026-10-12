---
title: "Anchor Browser sessions"
description: "Drive Anchor Browser's hosted Chromium sessions from agents with @mayurajs/browser-anchor: setup, timeouts, recording, live view and errors."
package: "@mayurajs/browser-anchor"
vendor: "Anchor Browser"
logo: "anchor"
website: "https://anchorbrowser.io"
area: "browsers"
---

[Anchor Browser](https://anchorbrowser.io) runs hosted Chromium sessions you drive over the Chrome DevTools Protocol.
`@mayurajs/browser-anchor` plugs Anchor into [`mayura/browser`](../guides/browsers.md), so agents get Anchor sessions
through the same `createBrowsers` limits, origins and tools as the Chrome installed on your machine. It creates and ends
sessions over Anchor's sessions API with `fetch` and drives them over CDP: no Anchor SDK, no other dependencies, and it
runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/browser-anchor
```

## Credentials

Create an API key in the [Anchor Browser dashboard](https://app.anchorbrowser.io) under **API Keys**. The package sends
it as the `anchor-api-key` header. It reads nothing from the environment: pass the key in yourself, for example from
`ANCHOR_API_KEY`.

## Use it

```ts
import { browserPerRun, browserTools, createBrowsers } from 'mayura/browser';
import { anchorBrowsers } from '@mayurajs/browser-anchor';

const browsers = createBrowsers(anchorBrowsers({ apiKey: process.env.ANCHOR_API_KEY ?? '', idleTimeoutMinutes: 5 }), {
  maxBrowsers: 2,
  maxLifetimeMs: 30 * 60_000,
  origins: ['https://example.com', 'https://*.example.com'],
});

const browser = await browsers.open({ lifetimeMs: 10 * 60_000, labels: { team: 'research' } });
try {
  console.log(browser.liveViewUrl); // view only: treat it as a secret
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
before Anchor is called. See [Browsers](../guides/browsers.md) for per-run browsers, every method and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your Anchor Browser API key. |
| `liveView` | `'view'` | `'view'` gives a read-only `liveViewUrl`, `'interact'` lets its holder use the browser too, `false` gives none and runs the browser headless. |
| `adblock` | `false` | Block ads, and turn on Anchor's popup blocker with it. Anchor's own default is on. |
| `recording` | `false` | Record sessions. Anchor's own default is on. |
| `idleTimeoutMinutes` | `1` | How long a session waits once nothing is connected before Anchor ends it: 1 to 1,440. |
| `maxLifetimeMs` | 24 hours | The longest lifetime: at least 1 minute. |
| `baseUrl` | `https://api.anchorbrowser.io` | Anchor's API. Must be https (or `localhost`/`127.0.0.1`). |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Sessions

- Each browser is one Anchor session, created when you open it with your viewport and ended when you release it.
- The browser's lifetime becomes the session's maximum duration in whole minutes (rounded up). Anchor's docs disagree on
  its default, so the package always sends it.
- Anchor also ends a session `idleTimeoutMinutes` after nothing is connected (1 by default), such as when your process
  stops.
- `release()` ends the session. Anchor answers ending a session it no longer has with "invalid API key or session id"
  (401); since the key worked when the session was created, the package reports that as `gone`, which `createBrowsers`
  counts as released.
- **Recording and ad blocking are off**, though Anchor's own defaults are on. Anchor turns its popup blocker on by
  default and refuses it without the ad blocker, so the popup blocker follows `adblock`.
- No proxy and no captcha solving, in every session.
- `labels` become the session's tags, as `key=value`.

## Live view and CDP

`liveViewUrl` is Anchor's live view: treat it as a secret. By default it is read-only; `liveView: 'interact'` lets
whoever has the link use the browser too. Anchor's live view needs a browser with a screen, so with `liveView: false`
the browser runs headless and has none.

The CDP endpoint is Anchor's CDP URL, which must be `wss://` (plain `ws://` only on this machine). It carries your API
key: treat it as a secret. Mayura never logs it. Each session is yours alone, so `browser.cdp` is there for another
client, such as [Stagehand](browser-stagehand.md), to drive it alongside.

## Origins

Origins are enforced inside the browser: Mayura intercepts every request the session makes over CDP and blocks those to
origins you did not allow, as the [guide](../guides/browsers.md#origins) describes. Should a connection not allow that
interception, opening the browser fails rather than running unchecked.

## Errors

Failures reach you as a `BrowserError` with a `reason`, mapped from Anchor's HTTP status. Nothing Anchor wrote reaches
the message.

| `reason` | When |
| --- | --- |
| `authentication` | The key is wrong or lacks permission (401, 403) when creating a session. |
| `quota` | Your plan refused the session (402). |
| `rate_limited` | Anchor's rate or concurrency limits refused the call (429). |
| `gone` | The session no longer exists (404, 410, or 401 on release). |
| `timeout` | Anchor gave up on a call (408, 504). |
| `unavailable` | Anchor failed or could not be reached (5xx). |
| `rejected` | Anchor refused the request for another reason. |
| `invalid_response` | A reply was missing its session id or CDP URL, the id was malformed, or the URL was not a secure WebSocket. |

Configuration mistakes, such as an idle timeout of 0 or a lifetime under a minute, fail with `INVALID_CONFIG` when you
call `anchorBrowsers()`, before anything is sent.

## How it is tested

- Unit tests run the package against a fake Anchor sessions API that checks every request: the body with recording, ad
  and popup blocking, proxy and captchas off, the maximum and idle timeouts, labels as tags, headless without a live
  view, the end of a session, a 401 on release as `gone`, and failures mapped without Anchor's text.
- The [browser conformance suite](../guides/browsers.md#writing-a-provider) runs against sessions served by the Chrome
  or Edge installed on the test machine behind that fake API.
- `scripts/live/browser-anchor.mjs` runs the suite's public-page checks on a real Anchor session. An earlier attempt
  found that Anchor refuses a popup blocker without the ad blocker, which is why the popup blocker now follows
  `adblock`. The full live run has not completed yet: the account hit its plan quota (HTTP 402) before it.

## Related

- [Browsers](../guides/browsers.md): limits, origins, per-run browsers and tools.
- [Kernel browsers](browser-kernel.md): another hosted browser ended soon after nothing is connected.
- [Live browser viewer](browser-viewer.md): a live view for any browser, local ones included.
