# React reference components

Status: implemented experimental semantic component layer over the headless and workflow-view contracts. Unit/SSR and isolated package checks pass; live-browser, visual-regression, localization and assistive-technology qualification remain open.

`@mayura/client-react/components` exports four unstyled reference components:

- `MayuraRunSummary` subscribes once to a caller-owned run store and renders current status plus its bounded content-free activity list.
- `MayuraWorkflowGraph` renders the validated durable DAG as an ordered semantic list with status, dependencies, depth metadata and terminal progress.
- `MayuraHumanRequestCard` renders prompt/status text and, when actionable, an explicit button that emits only the request ID and digest to an application callback.
- `MayuraHumanResponseForm` renders finite native controls from a genuine schema-bound definition and emits an immutable typed request/digest-bound submission only from its explicit form event.

Mounting or server-rendering does not inspect, observe, retry, cancel, respond, authorize or create timers. Commands remain explicit application event handlers. Prompts and identifiers are passed as React text children; the components never use raw HTML. Invalid labels fail with `INVALID_COMPONENT_PROPS`. No renderer, CSS system, icon library, server, runtime, workflow executor or storage package is shipped in the component closure.

The component subpath intentionally exposes React types, unlike the hook-only root entry. Its isolated type profile installs exactly the adapter, base client, React, `@types/react` and `csstype`. React DOM remains a maintainer test dependency and is not shipped.

The response form is uncontrolled: response content remains in browser controls until submit and is not mirrored into framework state. It never sends the response. Definitions and draft validation come from the dependency-free [`@mayura/client/forms`](human-response-forms.md) boundary.

These components are a secure semantic baseline, not a branded design system. Loading/command feedback, localization, right-to-left layout, nested child expansion, keyboard/screen-reader matrix testing and visual regression remain required before a general UI qualification claim.
