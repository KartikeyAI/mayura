# Hosted lifecycle coordinator

Status: explicit-start, single-flight format-5 fleet worker implemented.

`createWorkflowLifecycleHost` owns a lifecycle fleet runtime and repeatedly executes finite fleet pages against an explicit catalog of genuine definitions. Construction performs no work. `start()` begins the worker, `stop()` aborts its interruptible delay and drains the active cycle, and `close()` additionally closes the owned runtime without closing application-owned storage.

Every cycle has finite page, candidate and shard-read limits. Concurrent manual cycles are coalesced, so one host never overlaps fleet dispatch with itself. Successful full scans restart at the beginning of the sharded index on the next cycle. Failures expose only stable public error codes and use capped exponential backoff; no adapter exception, credential or workflow payload enters host status.

This worker advances format-5 fleet entries, including human, approval and timer suspension. It does not elect a distributed leader: deployments must run one active host per scope or provide external leader election. It also does not discover saga or loop parent aggregates; a composite parent coordinator remains required before M3 is complete across every new workflow format.
