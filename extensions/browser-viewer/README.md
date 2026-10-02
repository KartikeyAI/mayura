# @mayurajs/browser-viewer

A live viewer for `mayura/browser` browsers: a person watches what an agent's browser shows, and with a link that
allows it, uses it too. The active tab streams as JPEG frames over the browser's CDP connection (a screencast),
following the agent from tab to tab, to a page that needs nothing but an image tag. No dependency; any browser other
clients can join (local, `cdpBrowsers`, and most hosted providers), whatever its provider's own live view.

```bash
npm install mayura @mayurajs/browser-viewer
```

```ts
import { createBrowsers } from 'mayura/browser';
import { localBrowsers } from 'mayura/browser/local';
import { serveBrowserViewer } from '@mayurajs/browser-viewer';

const browsers = createBrowsers(localBrowsers(), { maxBrowsers: 1, maxLifetimeMs: 30 * 60_000, origins: ['https://example.com'] });
const browser = await browsers.open();
const viewer = await serveBrowserViewer();          // http://127.0.0.1:<port>/, this machine only
const link = await viewer.share(browser);           // view only, for an hour
console.log(link.url);                              // a secret: whoever has it can watch
const takeover = await viewer.share(browser, { interact: true, expiresInMs: 10 * 60_000 });
```

- **Nothing is shown unless shared.** `share(browser)` makes a link with a 256-bit token in it; it stops working when
  it expires (1 hour by default, at most 24), when `revoke()` is called, or when the browser ends, and whatever was
  being watched through it ends then too. Links are kept by the token's hash.
- **Watching is the default; using is opt-in.** With `interact: true` the page sends the person's clicks, scrolling,
  keys and pasted text to the browser, as input to the page shown. Everything the person does stays within the
  browser's origins, as everything the agent does. Input is only taken as JSON from the viewer's own page (never
  across sites), at most `maxInputPerSecond` (60) a link, 4 KiB each.
- **Bounded.** `maxViewersPerShare` (2) people watch a link at once, each over a CDP connection of their own;
  `maxShares` (16) links are open at once. Frames come no faster than `maxFps` (5), and only as fast as each viewer
  takes them; `quality` (60), `maxWidth` by `maxHeight` (1,280 by 800) and `maxFrameBytes` (2 MiB) bound their size.
- **The page** is served with `no-store`, `no-referrer` and a CSP allowing nothing but its own stream, input and
  nonce'd script; `frameAncestors` lets your app's origins show it in a frame (none by default).

## On your own server, on any runtime

`browserViewer(options)` is the same viewer as web-standard request handling: mount `handle(request)` under
`basePath` (it answers `<basePath>v/...` and returns undefined for anything else), and give people
`share(browser).path` on your origin. Behind your own authentication, the link's token is a second lock, not the
only one.

```ts
import { browserViewer } from '@mayurajs/browser-viewer';

const viewer = browserViewer({ basePath: '/viewer/', frameAncestors: ['https://app.example'] });
// In your fetch handler:
const response = await viewer.handle(request);
if (response) return response;
```

`serveBrowserViewer` (Node) listens on `127.0.0.1` unless given `host` with `remote: true`: links then travel in the
clear unless TLS is in front, and `publicUrl` (an https origin) is the address the links use.

## The screencast alone

`browserScreencast(browser, { interact })` gives the frames themselves, an async iterable of JPEGs with the page's
size and tab, and `input(event)` for interactive ones, to show them however you like.

## Browsers it cannot join

Each connection to Browserless starts a browser of its own, so its browsers give other clients no endpoint, and the
viewer refuses them. Most hosted providers also have a live view of their own, given as `browser.liveViewUrl`.

Options: `quality`, `maxWidth`, `maxHeight`, `maxFps`, `maxFrameBytes`, `webSocket`, `basePath`, `frameAncestors`,
`maxViewersPerShare`, `maxShares`, `maxInputPerSecond`; `serveBrowserViewer` adds `host`, `port`, `remote` and
`publicUrl`. Verified on the Chrome and Edge installed here. See the
[browser guide](https://mayurajs.com/docs/guides/browsers/). Apache-2.0.
