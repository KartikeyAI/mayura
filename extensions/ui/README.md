# @mayurajs/ui

Standalone React 19 components for agent chat. Compose messages, inspect citations and media, review exact tool input,
show run activity, and reopen threads. Your application supplies data and callbacks.

```sh
npm install @mayurajs/ui react@19 react-dom@19
```

```tsx
import { Composer, UiRoot } from '@mayurajs/ui';
import { useAgUiConversation, type AgUiTransport } from '@mayurajs/ui/ag-ui';
import '@mayurajs/ui/styles.css';

export function ChatComposer({ transport }: { transport: AgUiTransport }) {
  const chat = useAgUiConversation({ transport });
  return (
    <UiRoot theme="light">
      <Composer
        onSend={chat.send}
        onStop={chat.stop}
        streaming={chat.status === 'streaming'}
        disabled={!['idle', 'streaming', 'complete'].includes(chat.status)}
      />
    </UiRoot>
  );
}
```

The hook and the `AgUiRunInput` and `AgUiEvent` types are available from `@mayurajs/ui/ag-ui`.
The transport's `run(input, signal)` method submits AG-UI input to your server and returns the SSE response.
Provide optional `cancel`, `listThreads`, and `readThread` callbacks when your server supports them.
Keep session credentials, permission checks, and tool execution in your application. The hook sends an approval
decision with the current interrupt ID and does not retry the decision. For inline change review, render a
validated projection of the same arguments in `ApprovalCard`; the raw input is always available.

The stylesheet includes compiled Tailwind utilities and is scoped to `UiRoot`. For dark mode, set
`theme="dark"` on the root. Artifact audio, video, captions, and posters need exact same-origin paths in the
host's `mediaPaths` allowlist. The host can opt into a stored-answer projection for structured model output.

Mayura is an optional peer. Install it when running the Mayura adapter on your server. The
[local AG-UI example](https://github.com/KartikeyAI/mayura/tree/main/examples/ui-ag-ui-prototype)
shows that integration for streaming, approvals, and thread recovery.
The source-owned `mayura add ui` registry remains available.

## Install source with shadcn

Add `"@mayura": "https://mayurajs.com/r/{name}.json"` to the `registries` object in `components.json`.
Run `pnpm dlx shadcn@latest add @mayura/ui` for the full library, or choose `composer`, `thread-history`,
`reply`, `artifacts`, `approvals`, `ag-ui`, or `run-activity` under the same namespace.

The files go into `mayura/` under your configured UI directory. Import its `styles.css` once and wrap the
components in the copied `UiRoot`. The TypeScript source and scoped CSS are owned by your React application.
