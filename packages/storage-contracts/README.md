# mayura/storage-contracts

Driver-free aggregate, scheduler, workflow and optional durable-budget contracts for trusted custom adapter authors. Depends only on core; no connections, filesystem access or environment lookup on import.

Select the reference implementation explicitly from `mayura/storage-sqlite` or `mayura/storage-postgres`; the compatibility `mayura/storage` facade installs both. Contracts are not authentication, a transaction engine, or proof that an arbitrary adapter is conformant. See [Storage](../../docs/guides/storage.md).

`DurableBudgetAggregateStore` is an optional additive capability. Its immutable command, snapshot and reply codecs validate financial metadata, including exact ancestor accounting and retained unknown charges. The standalone ledger does not execute effects or automatically protect scheduled workflows. See [Costs and budgets](../../docs/concepts/costs-and-budgets.md).

`createAggregateFrontendToolStore` provides a scoped CAS journal for AG-UI frontend tools, with the explicit `frontend-tools:store` grant. Stable per-call tokens, permanent browser claims and atomic immutable result outboxes work over existing aggregate backends. Native delivery reservations cannot transfer; expired payloads can be redacted while retaining non-executable tombstones. This is trusted storage, not an authorization engine or automatic recovery of native execution. See [AG-UI](../../docs/guides/ag-ui.md).

Private development preview; not yet published or enterprise-qualified.

Recoverable frontend calls use prepared/parked states: prepared calls cannot dispatch or claim until their native checkpoint is saved. Paired `RunCheckpointDelete.expectedVersion` and `expectedDigest` atomically consume only the matching holder and live claimed lease, protecting later epochs for the same run. All built-in SQL/document stores use the shared implementation. Custom checkpoint adapters must enforce this fence before enabling native recovery.

Native external recovery also uses `claim({ runId, holderId, leaseMs, expectedDigest })`. Custom checkpoint adapters must verify this digest and the frontend discriminator atomically before claiming or transferring the native run record. A stale command must never claim a later frontend or human-approval epoch.
