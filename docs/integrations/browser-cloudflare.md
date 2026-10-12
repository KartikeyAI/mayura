---
title: "Cloudflare Browser Run browsers"
description: "Drive Cloudflare Browser Run sessions from outside a Worker with @mayurajs/browser-cloudflare: token, keep-alive, live view, CDP headers and errors."
package: "@mayurajs/browser-cloudflare"
vendor: "Cloudflare"
logo: "cloudflare"
website: "https://www.cloudflare.com"
area: "browsers"
---

[Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/) (formerly Browser Rendering) runs headless
Chromium on Cloudflare's network. `@mayurajs/browser-cloudflare` plugs it into
[`mayura/browser`](../guides/browsers.md) from outside a Worker, so agents get Browser Run sessions through the same
`createBrowsers` limits, origins and tools as the Chrome installed on your machine. It acquires and closes sessions over
Browser Run's session API with `fetch` and drives them over CDP at each session's own address: no Cloudflare SDK and no
other dependencies. It runs as is on Node and Bun; on runtimes whose `WebSocket` cannot send headers, give
`createBrowsers` a `webSocket` that can (see [CDP](#cdp)).

Inside a Worker, Cloudflare's Browser binding is the way to a browser; this package is for everywhere else. For Browser
Run's REST actions (markdown, screenshots, crawls) without driving a browser, see
[Cloudflare quick actions](cloudflare-quick-action.md).

## Install

```bash
npm install mayura @mayurajs/browser-cloudflare
```

## Credentials

You need your account id (32 hex characters, on the account's overview page in the
[Cloudflare dashboard](https://dash.cloudflare.com)) and an API token. Create the token under
[**My Profile > API Tokens**](https://dash.cloudflare.com/profile/api-tokens) with the **Browser Rendering - Edit**
permission; the package needs nothing else. The package reads nothing from the environment: pass both in yourself, for
example from `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_BROWSER_TOKEN`.

## Use it

```ts
import { browserPerRun, browserTools, createBrowsers } from 'mayura/browser';
import { cloudflareBrowsers } from '@mayurajs/browser-cloudflare';

const browsers = createBrowsers(
  cloudflareBrowsers({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
    apiToken: process.env.CLOUDFLARE_BROWSER_TOKEN ?? '',
  }),
  {
    maxBrowsers: 3,
    maxLifetimeMs: 10 * 60_000,
    origins: ['https://example.com', 'https://*.example.com'],
  },
);

const browser = await browsers.open({ lifetimeMs: 5 * 60_000 });
try {
  console.log(browser.liveViewUrl); // read only, with a signed token in it: treat it as a secret
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
before Cloudflare is called. See [Browsers](../guides/browsers.md) for per-run browsers, every method and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `accountId` | required | Your Cloudflare account id (32 lowercase hex characters). |
| `apiToken` | required | An API token with **Browser Rendering - Edit**. |
| `keepAliveMs` | `60_000` | How long a session stays once nothing is connected: 10,000 to 600,000. |
| `liveView` | `'view'` | `'view'` gives a read-only `liveViewUrl`, `'interact'` lets its holder use the browser, `false` gives none. |
| `maxLifetimeMs` | 1 hour | The longest lifetime: at least 1 s. |
| `baseUrl` | `https://api.cloudflare.com` | Cloudflare's API, as an origin with no path. Plain `http://` only on this machine. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Sessions

- Each browser is one Browser Run session, acquired when you open it with `keep_alive` set to `keepAliveMs`, and closed
  when you release it.
- Browser Run has no lifetime to give a session: `createBrowsers` keeps the lifetime and releases the browser when it
  ends. Should the release never come, such as when your process stopped, Cloudflare ends the session `keepAliveMs`
  after its last connection closes (60 s by default). Cloudflare's pages give 10 or 20 minutes as the most, so the
  package allows up to 10.
- `release()` closes the session; one that already ended (404) counts as released.
- Labels are not sent.
- Cloudflare's limits apply: on its free plan, 10 browser-minutes a day, 3 browsers at once, and a new browser every 20
  seconds.

## Live view

`liveViewUrl` is a Browser Run live view of the browser's page, a link with a signed token in it: treat it as a secret.
It is read only by default (Cloudflare's `readonly` guardrails); `liveView: 'interact'` lets whoever has the link use
the browser. It lasts for the browser's lifetime, up to an hour. If the package cannot get it, it closes the session and
the open fails.

## CDP

Each session is driven at its own address,
`wss://api.cloudflare.com/client/v4/accounts/<account id>/browser-run/devtools/browser/<session id>`, with your token
in an `Authorization: Bearer` header on the WebSocket. Node and Bun send that header; on runtimes whose `WebSocket`
cannot (Deno, or Workers, where the Browser binding is the better way), give `createBrowsers` a `webSocket` function
`(url, headers) => socket` that opens the connection with those headers. Mayura never logs the token.

Because the address is the session's own, a second client over `browser.cdp` (`url` and `headers`), such as
[Stagehand](browser-stagehand.md) or the [live browser viewer](browser-viewer.md), joins the same browser, with the same
origins enforced.

## Origins

Origins are enforced inside the browser: Mayura intercepts every request the session makes over CDP and blocks those to
origins you did not allow, as the [guide](../guides/browsers.md#origins) describes. Should a connection not allow that
interception, opening the browser fails rather than running unchecked.

## Errors

Failures reach you as a `BrowserError` with a `reason`, mapped from Cloudflare's HTTP status. Nothing Cloudflare wrote
reaches the message.

| `reason` | When |
| --- | --- |
| `authentication` | The token is wrong or lacks **Browser Rendering - Edit** (401, 403). |
| `quota` | Your plan refused the session (402). |
| `rate_limited` | Cloudflare's limits refused the call (429), such as too many browsers at once or too soon. |
| `gone` | The session no longer exists (404, 410). On release, 404 counts as released. |
| `timeout` | Cloudflare gave up on a call (408, 504). |
| `unavailable` | Cloudflare failed or could not be reached (5xx). |
| `rejected` | Cloudflare refused the request for another reason. |
| `invalid_response` | A reply was missing its session id, the id was malformed, or the live view was not an https link. |

Configuration mistakes, such as an account id that is not 32 hex characters, a token with spaces, a keep-alive under
10 s or a `baseUrl` with a path, fail with `INVALID_CONFIG` when you call `cloudflareBrowsers()`, before anything is
sent.

## How it is tested

- Unit tests run the package against a fake Browser Run API that checks every request: the keep-alive, the session's
  own CDP address with the token in a header, the read-only and interactive live views and their expiry, the close, a
  failed live view closing the session, and failures mapped to reasons.
- The [browser conformance suite](../guides/browsers.md#writing-a-provider) runs against sessions served by the Chrome
  or Edge installed on the test machine behind that fake API.
- `scripts/live/browser-cloudflare.mjs` runs the suite's public-page checks on a real Browser Run session (opening and
  snapshotting a page, origins enforced, a second client joining the same session with a live view, following a link
  and a screenshot): all passed on October 6, 2026.

## Related

- [Browsers](../guides/browsers.md): limits, origins, per-run browsers and tools.
- [Cloudflare quick actions](cloudflare-quick-action.md): Browser Run's markdown, links, scrape, screenshot, JSON and
  crawl as tools.
- [Live browser viewer](browser-viewer.md): a live view streamed from any browser.
