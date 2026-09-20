# Native metadata observability

Status: experimental optional `@mayura/observability` package; a bounded local run-event observer, not full plan section 18, mandatory audit, an OpenTelemetry exporter, or a hosted dashboard. Only core is a runtime dependency. Importing or constructing it performs no collection, network access, provider invocation, or credential lookup.

## API and lifecycle

`createObserver({maxRuns?,maxRecentEventsPerRun?,maxObservationMs?,maxSinkQueue?,sinkBatchSize?,sinkTimeoutMs?,sink?})` returns `observe(handle, {after?,signal?,durationMs?})`, `inspect(runId?)`, and `close()`.

`observe` starts one metadata subscription for an explicitly supplied `RunHandle` and immediately returns `{runId, done(), disconnect()}`. It never calls or reads `result`/`cancel`, discovers other runs, follows child handles, or collects ambient process state. The application must provide an authorized source; a structural handle/event is not authentication. A run permits one active subscription per observer and cannot reconnect while a previous source callback remains unsettled. Reconnecting defaults to the last accepted event cursor; explicit older cursors replay safely without double-counting accepted events. A source failure or disconnect does not change the run's last observed execution status.

Defaults: 128 lifetime runs, 64 recent events per run, 60-second subscription lifetime, 256 pending sink events, batches of 16, and a 5-second sink deadline. Configured bounds are positive finite integers; run/recent-event caps are at most 1,024 each, sink queue at most 16,384, batches at most 256, and timers within the host timer range. The run-table limit rejects a new run before subscribing; entries are not silently evicted. Per-run recent history evicts its oldest entries with an explicit counter while aggregate observed counters remain available. No unbounded per-tool/model label map is created.

Disconnection, caller signal, deadline, and `close` stop observation only. `done` returns a stable reason: terminal event, source end, disconnection, timeout, source failure, invalid event, or observer closure. Iterator cleanup is best-effort and detached from an uncooperative `return` promise. Pending `next` calls are raced against observer cancellation with rejection handlers retained. Natural iterator exhaustion does not invoke a redundant `return` callback. The reader yields periodically so an immediately resolving source does not starve deadlines. Trusted synchronous source/sink JavaScript cannot be hard-killed.

Inspection separates `active` observation from `sourcePending`: the latter is true while settlement of a dispatched iterator `next` or cleanup `return` callback is still outstanding. Timeout/disconnection does not release that ownership. At most one read and one cleanup callback can remain outstanding per admitted run; attempts to reconnect the same run ID, including through another handle, fail with `CONFLICT` until both settle. Together with the lifetime run cap this prevents repeated timeouts from accumulating an unbounded number of hung source callbacks. A permanently hung callback can therefore permanently prevent that run's reconnection in this observer.

`done` and `close` do not await those callbacks. Late success or failure only clears pending ownership; late event candidates are not admitted or exported, and already-returned observation results/snapshots remain immutable. `inspect` can show the newly cleared pending state even after closure, but closure never reopens admission. These bounds cover the callbacks invoked by the observer, not undisclosed background work that trusted source code starts independently.

## Event contract and privacy

Only bounded plain-JSON `RunEvent` envelopes with exact envelope keys, canonical UTC timestamps, positive safe-integer sequences, matching run identity, and the supported type-specific metadata are accepted. Event JSON is limited to 4 KiB. Unknown metadata is rejected, not copied into an exported event.

| Event | Supported metadata |
| --- | --- |
| `run.started` | `profile: ephemeral`; optional `rootId`, `parentId`, `agentId` |
| `model.started` | nonnegative `step`, positive `modelCall` |
| `model.completed` | nonnegative `step`, `response: final/tool_calls` |
| Managed `model.started` | `purpose: guardrail`, bounded `modelId`, `checkId`, `checkVersion`, `callId`, `boundary: input/output`, positive `modelCall`; no `step` |
| Managed `model.completed` | same guardrail identity/boundary metadata, `response: final`, `decision: allow/block`; no categories or `step` |
| `tool.started` | bounded `callId`, `toolId` |
| `tool.completed` | `callId`, `toolId`, terminal outcome `status`; optional paired `execution`/`disclosure` receipt fields |
| `run.completed` | terminal outcome `status`, exact `spentMicros`, nonnegative `reservedMicros` and `calls` |
| `events.gap` | positive inclusive `from`/`to`, where `to` equals event sequence |

Messages, inputs, tool arguments/results, code, system prompts, provider payloads, arbitrary error messages, and nested metadata are never part of this contract. Identifier labels must be bounded stable identifiers, not arbitrary prose; applications should use opaque IDs because syntactic validation cannot prove that an ID contains no sensitive information. Source, iterator, and sink exception text is never returned or forwarded. All inspection snapshots and sink batches are deep immutable copies.

## Counters, gaps, and uncertainty

Counters describe events actually observed, not inferred missing work. Sequence discontinuities and explicit source gaps retain bounded range evidence and exact missing-event counts. Duplicate/replayed sequences do not add execution counts or reenter the sink. Invalid events stop that subscription and add only a rejection count, never their content. A terminal status is learned only from `run.completed`; source end alone is not success. Inspection distinguishes last observed status, active observation, terminal evidence, and complete/partial/unknown history coverage.

Tool outcomes with unknown execution or `outcome_unknown` remain explicit unknown counts. Missing execution receipt fields are counted separately, not interpreted as `not_started` or free. Cost is the latest reported snapshot, including retained reservations and exact decimal-string spending beyond the safe-integer range; absence is unreported, not zero. Late provider settlement may occur after the runtime's final event, so this observer does not claim current invoice completeness or repair missing billing evidence.

Reported root/parent/agent IDs remain correlation metadata. The observer does not traverse an unobserved tree, authenticate ownership, or derive child authority. Root budgets already include descendants: per-run spending snapshots are never summed into an incorrect tree/global total. Aggregate event counts and large gap counts use exact integers, represented as numbers while safe and decimal strings thereafter.

## Optional sink isolation

The optional `sink(events, {signal})` receives only admitted immutable metadata batches. It is an explicitly configured trusted callback, not an implicit external destination. Delivery runs independently of subscription/inspection. A full pending queue drops new sink deliveries with a counter; native run summaries still update. There is at most one sink callback in flight and no automatic retry.

A rejected/thrown sink batch increments failure/dropped counters and later batches may continue. A timed-out callback disables the sink, discards its bounded pending queue, and is cooperatively aborted. No additional callback is started while the timed-out code may still be running. Late completion cannot mark a dropped batch delivered or reenable collection. `close` stops subscriptions, aborts delivery, and discards undelivered queued data without cancelling any run. Optional delivery failure never authorizes or blocks execution; this facility must not be substituted for required durable audit.

## Verification

Deterministic fake-handle/sink tests cover metadata-only reads, strict malformed/accessor rejection, identity isolation, receipt/cost uncertainty, replay/gap accounting, exact large counters, bounded run/recent/sink storage, sink errors/deadlines, cancelled pending reads, best-effort cleanup, same-run reconnect quarantine, independent late read/cleanup settlement, reentrant cleanup, tree labels without double-counted money, immutable snapshots, and no run cancellation. No provider, Docker, paid service, ambient telemetry, or OpenTelemetry claim is involved.
