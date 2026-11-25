# Mayura UI with AG-UI

A runnable example that imports **@mayurajs/ui**, its compiled Tailwind stylesheet, and its AG-UI hook. The same
composer starts in the center of an empty chat and moves below the transcript once a conversation begins.

From the repository root, install workspace dependencies and build Mayura, then run the preview:

~~~sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm --filter mayura-ui-ag-ui-example dev
~~~

Open [http://127.0.0.1:4180/](http://127.0.0.1:4180/). The **Preview states** controls load a fresh thread and send
a fixture prompt when a state requires one. On narrow screens, open the sidebar from the header.
Set `MAYURA_UI_EXAMPLE_PORT` to use a different loopback port.

| State | Try it |
| --- | --- |
| Empty composer | Select **Empty composer**, type a message or choose a suggested prompt. |
| Streaming with citations | Select **Streaming with citations**. Open an inline citation or a source under the answer to inspect its exact excerpt and location. Expand **Run activity** to see the streamed steps. |
| Rich reply | Select **Rich reply**, then open an artifact to inspect a chart, play local video or audio, or review an HTTPS resource. |
| Paused for approval | Select **Paused for approval**. Review the full new-document diff and its destination, then approve or decline. Expand **Review exact tool input** for the arguments. The same run resumes and reports the tool result in its activity. |

The activity row follows the latest turn and retains its timeline across approval and resume. An interrupted step
remains visible as interrupted. A completed tool proposal is still waiting for a decision until a matching result arrives.

Artifacts and sources share an inspector beside the conversation on desktop and a full-screen sheet on smaller
screens. Press Escape or use **Close inspector** to return to the control that opened it.

Search **Thread history** by title to reopen one of the latest 60 conversations. A pending approval reopens its
original request when it is still available. Finish or stop the current run before switching threads.

Use the reply actions to copy text, add an editable quote to a follow-up, or mark a reply helpful or unhelpful.
Feedback stays in the browser. **Retry reply** starts a new turn for the latest reply when its original turn
used no tools. Earlier replies and tool outcomes stay in the thread history.

Use **Attach** or drop up to three text, Markdown, CSV or JSON files of at most 64 KB each onto the composer.
Only a bounded excerpt from each selected file is included as context in the text sent to the local agent.
**Record a voice note** captures up to 30 seconds for local preview and playback.

**Voice conversation** requires a browser with an installed on-device English (US) recognition pack and a local
English speech synthesis voice. Microphone access begins after the user chooses **Talk** or **Record**. Voice
conversation sends the recognized text through AG-UI and reads the settled reply aloud. The AG-UI request never
includes microphone audio.

The browser consumes the actual Mayura AG-UI SSE protocol. The loopback server uses a deterministic model, guarded
text, typed artifact and source state, and a local SQLite approval flow. The save tool writes only into the in-memory demo workspace.
Conversation and approval data disappear when the server stops. No credentials, inference services or paid calls are required.

The example owns its shell in `src/app.tsx` and its local transport in `src/demo-ag-ui.ts`. The reusable components,
hook, and theme are in `extensions/ui`. The [design language](DESIGN.md) records the layout and interaction rules.
Use `pnpm --filter mayura-ui-ag-ui-example build` to produce the browser bundle and
`pnpm --filter mayura-ui-ag-ui-example preview` to serve it with the same local fixture API.
