# Mayura Agent Workspace for Next.js

Run this workspace from the repository root.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm --filter mayura-nextjs-workspace-example dev
```

Open [the workspace](http://127.0.0.1:4190/). The local agent uses a deterministic model and an
in-memory SQLite database. It needs no provider credentials.

1. Choose **Summarize the release notes**. Refresh as the reply streams. The URL preserves the thread ID and
   the workspace observes the same native run. Open a citation to inspect its exact excerpt.
2. Inspect the rollout table, download the runbook or mark the checklist reviewed in the current browser view.
3. Start a new chat and choose **Save the rollout checklist**. Review the destination and exact contents,
   then approve or decline. The native Mayura approval binds the decision to the reviewed tool input.

Next.js loads Tailwind and the Mayura theme through `app/global.css`. The client supplies a same-origin
AG-UI transport. The server route keeps the fixture credential server-side, and conversation state
lasts for the local server process. When adapting this example for deployment, provide application
authentication, durable storage, and trusted server-side configuration for identities, quotas and tool permissions.

Build and test the production server locally.

```sh
pnpm --filter mayura-nextjs-workspace-example build
pnpm --filter mayura-nextjs-workspace-example test
```
