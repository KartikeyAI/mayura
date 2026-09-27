# OTLP/HTTP JSON log exporter

Status: experimental optional adapter. This specification covers logs; traces and metrics are qualified separately in [OTLP/HTTP JSON traces and metrics](otlp-http-json-traces-metrics.md).

## Boundary

`mayura/exporter-otlp` adapts the strict metadata events admitted by `mayura/observability` into an OTLP `ExportLogsServiceRequest`. The exporter reuses the observer's validator at the final network boundary. Prompts, messages, model/provider payloads, tool arguments/results, source code, arbitrary exceptions and nested application metadata are outside that validator and cannot be encoded by this adapter.

The package requires a complete explicit endpoint and service name. It reads no OTLP environment variables, discovers no credentials and has no default destination. HTTPS is required. An application may explicitly enable plain HTTP only for literal `127.0.0.1` or `::1` collector endpoints. URL credentials, query strings, fragments, redirects, cookies and user-controlled transport headers are rejected. Import and construction perform no network activity.

The adapter emits OTLP/HTTP JSON with `Content-Type: application/json`, lower-camel Protobuf field names and decimal strings for 64-bit values. Each Mayura event becomes one log record. The canonical event timestamp becomes `timeUnixNano`; the event type is the string body; the run identifier, sequence and validated scalar metadata become `mayura.*` attributes. `service.name` and optional `service.version` are resource attributes. Gap and non-success completion events receive conservative warning/error severity without inventing trace/span identity.

The wire shape follows the stable [OTLP specification](https://opentelemetry.io/docs/specs/otlp/), the [OTLP exporter configuration contract](https://opentelemetry.io/docs/specs/otel/protocol/exporter/) and the canonical [`ExportLogsServiceRequest` schema](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/collector/logs/v1/logs_service.proto). Mayura intentionally supports `http/json` only in this first adapter; binary Protobuf and gRPC are not claimed.

## Delivery and failure semantics

Requests are single-flight and bounded by event count, encoded bytes, response bytes and deadline. The exporter does not retry. This avoids silently duplicating records and leaves retry/durable buffering policy to an explicitly deployed collector or application. Fetch uses manual redirect rejection, omitted credentials and no-store cache semantics. Configured headers are copied once and never appear in inspection or public errors.

Only HTTP 200 is a successful OTLP response. Empty successful bodies are accepted for collector compatibility. Non-empty bodies must be bounded JSON. `partialSuccess.rejectedLogRecords` is checked as a decimal nonnegative 64-bit-compatible integer no larger than the sent batch; rejected records are counted separately. Server messages and response bodies are never exposed. Invalid, failed, cancelled and timed-out batches have explicit dropped/failure counters. Counts remain exact beyond JavaScript's safe integer range.

The observer's `sinkDelivered` metric means its callback settled successfully, not that every remote record was accepted. `exporter.inspect()` is authoritative for this adapter's accepted/dropped/partial/failure counts. Optional export cannot authorize, block, cancel or change an agent run. `close()` aborts current export work and permanently rejects new calls.

## Non-goals

This is not durable audit, a disk-backed queue, exactly-once delivery, an OpenTelemetry SDK replacement, automatic collector discovery, TLS/PKI qualification or backend interoperability certification. An application requiring durable compliance evidence must persist that evidence through a separate mandatory audit path before effects are considered complete.

## Verification

Unit coverage includes no construction-time network activity, exact OTLP JSON shape, metadata revalidation, secret exclusion, unsafe endpoint/header rejection, explicit loopback development mode, request/response limits, exact partial rejection, hostile HTTP bodies, deadline/cancellation, uncooperative transport settlement, single-flight enforcement, immutable inspection and close. The offline packed-consumer profile installs the adapter with only core and observability, compiles its public types and executes a transport-injected partial-success round trip without ambient network access.
