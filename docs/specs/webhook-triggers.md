# Authenticated webhook triggers

Status: implemented development preview. This contract is driver-free and has shared SQLite/PostgreSQL conformance plus an isolated packed custom-adapter consumer. It is not an HTTP server route, provider-specific signature adapter, or production security qualification.

## Contract

`mayura/workstream/webhooks` admits one bounded JSON request under an immutable trigger definition. A definition fixes its ID/version, secret reference, Standard Schema identity and dispatch callback. Schema identity is explicit because validator functions are trusted host code and cannot be derived portably.

The caller supplies verified Mayura scope, initialized aggregate storage, a trusted clock, and a secret resolver. The transport supplies raw body bytes, a bounded delivery ID, an integer Unix epoch timestamp and a lowercase `sha256=<hex>` signature. The signed message is the exact concatenation:

```text
<timestampMs>.<deliveryId>.<raw body bytes>
```

The runtime rejects malformed envelopes, bodies over the configured limit, timestamps outside the replay window, invalid HMAC-SHA256 signatures, invalid UTF-8/JSON and schema failures before durable admission or dispatch. Secrets must contain 16–4,096 bytes. The runtime copies and best-effort zeroes its copy after signing; the resolver retains ownership of its original buffer.

## Identity and recovery

The durable delivery identity is derived from scope, trigger ID and delivery ID. Its content digest binds the immutable definition identity and raw body digest, but not the timestamp, so an authenticated provider retry may carry a fresh timestamp and signature. Reusing the identity with different content fails with `CONFLICT`.

The state machine is finite:

```text
admitted -> dispatching -> succeeded
                       \-> outcome_unknown
```

A successful retry returns the persisted result without redispatch. A dispatch exception, timeout or invalid output commits `outcome_unknown`; it never authorizes replay. After a process failure, a trusted host explicitly calls `recoverAbandoned(id)` to turn a persisted `dispatching` record into `outcome_unknown`. A late in-process callback cannot replace that decision or disclose its output. Automatic scanning and background recovery are intentionally absent.

Callback timeouts do not release admission capacity until the underlying secret resolver or dispatch callback actually settles. Runtime closure prevents new calls but does not close application-owned storage or pretend to cancel non-cooperative callbacks.

## Security boundary

- Signature verification uses the raw bytes received from the transport and constant-work byte comparison.
- Secrets, parsed input and output are absent from events; events contain transition metadata only.
- Every stored snapshot is revalidated against scope, aggregate identity and definition hash before disclosure.
- The runtime provides authentication and replay deduplication, not caller authorization, TLS, rate limiting, provider IP policy, secret rotation orchestration or CSRF protection.
- A provider-specific adapter must map its canonical signature scheme into this contract only when the byte-level semantics match. It must not reinterpret an incompatible provider envelope as Mayura HMAC.

The host remains responsible for transport body limits, HTTPS, authorization to select the trigger/scope, secret management, bounded retention and operational recovery.
