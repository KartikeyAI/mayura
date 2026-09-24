# React bindings

Status: implemented experimental hook layer, locally qualified on 2026-09-24 with React 19.3.0. Rendered components, response forms, workflow graphs and live-browser accessibility remain separate work.

`@mayura/client-react` is an optional adapter over `@mayura/client/headless`. React is its only peer dependency; the Mayura client is its only runtime dependency. Core, runtime, server, storage and provider packages are not part of this browser closure.

## Contract

- `useMayuraRun(store)` subscribes through `useSyncExternalStore` and returns the immutable `HeadlessRunState`. Its server snapshot is the same inert local snapshot.
- `useMayuraRunActions(store)` returns stable `refresh`, `observe` and `cancel` references for explicit application event/effect policy.
- `useMayuraHumanRequest(request, nowMs)` derives text-only `HumanRequestView` metadata from immutable inputs.
- `useMayuraRunActivity(state)` memoizes the headless content-free timeline without adding a subscription.

Mounting or server-rendering a hook does not inspect a run, open SSE, retry, cancel, start a timer or persist credentials. The caller creates, owns and disposes the store. Multiple components should share that store when they need one observation stream.

Prompts and status labels remain data. Applications must render prompts through normal framework text interpolation, never `dangerouslySetInnerHTML`. These hooks do not authorize human responses, validate response values, sanitize HTML, schedule polling or implement a second policy engine.

## Failure and packaging boundaries

A structurally invalid store fails with `MayuraReactError` code `INVALID_REACT_STORE` before subscription. Store/network failures retain the bounded safe codes defined by the headless client.

Public declarations expose Mayura contracts, not React declaration types. The isolated archive profile installs exactly `@mayura/client-react`, `@mayura/client` and React, compiles without `@types/react`, denies unrelated runtime imports and executes without implicit network work. This proves the current package boundary, not compatibility with every renderer, React minor, bundler, browser or server-component environment.
