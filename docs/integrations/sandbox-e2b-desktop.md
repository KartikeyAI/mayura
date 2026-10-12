---
title: "E2B Desktop sandboxes"
description: "Give agents a Linux desktop they can see and use with @mayurajs/sandbox-e2b-desktop: setup, live view, options, network rules and errors."
package: "@mayurajs/sandbox-e2b-desktop"
vendor: "E2B"
logo: "e2b"
website: "https://e2b.dev"
area: "sandboxes"
---

[E2B](https://e2b.dev) runs each sandbox as a Firecracker microVM started from a template. `@mayurajs/sandbox-e2b-desktop`
starts sandboxes from E2B's `desktop` template (Ubuntu with Xfce, Chrome, Firefox, VS Code and LibreOffice) and gives
each one a `desktop` that agents can see and use through [`mayura/sandbox`](../guides/sandboxes.md): screenshots,
mouse and keyboard. It is built on [`@mayurajs/sandbox-e2b`](sandbox-e2b.md), which it installs, so everything that
package does applies here too. It talks to E2B with `fetch`: no E2B SDK, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/sandbox-e2b-desktop
```

## Credentials

The same E2B API key as for [E2B sandboxes](sandbox-e2b.md): create one in the [E2B dashboard](https://e2b.dev/dashboard)
under **API Keys**. The package reads nothing from the environment: pass the key in yourself, for example from
`E2B_API_KEY`.

## Use it

```ts
import { createSandboxes, sandboxTools } from 'mayura/sandbox';
import { e2bDesktopSandboxes } from '@mayurajs/sandbox-e2b-desktop';

const sandboxes = createSandboxes(e2bDesktopSandboxes({ apiKey: process.env.E2B_API_KEY ?? '', liveView: 'view' }), {
  maxSandboxes: 2,
  maxLifetimeMs: 3_600_000,
});

const computer = await sandboxes.create({ lifetimeMs: 1_800_000 });
console.log(await computer.desktop?.viewUrl()); // open it in a browser to watch the agent work

// Grant tool:computer.screenshot (and .click, .scroll, .type, .key) with sandbox:computer:desktop,
// and tool:computer.exec with sandbox:computer:exec; screenshot needs effect:read, the others effect:write.
const tools = sandboxTools(computer, { name: 'computer', exec: true, desktop: true });
```

The desktop tools return each screenshot to the model as an image. See [Tools for agents](../guides/sandboxes.md#tools-for-agents)
for every tool and its permission, and [Sandboxes](../guides/sandboxes.md) for the pool and per-run sandboxes.

## Options

Every option of [`e2bSandboxes`](sandbox-e2b.md#options) (`apiKey`, `template`, `workdir`, `maxLifetimeMs`, `apiUrl`,
`domain`, `fetch`), plus:

| Option | Default | Meaning |
| --- | --- | --- |
| `template` | `desktop` | The template sandboxes start from. It needs an X server, Xfce, `xdotool` and `scrot`, as E2B's `desktop` template has. |
| `resolution` | `[1024, 768]` | The screen size in pixels, from 320 × 240 to 7680 × 4320. |
| `dpi` | `96` | The screen's dots per inch, from 48 to 480. |
| `liveView` | `'off'` | A live view a person can open in a browser: `'off'`, `'view'` (watch only) or `'control'` (use the desktop too). |

## The desktop

When a sandbox is created, the package starts an X server (`Xvfb` on display `:0`) at your `resolution` and `dpi`,
waits for the screen, and starts Xfce. A sandbox whose desktop does not start is released, and `create` fails.

| Method | Does |
| --- | --- |
| `screenshot()` | A PNG of the screen, with the pointer, taken with `scrot`. The file is read back and removed. |
| `click(x, y)` | Clicks `left` (the default), `middle` or `right`; `double: true` clicks twice. |
| `move(x, y)` | Moves the pointer. |
| `scroll(x, y)` | Scrolls `dy` notches down (negative: up) and `dx` right (negative: left) at that point. |
| `type(text)` | Types the text, 50 characters at a time, as long strings typed at once drop characters. |
| `key(keys)` | Presses keys written as `Enter`, `ctrl+c`, `cmd+l` or `f5`. `cmd`, `meta` and `win` are the Super key. |
| `size()` | The screen's width and height. |
| `viewUrl()` | The live view's URL, or undefined when `liveView` is `'off'`. |

Every action runs `xdotool` inside the sandbox with its arguments passed as they are, never pasted into a shell line,
so text you type cannot run as a command. Your own
commands do not get the display: to start a program on the desktop, give it `DISPLAY`, for example
`exec(['sh', '-c', 'setsid nohup xfce4-terminal >/dev/null 2>&1 &'], { env: { DISPLAY: ':0' } })`.

## Live view

With `liveView` set to `'view'` or `'control'`, the first `desktop.viewUrl()` starts a VNC server and noVNC in the
sandbox, and later calls return the same URL. It is served publicly on port 6080, at
`https://6080-<sandbox id>.e2b.app/vnc.html?...`, and carries a random 8-character VNC password (the most VNC
allows). With `'view'`, the VNC server refuses input, so watchers cannot use the desktop.

Anyone with the URL can watch, so treat it as a secret. Port 6080 is kept for the live view: a sandbox that asks for it
in `ports` fails with `INVALID_INPUT`.

## Network and ports

The same as [E2B sandboxes](sandbox-e2b.md#network-and-ports):

- **`'none'`** turns internet access off.
- **`'all'`** turns it on.
- **`{ allow: [domains] }`** allows those domains on ports 80 and 443 only, and denies everything else.

Ports you list are served publicly at `https://<port>-<sandbox id>.e2b.app`. With a live view, port 6080 is added to
them.

## Commands and files

As for [E2B sandboxes](sandbox-e2b.md#commands-and-files): commands run through `sh`, and a timeout or cancellation
sends `SIGKILL` to the command and every process it started. Files move through E2B's file API, and reads stop at the
size you allow.

## Errors

Failures reach you as a `SandboxError` with a `reason`, mapped from E2B's answers as for
[E2B sandboxes](sandbox-e2b.md#errors). The desktop adds:

| `reason` | When |
| --- | --- |
| `rejected` | A desktop action's command failed, or the desktop did not start when the sandbox was created. |
| `timeout` | A desktop action's command did not finish in time. |
| `invalid_response` | The screen size or screenshot was not what `xdotool` and `scrot` produce. |

A `resolution`, `dpi` or `liveView` out of range fails with `INVALID_CONFIG` when you call `e2bDesktopSandboxes()`,
before anything is sent.

## How it is tested

- Unit tests run the package against a fake E2B API that checks the X server's start, each `xdotool` command and its
  arguments, the screenshot's removal, the release of a sandbox whose desktop did not start, and the live view's
  password and URL.
- A live check against E2B, `scripts/live/sandbox-e2b-desktop.mjs`, starts the desktop, takes a screenshot, types into a
  terminal and opens the live view: it passed on October 6, 2026.

## Related

- [Sandboxes](../guides/sandboxes.md): pools, per-run sandboxes, tools and network rules.
- [E2B sandboxes](sandbox-e2b.md): the package this one builds on.
- [Daytona sandboxes](sandbox-daytona.md): another provider with a desktop.
