# mayura/storage-contracts

Driver-free aggregate, scheduler, workflow and optional durable-budget contracts for trusted custom adapter authors. Depends only on core; no connections, filesystem access or environment lookup on import.

Select the reference implementation explicitly from `mayura/storage-sqlite` or `mayura/storage-postgres`; the compatibility `mayura/storage` facade installs both. Contracts are not authentication, a transaction engine, or proof that an arbitrary adapter is conformant. See [Storage](../../docs/guides/storage.md).

`DurableBudgetAggregateStore` is an optional additive capability. Its immutable command, snapshot and reply codecs validate financial metadata, including exact ancestor accounting and retained unknown charges. The standalone ledger does not execute effects or automatically protect scheduled workflows. See [Costs and budgets](../../docs/concepts/costs-and-budgets.md).

Private development preview; not yet published or enterprise-qualified.
