import { durableBudgetCommand, durableBudgetSnapshot, type DurableBudgetAggregateStore,
  type DurableBudgetKey, type DurableBudgetSnapshot, type DurableBudgetStore } from '@mayura/storage-contracts';

const key: DurableBudgetKey = { scope: 'consumer', id: 'budget', policyHash: 'a'.repeat(64) };
const operations = [{ id: 'primary', maxCostMicros: 3 }, { id: 'check', maxCostMicros: 1 }] as const;
async function verify(store: DurableBudgetStore, aggregate: DurableBudgetAggregateStore): Promise<void> {
  await aggregate.durableBudgets.initialize(); await store.initialize();
  const created = await store.create({ ...key, maxCostMicros: 10, maxCalls: 4 });
  const snapshot: DurableBudgetSnapshot = created.snapshot;
  const owner: 'host-v1' = snapshot.owner; const mode: 'shared-ceiling-v1' = snapshot.mode; void owner; void mode;
  await store.fork({ ...key, parentId: 'root', accountId: 'child', maxCostMicros: 4, maxCalls: 2 });
  await store.reserveBundle({ ...key, accountId: 'child', bundleId: 'pair', operations });
  const started = await store.start({ ...key, accountId: 'child', reservationId: 'primary' });
  const startStatus: 'started' | 'already_started' = started.status; void startStatus;
  await store.markUnknown({ ...key, accountId: 'child', reservationId: 'primary' });
  const settled = await store.settle({ ...key, accountId: 'child', reservationId: 'primary', actualMicros: 2 });
  const overrun: boolean = settled.overrun; void overrun;
  await store.cancelReservation({ ...key, accountId: 'child', reservationId: 'check' });
  await store.closeSubtree({ ...key, accountId: 'child' });
  const inspected = await store.inspect(key);
  if (inspected?.accounts[0]) {
    const cost: number | string = inspected.accounts[0].spentMicros; void cost;
    // @ts-expect-error Financial observations are immutable.
    inspected.accounts[0].spentMicros = 0;
  }
  await store.events({ ...key, after: 0 });
  void durableBudgetCommand('create', { ...key, maxCostMicros: 10, maxCalls: 4 });
  void durableBudgetSnapshot(snapshot);
  // @ts-expect-error Callers cannot replace the ledger state.
  store.update({ ...key, state: {} });
  // @ts-expect-error Admission is financial-only, not an effect executor.
  store.execute(() => {});
  // @ts-expect-error Financial state exposes no workflow output.
  void snapshot.output;
  // @ts-expect-error Cost evidence must be a number, not a decimal string supplied by the caller.
  await store.settle({ ...key, accountId: 'child', reservationId: 'primary', actualMicros: '2' });
  // @ts-expect-error Policy identity is mandatory on every command.
  await store.inspect({ scope: key.scope, id: key.id });
}
void verify;
