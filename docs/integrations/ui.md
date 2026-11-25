---
title: "Mayura UI"
description: "Use standalone Tailwind React components with a backend of your choice or connect them to Mayura through AG-UI."
package: "@mayurajs/ui"
area: "ui"
---

`@mayurajs/ui` is a standalone React 19 component library. It includes the composer,
thread and activity views, approvals and exact change review, citations, artifact inspectors, and reply
actions. The components use Tailwind v4 utility classes and shared theme tokens scoped to `UiRoot`.
The website's UI gallery at `/ui/` has interactive previews, installation commands, and API examples for each registry item.

## npm package

Agent Workspace, reply cards, read-only AG-UI reconnection, and the Tailwind stylesheet export require
`@mayurajs/ui` v1.4. Use the [shadcn registry](#shadcn-registry) to install the workspace as source.

```bash
npm install @mayurajs/ui@1.4 react@19 react-dom@19
```

In a Tailwind v4 app, add the Mayura import after Tailwind in your global stylesheet. It supplies the shared
theme and registers the package source for utility scanning.

```css
@import "tailwindcss";
@import "@mayurajs/ui/tailwind.css";
```

For other CSS toolchains, import the compiled fallback `@mayurajs/ui/styles.css` once at your app entry.

### Compiled CSS for existing components

Apps on v1.3 can use the compiled stylesheet with the composer, thread history, citations, artifacts, and approvals.

```bash
npm install @mayurajs/ui@1.3 react@19 react-dom@19
```

Import the compiled stylesheet once at your app entry and wrap the components in `UiRoot`.

```js
import '@mayurajs/ui/styles.css';
```

## Agent Workspace

Pass your transport to `AgentWorkspace` for the assembled chat, with thread history, run activity,
citations, artifacts and approvals. It includes its own `UiRoot`.

```tsx
'use client';

import { AgentWorkspace } from '@mayurajs/ui';
import type { AgUiTransport } from '@mayurajs/ui/ag-ui';

export function SupportWorkspace({ transport }: { transport: AgUiTransport }) {
  return (
    <AgentWorkspace transport={transport} title="Support" suggestions={['Find the release checklist']} />
  );
}
```

Use `renderSidebar`, `renderComposer` or `renderMessage` to replace a surface. Pass a saved thread ID
as `initialThreadId` and persist subsequent IDs through `onThreadChange`. Set `theme="dark"` for a dark
surface or set `--mayura-workspace-height` on the root class to embed a shorter workspace.
Mount it with a new React key when the authenticated user or workspace changes, so the previous
session's rendered state is discarded.

For individual components, compose within `UiRoot` and provide your own data and callbacks. For streaming, `@mayurajs/ui/ag-ui`
exports `AgUiRunInput`, `AgUiEvent`, and the conversation hook together. Supply a scoped transport
from your application. It owns the AG-UI endpoint, session credentials, and
optional history, cancellation and observation requests. Mounting the hook starts no run. Bind approval decisions to
the current interrupt and keep the server responsible for authorizing the exact tool call. Media artifacts
load only from the exact local paths you allow. Keep browser credentials out of client bundles.

When `observeRun` is available, the hook can attach to a busy thread whose authorized history includes
`activeRunId`. It also attempts one read-only reattach after a dropped stream when it knows the run ID.
The transport sends a fresh authoritative message snapshot and the run's current outcome. See
[read-only AG-UI observation](../guides/ag-ui.md#reattach-to-an-existing-run) for the Mayura route.

Use `mayura` v1.4 when your server uses the Mayura adapter's read-only observation route. The repository example
at `examples/ui-ag-ui-prototype` runs that adapter with a deterministic
agent, so you can exercise approval, history, and artifact controls without provider credentials.
The [Next.js guide](../guides/nextjs.md#agent-workspace-example) links to the runnable workspace example.

The Mayura CLI’s [copy-in components](../guides/copy-in-ui.md) use the bundled `mayura add ui` registry and its own `ui.css`.

## Reply cards

Send `replyCards` in the authorized AG-UI state. Each card provides an `id`, `type`, `title`, and
`data` payload. Workspace displays cards on the current reply. For a standalone view, validate a payload
with `readReplyCards` and pass the result to `ReplyCards`.

| Card | Data |
| --- | --- |
| `table` | `columns` and `rows` of text, numbers, booleans or null cells |
| `download` | `path` from the app's exact same-origin `downloadPaths` allowlist, plus an optional `filename` |
| `confirmation` | `message` and `actionId`. The app registers the card/action pair and supplies its exact label and description. |

Use `defineReplyCard` to register a trusted React renderer with a parser for its data.
Confirmation calls the host's `onConfirm` only after user interaction. The host must authorize any
resulting write and enforce idempotency at its own endpoint.

## shadcn registry

In a React 19 app with Tailwind v4 and shadcn initialized, add the Mayura namespace to the `registries`
object in your `components.json`.

```json
{
  "registries": {
    "@mayura": "https://mayurajs.com/r/{name}.json"
  }
}
```

Install the full library or select individual items.

```sh
pnpm dlx shadcn@latest add @mayura/ui
pnpm dlx shadcn@latest add @mayura/chat-workspace
pnpm dlx shadcn@latest add @mayura/composer @mayura/thread-history
```

The registry also provides `reply`, `reply-cards`, `artifacts`, `approvals`, `ag-ui`, and `run-activity`. Each item installs
its React source and dependencies, including `UiRoot`, in a `mayura` subdirectory under your configured UI alias.
The command merges the shared Tailwind theme and scoped styles into the app stylesheet configured in `components.json`.
Your Tailwind build compiles the inline utility classes. With the full library and the default Vite aliases, use these imports.

```js
import { Composer, UiRoot } from '@/components/ui/mayura';
```

If you install only the composer, import it from `@/components/ui/mayura/composer` and import
`UiRoot` from `@/components/ui/mayura/ui-root`. Wrap the copied components in `UiRoot`.
For the workspace recipe, import `AgentWorkspace` from `@/components/ui/mayura/agent-workspace`.
Supply your own handlers or connect the copied AG-UI hook to a compatible transport.
