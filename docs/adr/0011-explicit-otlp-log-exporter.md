# ADR 0011: Keep OTLP export explicit, optional and downstream of metadata admission

Status: accepted for the experimental logs adapter.

## Decision

Mayura ships `@mayura/exporter-otlp` separately from the runtime and native observer. It exports only the observer's strictly admitted metadata events using OTLP/HTTP JSON logs. The application must configure the endpoint, identity, credentials and transport policy explicitly. The adapter has no ambient configuration, discovery, retry or import-time activity.

The exporter depends on the observer's public metadata snapshot validator instead of duplicating its privacy schema. It owns bounded wire conversion and delivery accounting, while the observer continues to own local run summaries and sink isolation. Remote export remains optional and can never substitute for mandatory durable audit.

## Consequences

The base SDK closure and no-default-phone-home package set do not gain a network dependency. Applications can connect any collector with ordinary Fetch semantics and inspect exact accepted/dropped counters. Partial OTLP success is visible without misrepresenting observer callback completion.

The first adapter supports logs and JSON only. It deliberately does not claim traces, metrics, binary Protobuf, gRPC, durable retry queues or collector/backend certification. Those require separate designs and release-gate evidence.
