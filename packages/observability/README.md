# @mayura/observability

Experimental, metadata-only local run observation. Subscribe explicitly to authorized run handles, inspect bounded immutable status/counter/cost snapshots, and retain explicit gap/unknown evidence. No prompt, tool result, credential, automatic child traversal, ambient collection, or default export destination is included.

Optional sinks receive strictly validated metadata through bounded isolated delivery. Disconnecting or closing an observer never cancels a run. This package depends only on core and does not implement OpenTelemetry or required durable audit.

See [native observability](../../docs/specs/native-observability.md) for event allowlists, bounds, delivery failure handling, and limitations.
