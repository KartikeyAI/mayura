# @mayurajs/browser-agent-browser

Vercel Labs' [agent-browser](https://github.com/vercel-labs/agent-browser) command line as tools on a `mayura/browser`
browser: the agent reads pages as agent-browser snapshots with `@e` refs and acts on them, while the browser's origins,
lifetime and limits still hold. Node only; no dependency of its own.

```bash
npm install mayura @mayurajs/browser-agent-browser
npm install -g agent-browser   # the command line itself (Apache-2.0)
```

```ts
import { createBrowsers } from 'mayura/browser';
import { localBrowsers } from 'mayura/browser/local';
import { agentBrowserTools } from '@mayurajs/browser-agent-browser';

const browsers = createBrowsers(localBrowsers(), { maxBrowsers: 1, maxLifetimeMs: 30 * 60_000, origins: ['https://example.com'] });
const browser = await browsers.open();
await browser.goto('https://example.com/');
const tools = agentBrowserTools(browser, { act: true });
// agent.read (agent-browser:agent:read) and agent.act (agent-browser:agent:act).
```

| Tool | Commands | Permission | Option |
| --- | --- | --- | --- |
| `<name>.read` | `snapshot` (`-i`, `-c`, `-d <n>`, `-s <selector>`), `get text\|html\|value\|attr\|title\|url\|count\|box`, `is visible\|enabled\|checked` | `agent-browser:<name>:read` | always |
| `<name>.act` | `click`, `dblclick`, `fill`, `type`, `press`, `hover`, `focus`, `check`, `uncheck`, `select`, `scroll`, `scrollintoview`, `wait` | `agent-browser:<name>:act` | `act: true` |
| `<name>.eval` | `eval` | `agent-browser:<name>:evaluate` | `evaluate: true` |

- **Only these commands run**, with only the flags listed; no argument may start with `-` otherwise. Nothing that
  writes files, reaches credentials, cookies or the network setup, or starts other servers is available, and
  navigation stays with the browser's own `goto` (and `browserTools`), which keeps to its origins: agent-browser's
  `read <url>` fetches from this machine directly, outside the browser, and its `open` did not complete over CDP in
  testing (0.38.2 on Windows).
- The command line runs without a shell, driving the browser over `browser.cdp`, in an agent-browser session of its
  own per browser so refs from a snapshot hold for the next command. The session is closed once its browser has
  ended (on the next call). Results leave out agent-browser's bookkeeping and are bounded (`maxResultBytes`); what
  agent-browser could not do comes back as `{ ok: false, error }`.
- It works with browsers that are Mayura's alone and whose CDP connection needs no headers (not BrowserView or
  Cloudflare, nor Browserless, whose every connection is a browser of its own, nor a browser shared through
  `cdpBrowsers`).
- Options: `name` (`agent`), `cli` (`['agent-browser']`), `act`, `evaluate`, `timeoutMs` (60 s), `maxResultBytes`.

Verified with agent-browser 0.38.2 against the Chrome installed here. See the
[browser guide](https://mayurajs.com/docs/guides/browsers/). Apache-2.0.
