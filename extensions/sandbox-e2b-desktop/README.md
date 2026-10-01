# @mayurajs/sandbox-e2b-desktop

[E2B Desktop](https://e2b.dev) sandboxes for `mayura/sandbox`: an E2B sandbox from the `desktop` template (Ubuntu
with Xfce, Chrome, Firefox, VS Code and LibreOffice), with a desktop agents can see and use.

```bash
npm install mayura @mayurajs/sandbox-e2b-desktop
```

```ts
import { createSandboxes, sandboxTools } from 'mayura/sandbox';
import { e2bDesktopSandboxes } from '@mayurajs/sandbox-e2b-desktop';

const sandboxes = createSandboxes(e2bDesktopSandboxes({ apiKey, liveView: 'view' }), { maxSandboxes: 2, maxLifetimeMs: 3_600_000 });
const computer = await sandboxes.create({ lifetimeMs: 1_800_000 });
const tools = sandboxTools(computer, { name: 'computer', exec: true, desktop: true });
console.log(await computer.desktop?.viewUrl()); // watch the agent work
```

- Everything `@mayurajs/sandbox-e2b` does, plus `desktop`: `screenshot` (PNG, with the pointer), `click`, `move`,
  `scroll`, `type`, `key` and `size`, done with `xdotool` and `scrot` inside the sandbox. Keys are written as
  `Enter`, `ctrl+c` or `cmd+l`.
- The X server and Xfce start when the sandbox is created, at `resolution` (1024 × 768) and `dpi` (96). A sandbox
  whose desktop does not start is released.
- `liveView`: `'off'` (the default), `'view'` or `'control'`. With a live view, `desktop.viewUrl()` starts VNC and
  noVNC once and returns a public URL on port 6080 carrying a random VNC password (8 characters, as VNC allows); with
  `'view'`, the VNC server refuses input. Anyone with the URL can watch, so treat it as a secret.
- Options: those of `e2bSandboxes`, with `template` defaulting to `desktop`.

See the [sandbox guide](https://mayurajs.com/docs/guides/sandboxes/). Apache-2.0.
