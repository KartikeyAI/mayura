---
title: "Run your first agent approval in Next.js"
description: "Run Mayura’s local Next.js starter, review the exact note an agent wants to save, and recover a pending approval after reload. No model API key required."
date: 2026-11-26
tags: Next.js, TypeScript, approvals, starters
---

Send a note, inspect the exact text the agent proposes to save, and choose whether the write happens. The Next.js starter uses a scripted model and saves its data to local SQLite.

## Run the starter

Use Node 24.14.1 or a later 24.x release. From a directory where you can create a fresh project, run:

```sh
npx mayura@1.4.1 init --starter nextjs --directory ./my-notebook --apply
cd my-notebook
npm install
npm run setup
npm run dev
```

Open [localhost:3000](http://localhost:3000). Open `.data/login-token` locally, paste its value into **Session token**, and select **Connect**. Setup creates this private local credential. Keep `.env` and `.data` out of source control.

In a second terminal inside `my-notebook`, run `npm run worker` to process the indexing job after approval.

## Approve one note and reject another

1. Select **Send message** with the sample note, “Remember to send the release notes.” Under **Review before saving**, check that the `notes.save` input contains that exact text.
2. Reload while the run is waiting. Re-enter the same session token. The same proposal reappears without resending the note.
3. Select **Approve**. The reply says “Saved after your approval. Indexing is queued.” The worker can now index the saved note.
4. Send a different note and select **Reject**. The rejected proposal appears in the conversation, and its note stays unsaved.

The conversation is stored in `.data/notebook.sqlite`. For another recovery check, stop and restart `npm run dev` while a proposal is waiting, then reconnect with the same session token. Select **Refresh conversations** if you need to find the thread. To check the save and reject behavior in code, run `npm test` in the generated project.

## Adapt the tool to your app

In `server/application.mjs`, find `notes.save`. Try writing the approved note to a test store of your own. Keep the typed `text` input, `approval: 'required'`, and the run-and-call idempotency key so a repeated decision cannot create a second note. Run the approve and reject cases again after the change.

Follow the [Next.js starter guide](../../../docs/guides/nextjs.md) when you’re ready to connect your app’s identity and storage. For streaming, citations, and editable React components, try the [Agent Workspace example](agent-workspace.md).
