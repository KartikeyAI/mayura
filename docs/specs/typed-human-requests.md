# Typed durable human requests

Status: implemented experimental WorkStream profile plus authenticated server/browser/CLI wire contract. The driver-free API, SQLite conformance and optional PostgreSQL conformance exist; headless UI and workflow-node integration remain separate work.

## Public contract

`createHumanWorkStream` is exported from `mayura/workstream/humans`. The application supplies an initialized aggregate store, verified scope, a dedicated stream ID, a trusted clock and an authorization callback. The facade owns neither the store nor authentication.

Each request declares a stable ID, `information`, `correction` or `plan_selection` kind, bounded human-facing prompt, Standard Schema response validator, application-owned schema ID and lowercase SHA-256 schema digest. Optional JSON context is persisted and therefore must already be safe for the authorized reviewer. Corrections must bind the exact candidate or artifact through `subjectDigest`; other request kinds cannot carry one. A deadline is an absolute Unix epoch millisecond value.

The schema implementation is trusted code and is not serialized. The schema digest pins its separately managed contract across deployment and restart. Reopening a request requires the exact persisted metadata and schema identity. Reusing an ID with any changed prompt, context, kind, subject, deadline or schema identity fails closed.

## Durable protocol

Request creation first writes immutable, domain-separated digest-bound metadata as an idempotent signal, then registers a single durable response wait. This ordering deliberately tolerates a crash between the two steps: an exact retry recreates the missing wait, and event-before-registration matching prevents a lost response. No live promise, model call, thread, worker, transaction or sandbox is retained while waiting.

Responses use one deterministic signal identity per request. Concurrent different answers cannot both commit: the first aggregate transition wins and later different content conflicts. An exact same command, actor and schema-normalized value is idempotent. A stale different response to an answered request conflicts rather than pretending it was accepted. Cancellation and deadline transitions remain terminal and never add a response signal.

The public snapshot is immutable and contains safe request metadata plus either no response or the admitted value, verified actor ID, command ID and response digest. It never stores authentication credentials, claims or roles. Audit events contain only signal/wait IDs, sequence, deadline and disposal metadata; the bounded journal retains request and response values until its owning retention policy removes the entire stream.

## Trust and authorization boundary

The caller must authenticate the human and pass only the verified actor ID. The configured callback authorizes that actor against the immutable request and current application policy. Callback rejection, exception and timeout all become a safe `PERMISSION_DENIED`; no response is stored. The callback receives an `AbortSignal`, is bounded to at most 30 seconds and must not treat abort as proof that its own external effects stopped.

Standard Schema validation and JSON normalization happen after authorization and before persistence. Validator details and rejected values are not reflected through public errors. The response is re-bound to the request digest and independently hashed before storage. Correction is a new validated response attached to the exact subject digest; it does not rewrite an earlier tool candidate, approval, artifact or execution record. The application must create and revalidate any new operational candidate separately.

`inspect`, `cancel` and deadline sweeping are trusted application operations. Exposing them through HTTP, CLI, MCP or a UI requires the same scoped authentication and authorization as any other control API. WorkStream scope separation is storage isolation, not user authentication.

## Bounds and limitations

This profile inherits the WorkStream aggregate limits: 256 retained signals, 128 waits, 4 KiB per signal value and 1 MiB total state. Human request/response envelopes are further capped at 3.5 KiB and identifiers at 80 simple characters. It is intentionally finite; a normalized high-volume request store requires a future format and migration.

Deadlines use a trusted synchronized application clock. Request creation and response submission actively sweep an already-due request; applications must also schedule bounded `sweepDeadlines` calls for unattended expiry. A committed response wins only if it reaches the aggregate before a committed cancellation/timeout transition.

The optional server adapter exposes bounded list/inspect/respond callbacks without importing WorkStream or a SQL driver. Separate `humans:read` and `humans:respond` capabilities apply; the verified principal ID is the response actor and cannot be supplied by the browser. The browser-safe client validates immutable metadata and submits the request digest with every response. The application adapter must map verified scope/agent visibility to its registered durable definitions and call the WorkStream API, which remains the authority for schema validation, request binding, deadline and first-response semantics.

The CLI uses the same routes and authority split. Credentials arrive only through piped stdin; response content comes from a bounded explicit JSON file and is never echoed in command output.

This slice does not yet provide pause/resume workflow nodes, batch approval grants, notifications or headless UI components. Existing exact-action workflow approvals remain their own stricter execution-authority contract; human information and correction responses never grant tool authority.

## Evidence

The shared SQLite/PostgreSQL suite covers immutable typed responses, schema transformation, restart, exact-definition recovery, concurrent responders, exact retries, authorization denial/timeout, safe errors, correction subject binding, cancellation, deadline sweeping, late answers, scope separation and zero persistence from malformed input. The isolated offline packed consumer proves that the public subpath works with a custom driver-free aggregate adapter and cannot import SQL/runtime packages.
