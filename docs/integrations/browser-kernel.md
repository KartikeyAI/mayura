---
title: "Kernel browsers"
description: "Drive Kernel's hosted Chromium browsers from agents with @mayurajs/browser-kernel: setup, standby timeouts, stealth, live view and errors."
package: "@mayurajs/browser-kernel"
vendor: "Kernel"
logo: "kernel"
website: "https://www.kernel.sh"
area: "browsers"
---

[Kernel](https://www.kernel.sh) runs hosted Chromium browsers you drive over the Chrome DevTools Protocol.
`@mayurajs/browser-kernel` plugs Kernel into [`mayura/browser`](../guides/browsers.md), so agents get Kernel browsers
through the same `createBrowsers` limits, origins and tools as the Chrome installed on your machine. It creates and
deletes browsers over Kernel's browsers API with `fetch` and drives them over CDP: no Kernel SDK, no other
dependencies, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/browser-kernel
```

## Credentials

Create an API key in the [Kernel dashboard](https://dashboard.onkernel.com) under **API Keys**. The package sends it as
a bearer token. It reads nothing from the environment: pass the key in yourself, for example from `KERNEL_API_KEY`.

## Use it

```ts
import { browserPerRun, browserTools, createBrowsers } from 'mayura/browser';
import { kernelBrowsers } from '@mayurajs/browser-kernel';

const browsers = createBrowsers(kernelBrowsers({ apiKey: process.env.KERNEL_API_KEY ?? '', region: 'eu-west' }), {
  maxBrowsers: 2,
  maxLifetimeMs: 30 * 60_000,
  origins: ['https://example.com', 'https://*.example.com'],
});

const browser = await browsers.open({ lifetimeMs: 10 * 60_000, labels: { team: 'research' } });
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
before Kernel is called. See [Browsers](../guides/browsers.md) for per-run browsers, every method and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your Kernel API key. |
| `liveView` | `'view'` | `'view'` gives a read-only `liveViewUrl`, `'interact'` lets its holder use the browser too, `false` gives none and runs the browser headless. |
| `stealth` | `false` | Kernel's stealth mode, which also turns on its captcha solver. |
| `region` | Kernel's (`us-east`) | Where browsers run: `us-east`, `eu-west` or `ap-southeast`. |
| `standbyTimeoutSeconds` | `60` | How long a browser waits once nothing is connected before Kernel deletes it: 10 to 259,200. |
| `maxLifetimeMs` | 24 hours | The longest lifetime: 1 s to 72 hours. |
| `baseUrl` | `https://api.onkernel.com` | Kernel's API. Must be https (or `localhost`/`127.0.0.1`). |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Browsers

- Each browser is created when you open it, with your viewport, and deleted when you release it.
- Kernel keeps a browser running for as long as something is connected, so it has no timeout of its own to give:
  `createBrowsers` keeps the lifetime and releases the browser when it ends.
- Once nothing is connected (your process stopped, say), Kernel deletes the browser after `standbyTimeoutSeconds`, 60
  by default. That ends a browser whose release never came.
- `release()` deletes the browser. One Kernel deleted already answers 404, which `createBrowsers` counts as released.
- **Stealth is off**, since in Kernel it also turns on a captcha solver. No proxy is used.
- `labels` become the browser's tags.

## Live view and CDP

`liveViewUrl` is Kernel's live view, a link with a token in it: treat it as a secret. By default the package adds
`readOnly=true`, so it only shows the browser; `liveView: 'interact'` lets whoever has the link use it too. Kernel's live
view needs a browser with a screen, so with `liveView: false` the browser runs headless and has none.

The CDP endpoint is Kernel's CDP WebSocket URL, which must be `wss://` (plain `ws://` only on this machine). Treat it as
a secret: Kernel does not say what it carries, and Mayura never logs it. Each browser is yours alone, so `browser.cdp`
is there for another client, such as [Stagehand](browser-stagehand.md), to drive it alongside.

## Origins

Origins are enforced inside the browser: Mayura intercepts every request the browser makes over CDP and blocks those to
origins you did not allow, as the [guide](../guides/browsers.md#origins) describes. Should a connection not allow that
interception, opening the browser fails rather than running unchecked.

## Errors

Failures reach you as a `BrowserError` with a `reason`, mapped from Kernel's HTTP status. Nothing Kernel wrote reaches
the message.

| `reason` | When |
| --- | --- |
| `authentication` | The key is wrong or lacks permission (401, 403). |
| `quota` | Your plan refused the browser (402). |
| `rate_limited` | Kernel's rate or concurrency limits refused the call (429). |
| `gone` | The browser no longer exists (404, 410), for example after its standby timeout. |
| `timeout` | Kernel gave up on a call (408, 504). |
| `unavailable` | Kernel failed or could not be reached (5xx). |
| `rejected` | Kernel refused the request for another reason. |
| `invalid_response` | A reply was missing its session id or CDP URL, the id was malformed, or the URL was not a secure WebSocket. |

Configuration mistakes, such as an unknown region or a standby timeout under 10 seconds, fail with `INVALID_CONFIG`
when you call `kernelBrowsers()`, before anything is sent.

## How it is tested

- Unit tests run the package against a fake Kernel browsers API that checks every request: the body with stealth off,
  the standby timeout, headless without a live view, labels as tags, the read-only live view, the delete, and failures
  mapped without Kernel's text.
- The [browser conformance suite](../guides/browsers.md#writing-a-provider) runs against browsers served by the Chrome
  or Edge installed on the test machine behind that fake API.
- `scripts/live/browser-kernel.mjs` runs the suite's public-page checks on a real Kernel browser (live view, opening
  and snapshotting a page, origins enforced, following a link and a screenshot): all passed on October 6, 2026.

## Related

- [Browsers](../guides/browsers.md): limits, origins, per-run browsers and tools.
- [Hyperbrowser browsers](browser-hyperbrowser.md): sessions with stealth and recording off.
- [Stagehand tools](browser-stagehand.md): natural-language tools on a Kernel browser.
