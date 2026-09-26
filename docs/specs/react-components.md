# React reference components

Status: implemented experimental semantic component layer over the headless and workflow-view contracts. Unit/SSR and isolated package checks pass, and the pause controls have live-browser keyboard and accessibility-tree qualification in one Chromium-based browser (below). Visual-regression, localization, screen-reader and cross-browser qualification remain open.

`@mayura/client-react/components` exports six unstyled reference components:

- `MayuraRunSummary` subscribes once to a caller-owned run store and renders current status plus its bounded content-free activity list.
- `MayuraWorkflowGraph` renders the validated durable DAG as an ordered semantic list with status, dependencies, depth metadata and terminal progress.
- `MayuraHumanRequestCard` renders prompt/status text and, when actionable, an explicit button that emits only the request ID and digest to an application callback.
- `MayuraHumanResponseForm` renders finite native controls from a genuine schema-bound definition and emits an immutable typed request/digest-bound submission only from its explicit form event.
- `MayuraWorkflowPauseControl` announces run status and command feedback in a polite live region and renders one native button that toggles between pause (running/waiting) and resume (paused), emitting only `{ runId, revision }` to the application. An optional `subject` gives each button a distinct accessible name (for example "Pause workflow for run 7d2ddd96").
- `MayuraFleetHoldControl` announces the durable fleet hold and requires a two-step confirmation, described by a warning, before emitting hold intent; release is a single step.

Mounting or server-rendering does not inspect, observe, retry, cancel, respond, authorize or create timers. Commands remain explicit application event handlers. Prompts and identifiers are passed as React text children; the components never use raw HTML. Invalid labels fail with `INVALID_COMPONENT_PROPS`. No renderer, CSS system, icon library, server, runtime, workflow executor or storage package is shipped in the component closure.

The component subpath intentionally exposes React types, unlike the hook-only root entry. Its isolated type profile installs exactly the adapter, base client, React, `@types/react` and `csstype`. React DOM remains a maintainer test dependency and is not shipped.

The response form is uncontrolled: response content remains in browser controls until submit and is not mirrored into framework state. It never sends the response. Definitions, draft validation and optional single-flight command state come from the dependency-free [`@mayura/client/forms`](human-response-forms.md) boundary. Bound command state supplies safe status text and locks submitting, succeeded, conflict or disposed requests.

These components are a secure semantic baseline, not a branded design system. Loading/command feedback, localization, right-to-left layout, nested child expansion, keyboard/screen-reader matrix testing and visual regression remain required before a general UI qualification claim.

## Pause-control qualification

While a command is in flight both controls set `aria-busy` on their region and `aria-disabled` (not `disabled`) on the button, and the click handler enforces the lock; a disabled focused button would drop keyboard focus to the page body. Command feedback is shown only while the command state refers to the displayed revision (or is still submitting), so a later change by another operator or a fleet sweep never leaves stale "Resume requested" text beside a paused run. Unknown outcomes say so explicitly and ask for a refresh before retrying. The fleet control keeps one stable primary button across hold and release and returns focus to it when the confirmation closes.

The live qualification used the [pause console example](../../examples/pause-console/README.md) (real SQLite lifecycle fleet, lifecycle host with the durable hold, authenticated loopback API) in the Chromium-based browser embedded in the Claude desktop app on Windows, driven only by keyboard events (focus, Enter, Space, Tab) and inspected through the accessibility tree and live DOM. Verified: pausing and resuming waiting runs; a paused not-yet-started run never dispatching its effect across host cycles; an in-flight run refusing pause with an explained conflict; hold with cancel and confirm; the sweep pausing only unpaused runs and the release sweep resuming only those, leaving an individually paused run paused; focus retained on the acting control in every path; and labelled regions, status roles and distinct button names in the accessibility tree.

The live run found four defects, each fixed with a regression test: a server CORS preflight rejection of paginated reads such as `GET /v1/workflow-runs?limit=50` (the preflight is now validated as the request it announces, so query credentials are still refused); identical button names across runs; stale command feedback after a newer revision; and focus falling to the page body after the fleet confirmation closed or the hold state flipped. Not yet qualified: pixel/visual regression (screenshots were unavailable in this environment), NVDA/JAWS/VoiceOver announcements, Firefox/Safari, touch, high-contrast and reduced-motion modes, localization and right-to-left layout.

