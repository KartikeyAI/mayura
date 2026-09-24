# Workflow lifecycle fleet discovery

Status: implemented over the public aggregate-store contract.

`createWorkflowLifecycleFleetRuntime` wraps the format-5 runtime with a durable, scope-bound discovery index. The index is divided into 256 shards by the first byte of the run ID. Each shard is an independently versioned aggregate with bounded compare-and-swap retries and at most 256 active runs by default. Terminal runs are removed from the active index without deleting their workflow aggregate or audit events.

`scan` examines a finite number of entries and shard reads. Its cursor binds the format, scope hash, shard number and last examined run ID. It is continuation metadata, not an authorization capability or a stable database snapshot.

`runPage` accepts a finite catalog of genuine local definitions. It advances running executions and waiting executions whose `nextWakeAtMs` is due. Future or indefinite waits are reported as deferred. Unknown definition digests are reported as skipped and never executed. Per-run failures are sanitized and do not prevent a later candidate in the page from being considered.

The wrapper confirms the index update before returning from submission or a state-changing command. Aggregate creation and index mutation are separate compare-and-swap records because the base adapter does not promise multi-aggregate transactions. A crash between them can leave a created run absent from discovery; retrying the same stable submission repairs the index. Applications requiring strict atomic fleet enrollment must select a future adapter capability that explicitly promises it rather than assuming cross-record atomicity.

The runtime starts no background process. A host invokes `runPage` on its own bounded schedule and persists the returned cursor if it wants incremental sweeps. A full sweep always terminates after at most 256 shard reads.
