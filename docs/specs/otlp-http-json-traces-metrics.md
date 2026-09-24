# OTLP/HTTP JSON traces and metrics

Status: experimental optional metadata-only exporters. Deterministic protocol/unit and isolated packed-consumer evidence exist; collector/backend interoperability and semantic-quality evaluation remain open.

## Boundary

`@mayura/exporter-otlp` exports three independent factories for OTLP/HTTP JSON logs, traces and metrics. Each requires an explicit signal-specific endpoint, service identity, transport bounds and optional explicit headers. Imports and construction perform no network work. HTTPS is mandatory except for explicitly enabled literal `127.0.0.1`/`::1` development endpoints. No environment variables, ambient credentials, redirects, cookies, automatic discovery or retries are used.

The trace exporter accepts completed metadata-only spans with exact nonzero lowercase hexadecimal trace/span IDs, optional distinct parent ID, stable operation name, unsigned 64-bit decimal nanosecond boundaries, status and optional bounded run ID. It emits internal spans only. Arbitrary attributes, events, links, exception text, prompts, messages, tool arguments/results and code are not part of this contract.

The metric exporter accepts a fixed low-cardinality Mayura metric-name catalog, nonnegative finite values, unsigned 64-bit decimal times and optional bounded run/profile/status dimensions. Gauges cannot carry sum fields. Sums require a start time and explicit monotonicity and use cumulative aggregation. Points sharing a metric identity are grouped; one batch cannot change that identity's aggregation kind or monotonicity. User-defined names, labels and raw strings are rejected.

The wire format follows the stable [OTLP 1.11 protocol](https://opentelemetry.io/docs/specs/otlp/), including `/v1/traces` and `/v1/metrics`, lower-camel Protobuf JSON fields, decimal 64-bit values and signal-specific partial-success counts. Shapes follow the canonical [OpenTelemetry Protocol definitions](https://github.com/open-telemetry/opentelemetry-proto). This package deliberately implements `http/json`, not gRPC or binary Protobuf.

## Delivery semantics

Each exporter is single-flight and bounded by record count, encoded request bytes, streamed response bytes and deadline. HTTP 200 with an empty or bounded JSON response is success. `rejectedSpans` and `rejectedDataPoints` are validated against the sent count and accounted separately; partial success is never retried. Invalid counts, hostile/oversized bodies and non-200 responses fail with safe errors that do not reflect collector content.

Cancellation and close abort local waiting, but cannot prove that a collector did not receive a transmitted request. Inspection exposes immutable exact accepted/dropped/partial/failure/timeout/cancellation/byte counters and never endpoint headers. Telemetry remains optional and cannot authorize, block, cancel or change execution. Durable audit and compliance evidence require a separate mandatory persistence path.

## Limitations

This slice does not create spans automatically from run events, propagate W3C context, sample, aggregate metrics across processes, persist queues, retry, export histograms/exemplars, adopt unstable GenAI semantic conventions or qualify a collector/backend. Applications construct the narrow records from already admitted native metadata. A later versioned mapper may automate that projection without widening this public privacy boundary.
