# @mayurajs/ui

Standalone React 19 components for agent chat. Compose messages, inspect citations and media, review exact tool input,
show run activity, and reopen threads. The components use Tailwind v4 utilities and your application supplies data and callbacks.

Agent Workspace, reply cards, read-only AG-UI reconnection, and the Tailwind stylesheet export require v1.4.

```sh
npm install @mayurajs/ui@1.4 react@19 react-dom@19
```

In a Tailwind v4 app, add the Mayura import after Tailwind in your global stylesheet. It loads the shared
theme and registers the package source for utility scanning.

```css
@import "tailwindcss";
@import "@mayurajs/ui/tailwind.css";
```

For other CSS toolchains, import the compiled fallback `@mayurajs/ui/styles.css` once at your app entry.

```tsx
'use client';

import { AgentWorkspace } from '@mayurajs/ui';
import type { AgUiTransport } from '@mayurajs/ui/ag-ui';

export function SupportChat({ transport }: { transport: AgUiTransport }) {
  return <AgentWorkspace transport={transport} title="Support" />;
}
```

Use the workspace's `renderSidebar`, `renderComposer` and `renderMessage` props to customize its surfaces.
An application can use its own reply widgets by registering typed renderers with `defineReplyCard`.
The built-in table, download and confirmation widgets read validated `replyCards` from AG-UI state.

The hook and the `AgUiRunInput` and `AgUiEvent` types are available from `@mayurajs/ui/ag-ui`.
The transport's `run(input, signal)` method submits AG-UI input to your server and returns the SSE response.
Provide optional `cancel`, `listThreads`, `readThread`, and `observeRun` callbacks when your server supports them.
For reattachment, pass the authorized thread's `activeRunId` through `readThread`. `observeRun` reads an
existing run from an authoritative snapshot and leaves submissions and approval decisions to `run`.
Keep session credentials, permission checks, and tool execution in your application. The hook sends an approval
decision with the current interrupt ID and does not retry the decision. For inline change review, render a
validated projection of the same arguments in `ApprovalCard`; the raw input is always available.

Wrap individual components in `UiRoot` to apply the scoped theme. `AgentWorkspace` includes its own root.
For dark mode, pass `theme="dark"` to the root or workspace.
Artifact audio, video, captions, and posters need exact same-origin paths in the
host's `mediaPaths` allowlist. The host can opt into a stored-answer projection for structured model output.

Mayura is an optional peer. Install it when running the Mayura adapter on your server. The
[local AG-UI example](https://github.com/KartikeyAI/mayura/tree/main/examples/ui-ag-ui-prototype)
shows that integration for streaming, approvals, and thread recovery. The
[Next.js workspace example](https://github.com/KartikeyAI/mayura/tree/main/examples/nextjs-agent-workspace)
uses App Router route handlers and Next.js's Tailwind build.
The Mayura CLI’s `mayura add ui` command copies the framework’s bundled React components and their own `ui.css`.

## Install source with shadcn

In a React 19 app with Tailwind v4 and shadcn initialized, add
`"@mayura": "https://mayurajs.com/r/{name}.json"` to the `registries` object in `components.json`.
Run `pnpm dlx shadcn@latest add @mayura/chat-workspace` for the workspace recipe,
`pnpm dlx shadcn@latest add @mayura/ui` for the full library, or choose `composer`, `thread-history`,
`reply`, `reply-cards`, `artifacts`, `approvals`, `ag-ui`, or `run-activity` under the same namespace.

The command copies React source with inline Tailwind utility classes into `mayura/` under your configured UI
directory. It merges the shared theme into the app stylesheet configured in `components.json`.
Wrap the components in the copied `UiRoot`.
