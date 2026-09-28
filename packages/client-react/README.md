# mayura/client-react

Optional React 18.3/19 hooks over `mayura/client/headless`, `mayura/client/forms` and `mayura/client/workflows`. The package exposes `useMayuraRun`, `useMayuraRunActions`, `useMayuraHumanRequest`, `useMayuraHumanResponseCommand`, `useMayuraRunActivity`, `useMayuraWorkflowGraph` and `useMayuraWorkflowCommand`.

The caller owns and disposes the headless store. Hooks never refresh, observe, cancel or create timers automatically; an explicit `observe()` follows the run to its end and reconnects dropped streams by itself (the state shows `reconnecting`). Call actions from explicit event/effect policy in the application. One shared store means multiple React consumers reuse the same bounded state and transport observation.

`useMayuraWorkflowCommand` subscribes to a caller-owned explicit controller without reading or mutating on mount. Conflict and ambiguous-failure reconciliation remain application decisions.

React is a peer dependency. Public Mayura declarations expose only Mayura types, so the framework does not install or export a second React type universe.

The separate `mayura/client-react/components` subpath provides unstyled semantic run-summary, durable-workflow, human-request, schema-driven response-form, workflow pause and fleet hold components. It exposes React types by design, performs no implicit I/O and emits response intent only from an explicit button or form event. The response form is uncontrolled, validates against `mayura/client/forms`, and returns a typed request/digest-bound submission to the application without sending it. Passing the controller state renders safe pending/success/conflict/failure feedback and locks stale submissions.
