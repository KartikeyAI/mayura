---
title: "Build an agent workspace with Mayura UI"
description: "Try Mayura 1.4 in Next.js, install editable React components with shadcn, and reconnect to a run without resubmitting it."
date: 2026-11-25
tags: Mayura 1.4, React, shadcn, AG-UI, approvals
---

Mayura 1.4 ships `AgentWorkspace`, a React 19 chat surface with searchable threads, run activity, cited replies,
artifacts and exact approval review. Start with the runnable Next.js example, or bring the workspace into an
existing React app and connect it to your own backend. [Try the interactive workspace preview](https://mayurajs.com/ui/chat-workspace/).

## Run the Next.js example

Clone v1.4.0 and run the example with Node 24.14.1 or a later supported 24.x version and pnpm 10.17.1.

```sh
git clone --branch v1.4.0 --single-branch https://github.com/KartikeyAI/mayura.git mayura-workspace
cd mayura-workspace
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm --filter mayura-nextjs-workspace-example dev
```

Open `http://127.0.0.1:4190`. The deterministic agent uses local SQLite in memory and needs no model API key.

1. Select **Summarize the release notes**. Refresh while the reply is streaming to reattach to the same run.
2. Open a citation to read the exact excerpt. The reply also includes a table, a runbook download and a checklist confirmation.
3. Start a new chat and select **Save the rollout checklist**. Review the proposed destination and contents, then approve or decline the exact write.

Use the [Next.js workspace guide](../../../docs/guides/nextjs.md#agent-workspace-example) to adapt this example.
For a CLI-generated notebook with a separate indexing worker, choose the [`nextjs` starter](choose-a-starter.md).

## Choose source or package

| Install path | Use it when |
| --- | --- |
| `shadcn add @mayura/chat-workspace` | You want copied components with inline Tailwind classes you can edit in your app. |
| `npm install @mayurajs/ui@1.4.0` | You want dependency-managed updates and render slots for the sidebar, composer and messages. |
| `shadcn add @mayura/reply-cards` | You already have a chat surface and want to render structured replies. |

For copied components, start from a React 19 app with Tailwind v4 and shadcn initialized. Add this entry to the
`registries` object in `components.json`.

```json
{
  "registries": {
    "@mayura": "https://mayurajs.com/r/{name}.json"
  }
}
```

```sh
pnpm dlx shadcn@latest add @mayura/chat-workspace
```

Import `AgentWorkspace` from `@/components/ui/mayura/agent-workspace` with the default UI alias. The command
merges theme tokens and scoped styles into the global stylesheet configured in `components.json`. Your app's Tailwind
build compiles the classes in the copied source. For the npm package's Tailwind entry point, use the
[global stylesheet setup](../../../docs/integrations/ui.md#npm-package). Both install paths work without the `mayura` package.

## Connect and authorize

`AgentWorkspace` takes an `AgUiTransport` from your app. Use the transport to manage credentials and connect to
a compatible event stream. If you use Mayura's experimental AG-UI adapter, enable `observe: true` and grant the
adapter `ag-ui:observe`. Implement `observeRun` using the authenticated GET for the saved thread and native run ID.
The response restores the transcript and any pending approval. A dropped connection or refresh can resume
observation without submitting a prompt, replaying a decision or dispatching a tool.

Keep identity, resource access, run budgets and permissions on the server. For tool writes, bind approval to the
exact pending call on the server. A reply-card confirmation is a UI callback. If it writes, authorize the action
and enforce idempotency at your own endpoint. Register custom card renderers and their payload parsers in trusted
app code, and allowlist same-origin download paths explicitly.

Follow [AG-UI reconnection](../../../docs/guides/ag-ui.md#reattach-to-an-existing-run),
[approval handling](../../../docs/guides/approvals-and-human-input.md) and the
[Mayura UI reference](../../../docs/integrations/ui.md#reply-cards) for the server and card contracts.
