---
title: "Build chat that remembers and asks before it acts"
description: "Follow the V1.2 notebook from a scoped thread to an exact note approval, a saved outcome and a separate indexing workflow."
date: 2026-10-23
tags: threads, approvals, chat, recovery
---

A conversation is more than a message array in a browser. It needs a verified owner, persistent history, a record
of the actions taken, and a way to recover when a response disappears. Mayura's V1.2 notebook connects those pieces
with a deterministic note agent so you can inspect the entire flow without paid inference.

## Run the complete flow

Choose a framework in the [starter guide](choose-a-starter.md). For Next.js:

```sh
npx mayura@1.2.0 init --starter nextjs --directory ./notes --apply
cd notes
npm install
npm run setup
npm run dev
```

Connect at port 3000 with the local token from `.data/login-token`. Start `npm run worker` in another terminal.
Submit a note and stop at the approval control. The proposed input is the action being reviewed, not merely a
description of what an agent might do.

## What gets persisted

The server verifies the session, fixes the principal and project, and admits the message into that scope's thread.
The thread/run association is recorded before execution. An approval checkpoint retains the conversation,
remaining work and budget so resumption does not require the original server process.

Approval binds the run, call, tool version, exact input and expiry. The authenticated actor supplies the decision.
Reject the call and the fixture must not save the note. Approve it and the tool's saved result becomes part of the
turn. A separate durable workflow handles indexing with its own permissions.

Read [threads](../../../docs/guides/threads.md) and
[approvals](../../../docs/guides/approvals-and-human-input.md) for the host configuration and API contracts.

## Handle a lost response

Keep the original input and idempotency key for an uncertain submission. Inspect the saved run before choosing
an explicit recovery action. Reconnecting an observer must not submit another message or make an approval decision.
A reload can restore thread selection after the credential is re-entered; it does not prove an uncertain effect failed.

If a note was saved but scheduling its index job is unconfirmed, reconcile the job using that note's identity.
Repeating the note write creates another business action; it is not an indexing repair.

## Keep long histories bounded

Thread history preserves whole turns. [Compaction](../../../docs/guides/threads.md) stages a bounded summary with
source/model/cost provenance and only publishes it after the captured command is still valid. A retry can publish
an already staged summary without paying for another model call. Retained summaries are untrusted data for later
model context, not new instructions or permissions.

## Make the application yours

Customize [React copy-in controls](../../../docs/guides/copy-in-ui.md), or use
[headless stores](../../../docs/guides/react.md) with native Svelte/Vue views. Replace the demonstration identity
before adding customers and qualify the rendered approval flow on your target browser. The
[framework guide](../../../docs/guides/framework-starters.md) explains storage, workers and deployment boundaries.
