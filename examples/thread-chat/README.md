# Thread chat: history and approvals end to end

A runnable React chat wired to Mayura's scoped HTTP routes, SQLite conversations/checkpoints/run records,
`MayuraThreadHistory`, and `MayuraRunApprovalControl`. No model API key or external service is needed.
The adapter is a deterministic demonstration, not a language model: every message proposes saving a local note.

From the repository root, with workspace dependencies installed:

```sh
pnpm build
node examples/thread-chat/server.mjs
```

Open the printed loopback URL. Send the prefilled message or write your own (up to 2,000 characters):

1. The message submits one run bound to the current thread. The composer locks while that turn is active.
2. A checkpoint-backed approval shows the exact proposed note, with an optional reason.
3. **Approve** writes the note into SQLite and resumes the same run. **Reject** resumes it without writing.
   **Cancel current run** ends a waiting run without executing the pending tool.
4. The finished turn appears in thread history: input, tool call, decision, released result, reply and outcome.
5. Send another message, start a new chat, or use the explicit history paging buttons.

Reload while approval is waiting: the page recovers the same thread/run and pending digest without submitting
another message or making a decision. **Reconnect / refresh** re-inspects the saved run and reopens observation.
A failed/conflicted approval stays locked until that explicit inspection creates a fresh controller. There are
no automatic command retries. If a send response is lost, **Retry last send** resubmits the same message and
idempotency key; this also works after reloading. Opening a saved uncertain submission does not retry its POST.

## Files

- `agent.mjs`: bounded schemas, deterministic history-capable model adapter, approval-required note tool and server options.
- `server.mjs`: Vite production build, loopback UI/API hosts, local authentication and shutdown cleanup.
- `session.js`: app-owned headless wiring, observation, recovery, exact send retries and disposal.
- `app.js`: React composition of history, approval controls and the composer. The application owns the expiry clock.
- `main.js`: explicit startup and page lifecycle policy; no transport work is hidden in the reusable components.
- `check.mjs`: offline build + approve/reject/cancel/reload smoke test using in-process Fetch and temporary SQLite.

```sh
node examples/thread-chat/check.mjs
pnpm vitest run packages/client-react/test/thread-chat-example.test.ts packages/server-node/test/conversation-options.test.ts
```

CI runs the smoke test. The React integration tests exercise actual components against the same API and session,
including a lost submission reply followed by explicit recovery with the original idempotency key. Tests use no
network, provider credentials or external effects.

## Persistence and local ports

By default the server chooses free UI/API ports and creates temporary SQLite data. Ctrl+C stops the listeners,
closes the store and removes temporary files. Page reloads preserve data while that process runs.

Set `MAYURA_CHAT_PORT` to keep the browser origin stable, and `MAYURA_CHAT_DATABASE` to retain SQLite data between
server restarts. For example, in PowerShell from the repository root:

```powershell
$env:MAYURA_CHAT_PORT = '5179'
$env:MAYURA_CHAT_DATABASE = './thread-chat.sqlite'
node examples/thread-chat/server.mjs
```

The supplied database is never deleted by cleanup. Keep both settings for restart recovery: browser storage is
bound to its UI origin. Saved approvals use the runtime's default 15-minute expiry. A trusted, fixed-scope host job scans
25 checkpoint metadata rows each second, applying expiry and repairing interrupted terminal recordings; shutdown
stops and drains that job before closing SQLite. The store journal prevents
multiple terminal turn recordings; the note tool also uses the run/call as its own effect idempotency key.

## Demo boundaries

This is a single-user loopback example. The page receives a fixed-scope, one-hour token from `/config.json`;
it is never printed or stored in browser storage. Host and Fetch Metadata checks protect that endpoint, API CORS
permits the UI origin, and assets use a restrictive Content Security Policy. Restart the process after token expiry.

Browser localStorage holds thread/run ids and the bounded in-flight message/idempotency key for reload recovery.
Messages are plaintext local demo data. If browser storage is disabled, the tab still works but reload recovery
is unavailable. A missing saved thread/run (for example after restarting with a temporary database at a fixed port)
can be detached with **Forget missing chat**; this clears only browser selection, not server data.

Production applications must supply real identity-provider authentication, scope-aware browser recovery storage,
a durable effect contract, retention policy and application-specific presentation. Closing the page disposes its
local observers; it does not implicitly cancel a server run or answer its approval. History and approval input
are rendered as text; no HTML, Markdown or model-supplied instructions are executed.

See [React bindings](../../docs/guides/react.md) and [server/client setup](../../docs/guides/server-and-client.md).
