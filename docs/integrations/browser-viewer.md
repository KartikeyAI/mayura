---
title: "Live browser viewer"
description: "Let people watch, and optionally use, an agent's browser through an expiring link with @mayurajs/browser-viewer: setup, sharing, limits and security."
package: "@mayurajs/browser-viewer"
vendor: "Mayura"
logo: "mayura"
website: "https://mayurajs.com"
area: "browsers"
---

`@mayurajs/browser-viewer` is a live view for any [`mayura/browser`](../guides/browsers.md) browser that other clients
can join, local ones included, whatever its provider's own live view. A person opens a link and watches what the agent's
browser shows; with a link that allows it, they use the page too. The browser's active tab streams as JPEG frames (a
CDP screencast) over a connection of the viewer's own, following the agent from tab to tab, to a page that needs nothing
but an image tag.

It has no dependencies and talks to no outside service. `browserViewer` (request handling) and `browserScreencast` run
on every runtime Mayura runs on; `serveBrowserViewer`, a server of its own, is Node only.

## Install

```bash
npm install mayura @mayurajs/browser-viewer
```

It needs no credentials.

## Use it

```ts
import { createBrowsers } from 'mayura/browser';
import { localBrowsers } from 'mayura/browser/local';
import { serveBrowserViewer } from '@mayurajs/browser-viewer';

const browsers = createBrowsers(localBrowsers(), {
  maxBrowsers: 1,
  maxLifetimeMs: 30 * 60_000,
  origins: ['https://example.com'],
});
const browser = await browsers.open();
await browser.goto('https://example.com/');

const viewer = await serveBrowserViewer(); // http://127.0.0.1:<port>/, this machine only
const watch = await viewer.share(browser); // view only, for an hour
console.log(watch.url); // a secret: whoever has it can watch

// A person takes over for ten minutes, within the browser's origins.
const takeover = await viewer.share(browser, { interact: true, expiresInMs: 10 * 60_000 });
takeover.revoke(); // ends it early

await viewer.close();
await browser.release();
```

### On your own server

`browserViewer(options)` is the same viewer as web-standard request handling, for any server on any runtime. Mount
`handle(request)` under `basePath`: it answers `<basePath>v/...` and returns `undefined` for anything else. Give people
`share(browser).path` on your origin.

```ts
import { browserViewer } from '@mayurajs/browser-viewer';

const viewer = browserViewer({ basePath: '/viewer/', frameAncestors: ['https://app.example.com'] });
const share = await viewer.share(browser, { expiresInMs: 15 * 60_000 });
// Send people to https://app.example.com + share.path.

export default {
  async fetch(request: Request): Promise<Response> {
    return (await viewer.handle(request)) ?? new Response('Not found.', { status: 404 });
  },
};
```

Behind your own authentication, the link's token is a second lock, not the only one.

### The screencast alone

`browserScreencast(browser, { interact })` gives the frames themselves: an async iterable of JPEGs with the page's size
and the tab shown, and, for interactive screencasts, `input(event)` to send a person's mouse, wheel, key and text
input. Use it to show frames however you like.

## Sharing

- **Nothing is shown unless shared.** `share(browser)` makes a link with a 256-bit random token in it. Links are kept by
  the token's SHA-256 hash, not the token.
- A link stops working when it expires (`expiresInMs`, 1 hour by default, 1 s to 24 hours), when you call `revoke()`,
  when you close the viewer, or when the browser ends. Whatever was being watched through it ends then too.
- **Watching is the default; using is opt-in.** With `interact: true`, the page sends the person's clicks, scrolling,
  keys and pasted text to the browser, as input to the page shown. Everything the person does stays within the
  browser's origins, as everything the agent does.
- Input is only taken as JSON from the viewer's own page, never across sites, at most `maxInputPerSecond` events a link,
  4 KiB each.

## Options

`browserViewer` and `serveBrowserViewer` take:

| Option | Default | Meaning |
| --- | --- | --- |
| `quality` | `60` | JPEG quality: 1 to 100. |
| `maxWidth`, `maxHeight` | `1280`, `800` | The largest frame: 320 to 3,840 wide, 240 to 2,160 tall. |
| `maxFps` | `5` | The most frames a second: 1 to 30. Frames also come only as fast as each viewer takes them. |
| `maxFrameBytes` | 2 MiB | Larger frames are skipped: 64 KiB to 16 MiB. |
| `maxViewersPerShare` | `2` | How many people may watch one link at once, each over a CDP connection of their own: 1 to 16. |
| `maxShares` | `16` | How many links may be open at once: 1 to 256. |
| `maxInputPerSecond` | `60` | Input events a second, per link: 1 to 500. |
| `frameAncestors` | none | Origins allowed to show the viewer page in a frame (its CSP `frame-ancestors`), at most 16. |
| `webSocket` | the runtime's | Opens the CDP connection, for runtimes whose `WebSocket` cannot send the headers a browser's CDP connection needs. |
| `basePath` | `/` | `browserViewer` only: where the viewer is mounted, such as `/viewer/`. |

`serveBrowserViewer` adds:

| Option | Default | Meaning |
| --- | --- | --- |
| `host` | `127.0.0.1` | The address to listen on. Another than this machine's needs `remote: true`. |
| `port` | any free one | The port. |
| `remote` | `false` | Listen beyond this machine. Links then carry their token in the clear unless TLS is in front. |
| `publicUrl` | the server's address | The https origin people reach the server at, used for links (`http://` only on this machine). |

`share(browser, options)` takes `interact` (`false` by default) and `expiresInMs` (1 hour by default).

## The viewer page

The page is served with `no-store`, `no-referrer`, `nosniff` and a Content Security Policy allowing nothing but its own
stream, its input endpoint and its nonce'd script and style. Frames arrive as an MJPEG stream
(`multipart/x-mixed-replace`). No page may frame it unless you list its origin in `frameAncestors`.

## Which browsers

Any browser with a `browser.cdp` endpoint: `mayura/browser/local`, `cdpBrowsers`, and most hosted providers, such as
[Browserbase](browser-browserbase.md), [Kernel](browser-kernel.md) or [Cloudflare Browser Run](browser-cloudflare.md).
Browsers whose CDP connection needs headers (Cloudflare, [BrowserView](browser-browserview.md)) work on Node and Bun as
is, and elsewhere with `webSocket`. [Browserless](browser-browserless.md) browsers cannot be joined, as each connection
starts a browser of its own: the viewer refuses them. Most hosted providers also give a live view of their own as
`browser.liveViewUrl`.

## Errors

| Code | When |
| --- | --- |
| `INVALID_CONFIG` | An option out of range; sharing a browser that cannot be joined (no `browser.cdp`), or after `close()`; listening beyond this machine without `remote: true`. |
| `INVALID_INPUT` | Sharing a browser that has ended; an input event that is not valid. |
| `LIMIT_EXCEEDED` | `maxShares` links are open: revoke one first. |
| `PERMISSION_DENIED` | `input()` on a screencast that is view only. |

Over HTTP, the viewer answers an unknown or expired link with 404, a link watched by `maxViewersPerShare` people
already, or too much input, with 429, input on a view-only link or from another site with 403, input that is not JSON
with 415, and a browser it cannot reach with 410.

## How it is tested

- Unit tests run the screencast and viewer against a fake CDP browser: frames asked for once taken and no faster than
  `maxFps`, oversized frames and frames of a tab no longer shown skipped, the end of a screencast with its browser or
  connection, input only with `interact`, links with secret tokens, MJPEG streams to a bounded number of viewers, links
  ended by revoke, expiry or the browser ending, input only as JSON from the viewer's page and bounded, and the Node
  server listening on this machine only unless told otherwise.
- Integration tests run it on the Chrome and Edge installed on the test machine: streaming the active tab and following
  the agent to another tab, a person using the page through an interactive link within the browser's origins, and the
  stream ending with the browser.
- It has not been run against a hosted browser yet.

## Related

- [Browsers](../guides/browsers.md): limits, origins, live views and `browser.cdp`.
- [Cloudflare Browser Run browsers](browser-cloudflare.md): a hosted browser a viewer can join.
- [Stagehand tools](browser-stagehand.md): another client that drives a browser alongside over `browser.cdp`.
