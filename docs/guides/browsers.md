---
title: "Browsers"
description: "Real browsers for agents to read and use web pages in, on the Chrome or Edge installed here or a hosted browser service, kept to the origins you allow, with permission-gated tools."
---

`mayura/browser` lets an agent use a real browser: open pages, read them, click, type and choose, take screenshots.
It speaks the Chrome DevTools Protocol itself, with no dependency. The Chrome or Edge installed on your machine is built
in (`mayura/browser/local`), any browser with a CDP endpoint can be reached (`cdpBrowsers`), and hosted browser
services come as `@mayurajs/browser-*` packages. Every browser has a lifetime, and its pages load only from the origins
you allow.

```ts
import { createBrowsers } from 'mayura/browser';
import { localBrowsers } from 'mayura/browser/local';

const browsers = createBrowsers(localBrowsers(), {
  maxBrowsers: 2,
  maxLifetimeMs: 30 * 60_000,
  origins: ['https://example.com', 'https://*.example.com'],
});

const browser = await browsers.open();
try {
  await browser.goto('https://example.com/');
  const page = await browser.snapshot();
  console.log(page.text);
  // - heading "Example Domain"
  // - link "Learn more" [ref=e1]
  await browser.click('e1');
} finally {
  await browser.release();
}
```

## Limits

`createBrowsers(provider, options)` holds every browser from a provider to the same limits.

| Option | Notes |
| --- | --- |
| `maxBrowsers` | Required. The most browsers open at once, counting those opening; more fail with `LIMIT_EXCEEDED`. |
| `maxLifetimeMs` | Required. The longest a browser may live; at most the provider's. |
| `origins` | Required. The origins pages may load from, or `'all'`. See [Origins](#origins). |
| `maxTabs` | The most tabs a browser may have open; 8 by default. |
| `callTimeoutMs` | How long one call other than a navigation may take; 30 s by default. |
| `navigationTimeoutMs` | How long a navigation waits for its page to load; 30 s by default. A page still loading is returned with `loaded: false`. |
| `maxTextBytes` | The most bytes of a snapshot, of page text or of an evaluated value; 256 KiB by default. |
| `maxScreenshotBytes` | The largest screenshot; 8 MiB by default. |
| `viewport` | The window size pages are laid out for; 1280 × 800 by default. |
| `labels` | Labels given to every browser, to find sessions in the provider's console. |
| `webSocket` | Opens the CDP WebSocket, for runtimes whose `WebSocket` cannot send headers. |

`browsers.close()` releases every browser still open and opens no more.

## Origins

Nothing is allowed by default: `origins` lists what pages may load from, as `https://example.com` (scheme, host and
port), `https://*.example.com` (its subdomains, not `example.com` itself) or `http://127.0.0.1:8080`. `'all'` allows
every http(s) URL.

The list is enforced in the browser, not only at `goto`. Every request is checked before it leaves — navigations,
redirects, frames, scripts, images, `fetch`, and requests from dedicated, shared and service workers — and one to
another origin fails as blocked. Each new page, frame or worker is held until its requests are checked; one that
cannot be checked never runs. `goto` to another origin, or a navigation redirected to one, fails with
`PERMISSION_DENIED`.

Downloads are refused, file pickers stay closed, and dialogs (`alert`, `confirm`, `prompt`) are dismissed and reported
in the next snapshot.

## A browser

`browsers.open(options)` takes `lifetimeMs`, `labels` and `signal`. The browser ends when its lifetime is over, if
`release()` did not end it first; after that every call fails with a `BrowserError` whose `reason` is `gone`. Calls on
one browser run one at a time, in order.

| Method | Notes |
| --- | --- |
| `goto(url)` | Opens a page in the current tab. Returns its `url`, `title`, `status` and whether it `loaded`. |
| `back()`, `forward()`, `reload()` | Move through the tab's history. |
| `snapshot()` | The page as an outline: one line per meaningful element, indented by depth. Elements to act on carry `[ref=eN]`; refs from earlier snapshots stop working. Also reports dialogs the page opened. |
| `text({ ref })` | The visible text of the page, or of one element. |
| `click(ref, { double })`, `hover(ref)` | Point at an element by its ref. |
| `fill(ref, text)` | Replaces the text of an input or editable element, as typing would. |
| `press(keys)` | Presses a key on what has focus: `Enter`, `Tab`, `ArrowDown`, `a`, `Control+a`, `Shift+Tab`. |
| `select(ref, option)` | Chooses an option of a list by its value or label. |
| `scroll(dy, { ref })` | Scrolls the page, or an element, by `dy` pixels. |
| `screenshot({ fullPage })` | A PNG of the visible page, or all of it. |
| `evaluate(expression)` | Runs JavaScript in the page; returns `{ value }` as JSON, or `{ error }` with what it threw. |
| `tabs()`, `newTab(url)`, `selectTab(tab)`, `closeTab(tab)` | Tabs, including windows a page opens. |
| `release()` | Ends the browser. |

`liveViewUrl` is where a person can watch, on providers with a live view. It may carry a token: treat it as a secret.

## Tools

`browserTools(browser, options)` gives an agent the browser as tools named after `options.name`. Navigating and
reading are on; the rest are each off until enabled, and each needs its permission.

| Tools | Permission | Option |
| --- | --- | --- |
| `<name>.goto`, `<name>.back`, `<name>.snapshot`, `<name>.text` | `browser:<name>:read` | always |
| `<name>.click`, `.fill`, `.press`, `.select`, `.hover`, `.scroll`, `.tab` | `browser:<name>:act` | `act: true` |
| `<name>.screenshot` | `browser:<name>:read` | `screenshot: true` |
| `<name>.evaluate` | `browser:<name>:evaluate` | `evaluate: true` |

Navigations and actions return a fresh snapshot (`snapshotAfter`, true by default), so the model sees what changed.
A mistake the model can put right — an origin that is not allowed, a ref from an older snapshot, an option that is not
there — comes back as the tool's result, `{ error, message }`, so it can try again; a failure of the browser itself
fails the call. `callCostMicros` charges each navigation and action to the run's budget.

```ts
import { browserPerRun, browserTools } from 'mayura/browser';

const perRun = browserPerRun(browsers);
const tools = browserTools(perRun.source, { name: 'web', act: true });
// Release each run's browser when it ends:
// defineHook({ id: 'browser.release', version: '1', stage: 'onFinally', handler: (_event, context) => perRun.release(context.runId) })
```

## A browser you already run

`cdpBrowsers({ endpoint, headers })` reaches any browser with a CDP endpoint: a `ws(s)://` URL, or `http://host:port`
(asked for its WebSocket URL), such as a Chrome started with `--remote-debugging-port`. Each browser opened there is a
new browser context, closed on release; the browser's other tabs are left alone.

## Providers

| Package | Browsers | Live view |
| --- | --- | --- |
| `mayura/browser/local` | The Chrome, Chromium or Edge installed here, one process with a new profile per browser; Node | no |
| `cdpBrowsers` (in `mayura/browser`) | Any browser with a CDP endpoint, in a context of its own | no |
| `@mayurajs/browser-browserbase` | [Browserbase](https://docs.browserbase.com) sessions; captchas, recording and logs off | debugger view |
| `@mayurajs/browser-steel` | [Steel](https://docs.steel.dev) sessions, which outlive their connection: release them | session viewer, view-only by default |
| `@mayurajs/browser-hyperbrowser` | [Hyperbrowser](https://hyperbrowser.ai/docs) sessions; proxies, stealth, captchas and recording off | live view, view-only by default |
| `@mayurajs/browser-browserless` | [Browserless](https://docs.browserless.io), hosted or your own: a fresh browser per connection | no |
| `@mayurajs/browser-kernel` | [Kernel](https://www.kernel.sh/docs) browsers, deleted soon after nothing is connected; stealth (and its captcha solver) off | live view, view-only by default |
| `@mayurajs/browser-browser-use` | [Browser Use Cloud](https://docs.browser-use.com/cloud/browser/quickstart) browsers, which outlive their connection; no proxy, no captcha solving | only with `liveView: true` |
| `@mayurajs/browser-anchor` | [Anchor Browser](https://docs.anchorbrowser.io) sessions; recording and ad blocking off | live view, view-only by default |

`localBrowsers({ channel, executablePath, headless, args })` finds Chrome (`channel: 'chrome'`, the default) or Edge
(`'edge'`) in the usual install places, or runs `executablePath`. Nothing is downloaded. Each browser runs headless with
its own profile in a temporary directory, removed on release. `args` adds switches; ones that would open the browser
to others (remote debugging, profiles, extensions, proxies, the sandbox) are refused.

## Writing a provider

A provider is `{ id, features: { liveView }, maxLifetimeMs, create(spec, { signal }) }`. `create` starts a browser and
returns `{ id, cdp: { url, headers }, liveViewUrl, isolate, release }`: `cdp.url` is the browser's CDP WebSocket,
`release` ends it (a `BrowserError` with reason `gone` counts as released), and `isolate` asks for a browser context
of its own in a browser shared with others. `browserHttpFailure(status)` and `browserResponseFailure(response)` turn
HTTP failures into a `BrowserError` without the provider's text.

`browserConformance` from `mayura/browser/testing` holds the cases every provider must pass, against the pages in
`browserFixturePages` served on two origins — `serveBrowserFixtures()` from `mayura/browser/local` serves them on this
machine.
