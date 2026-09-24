# Headless UI bindings

Status: dependency-free development preview. The contract is browser-safe and exercised from the isolated packed browser bundle. Optional React hooks are available separately; workflow graph projection, rendered components, approval forms, localization and visual/accessibility qualification remain M8 work.

`@mayura/client/headless` provides an explicit external store over an authenticated `RemoteRun`. Construction performs no network access. Applications explicitly call `refresh()`, `observe()` and `cancel()`; cancellation is sent once and is never retried after an ambiguous failure.

The store exposes immutable snapshots suitable for `useSyncExternalStore` and equivalent Vue/Svelte/DOM adapters. It records a bounded event tail, last sequence, stream-gap state, sanitized connection errors and model/tool/hook activity. Activity becomes unknown after a retention gap and returns to zero only after a validated terminal snapshot. One observer and one cancellation may be active; configurable event/subscriber limits prevent unbounded UI retention. Subscriber exceptions cannot interrupt transport processing.

`createRunActivityProjection()` turns the current immutable state into stable, content-free run/model/tool/hook timeline items. It exposes only bounded safe labels and sequences, marks gaps/truncated history incomplete, represents unmatched completion events explicitly and never leaves an operation active after the run terminates. It does not infer a workflow graph or recover missing private event content.

`dispose()` aborts store-owned reads/observation and makes further operations fail. It does not cancel the remote run. A caller must invoke `cancel()` separately and retain the result as potentially ambiguous when transport acknowledgement is unavailable.

`createHumanRequestView()` converts an immutable authenticated human-request record into text-only status/action metadata. It never interprets prompt markup and marks expired/resolved requests non-actionable. Rendering adapters must assign prompt/identifier values through text properties such as DOM `textContent`; this package is not an HTML sanitizer.

The headless layer is a presentation adapter, not an authorization or policy engine. The server remains authoritative for scope, request digest, response schema, deadlines and command deduplication.
