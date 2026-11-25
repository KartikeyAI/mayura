---
title: "Mayura UI"
description: "Use standalone Tailwind React components with a backend of your choice or connect them to Mayura through AG-UI."
package: "@mayurajs/ui"
area: "ui"
---

`@mayurajs/ui` is a standalone React 19 component library. It includes the composer,
thread and activity views, approvals and exact change review, citations, artifact inspectors, and reply
actions. Its compiled Tailwind stylesheet is scoped to `UiRoot`, so applications can use it with any CSS build.

```bash
npm install @mayurajs/ui react@19 react-dom@19
```

```tsx
import { Composer, UiRoot } from '@mayurajs/ui';
import { useAgUiConversation, type AgUiTransport } from '@mayurajs/ui/ag-ui';
import '@mayurajs/ui/styles.css';

export function ChatComposer({ transport }: { transport: AgUiTransport }) {
  const chat = useAgUiConversation({ transport });
  return (
    <UiRoot>
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

Use the components with data and callbacks from your application. For streaming, `@mayurajs/ui/ag-ui`
exports `AgUiRunInput`, `AgUiEvent`, and the conversation hook together. Supply a scoped transport
from your application. It owns the AG-UI endpoint, session credentials, and
optional history and cancellation requests. Mounting the hook starts no run. Bind approval decisions to
the current interrupt and keep the server responsible for authorizing the exact tool call. Media artifacts
load only from the exact local paths you allow. Keep browser credentials out of client bundles.

Install a compatible `mayura` version when your server uses the Mayura adapter. The repository example
at `examples/ui-ag-ui-prototype` runs that adapter with a deterministic
agent, so you can exercise approval, history, and artifact controls without provider credentials.

Existing [copy-in components](../guides/copy-in-ui.md) still install through `mayura add ui`.

## shadcn registry

To own the React source in your project, add the Mayura namespace to the `registries` object in
your shadcn `components.json`.

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
pnpm dlx shadcn@latest add @mayura/composer @mayura/thread-history
```

The registry also provides `reply`, `artifacts`, `approvals`, `ag-ui`, and `run-activity`. Each item
includes its source dependencies, `UiRoot`, and the scoped stylesheet. The files go into a
`mayura` subdirectory under your configured UI alias. For example, with the default Vite aliases
and the full library installed, import the composer and stylesheet as follows.

```js
import { Composer, UiRoot } from '@/components/ui/mayura';
import '@/components/ui/mayura/styles.css';
```

If you install only the composer, import it from `@/components/ui/mayura/composer` and import
`UiRoot` from `@/components/ui/mayura/ui-root`. Import the stylesheet once at your app entry.
These are source files for a React 19 app. Connect them to your own backend or use the copied
AG-UI hook with a compatible transport.
