# Human response forms

Status: implemented experimental browser-safe definition, validation and React reference form. Unit, DOM and isolated archive checks pass; this is not live assistive-technology, localization or production design-system qualification.

## Contract

`@mayura/client/forms` captures one finite form with an exact `schemaId` and SHA-256 `schemaDigest`. A definition contains 1–32 uniquely named fields. Supported kinds are text, textarea, number, integer, boolean and finite select. Labels, names, options, lengths and numeric ranges are bounded and copied into a deeply frozen definition. Accessors, unexpected fields, unsafe property names, duplicate names, invalid Unicode and unbounded configuration are rejected.

`validateHumanResponse` accepts only a genuine captured definition, a frozen authenticated `RemoteHumanRequest` in `waiting` state and a frozen exact-key draft. The request schema identity must equal the definition. It converts browser number strings to finite numbers, enforces safe integers/ranges, admits only declared select values, validates Unicode-scalar text length and rejects NUL/unpaired surrogate input. The returned value has a null prototype, is deeply immutable, and carries only the exact request ID and request digest needed for optimistic response submission.

The helper does not authorize, fetch, retry, persist or submit. The server remains authoritative for request state, actor/scope authorization, deadline and digest conflicts. A valid local submission can still become stale before the authenticated command reaches the server.

`createHumanResponseController` is an optional caller-owned external store around that command. Construction is inert. `submit()` accepts only a genuine validated submission bound to its request plus an explicit command ID. It permits one in-flight call, performs exactly one client command, owns a cancellation signal, sanitizes untrusted callback failures and publishes immutable `idle`, `submitting`, `succeeded`, `conflict`, `failed` or `disposed` state. HTTP 409/412 and a terminal non-answer response become conflict feedback. No automatic retry, refresh, command-ID generation or response-value retention occurs. `reset()` changes local presentation state only; it never repeats the command.

## React behavior

`MayuraHumanResponseForm` renders semantic native controls from a captured definition. Controls are uncontrolled: rendering and typing do not copy response content into framework state. The component reads `FormData`, validates and calls `onSubmit` only during an explicit submit event. It performs no network request. Resolved or locally expired requests disable the fieldset and omit the submit control. Prompts, labels and options are React text children; raw HTML is never interpreted.

`useMayuraHumanResponseCommand` subscribes to a caller-owned controller without starting work. Passing that state to `MayuraHumanResponseForm` renders bounded pending/success/conflict/failure text. Submitting, succeeded, conflict and disposed states lock the form. A failed state remains explicitly retryable so the application can choose a new or deliberately reused idempotency key according to its command policy.

The application owns command IDs, authenticated submission, pending/success/conflict feedback and any reset or navigation behavior. Remount with a stable React `key` when replacing a request or definition; do not reuse entered values across request digests.

## Limits

Definitions support flat scalar records only. Nested objects, arrays, files, rich text, conditional fields, application-specific async validation, localization catalogs and server-delivered executable schemas are intentionally excluded. Boolean `required` means the field must have a boolean value; `false` remains valid and is not an acceptance/consent assertion.
