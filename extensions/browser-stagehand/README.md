# @mayurajs/browser-stagehand

[Stagehand](https://docs.stagehand.dev/v3)'s natural-language browser automation as tools on a `mayura/browser`
browser: `extract` (what a page says), `observe` (what can be done on it) and `act` (do what an instruction says).
Stagehand drives the same browser over its CDP endpoint, so the browser's origins, lifetime and limits still hold.

```bash
npm install mayura @mayurajs/browser-stagehand @browserbasehq/stagehand@3
```

```ts
import { createBrowsers } from 'mayura/browser';
import { localBrowsers } from 'mayura/browser/local';
import { stagehandTools } from '@mayurajs/browser-stagehand';

const browsers = createBrowsers(localBrowsers(), { maxBrowsers: 1, maxLifetimeMs: 30 * 60_000, origins: ['https://example.com'] });
const browser = await browsers.open();
const tools = stagehandTools(browser, { model: { modelName: 'openai/gpt-5-mini', apiKey }, act: true });
// stagehand.extract and stagehand.observe (stagehand:stagehand:read), stagehand.act (stagehand:stagehand:act).
```

| Tool | Permission | Option |
| --- | --- | --- |
| `<name>.extract`: what the page says about something, as text | `stagehand:<name>:read` | always |
| `<name>.observe`: the elements and actions matching an instruction | `stagehand:<name>:read` | always |
| `<name>.act`: do what an instruction says, such as "click sign in" | `stagehand:<name>:act` | `act: true` |

- **Stagehand 3 is a peer you install yourself** (3.7.3 or a later 3.x; Stagehand 4 loads a Chrome extension that
  hosted browsers cannot take). It is loaded when first needed. Node only, as Stagehand is.
- One Stagehand per browser, attached when a tool first needs it, on the browser's active tab. It is kept alive:
  closing it leaves the browser to Mayura, which ends it with its lifetime or release.
- Stagehand calls its own model, outside Mayura: give `model` with its key (nothing is read from the environment), and
  `costMicros` to charge each call to the run's budget. Results are bounded (`maxResultBytes`, 64 KiB).
- It works with browsers that are Mayura's alone and whose CDP connection needs no headers: local, Browserbase, Steel,
  Hyperbrowser, Browserless, Kernel, Browser Use, Anchor and Firecrawl browsers; not BrowserView or Cloudflare
  (headers), nor a browser shared through `cdpBrowsers`, where Stagehand could act on others' pages.
- `source` may be a browser, or a function giving the run's browser, as `browserPerRun(...).source`.
- Options: `name` (`stagehand`), `model`, `act`, `timeoutMs` (120 s), `maxResultBytes`, `costMicros`, `stagehand` (the
  class, to give your own import).

See the [browser guide](https://mayurajs.com/docs/guides/browsers/). Apache-2.0.
