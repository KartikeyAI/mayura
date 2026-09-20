import { createExecutionWorkStream, type ExecutionRef, type ExecutionCompletion } from '@mayura/workstream/executions';
import { type AggregateStore, type ExecutionWaitAggregateStore, type ExecutionWaitSnapshot } from '@mayura/storage-contracts';

/** Public custom-adapter types must not pull either reference SQL driver into the consumer. */
async function consume(store: ExecutionWaitAggregateStore, target: ExecutionRef): Promise<void> {
  const stream = createExecutionWorkStream({ store, scope: { principalId: 'consumer', projectId: 'app' }, policyHash: target.policyHash, streamId: 'joins' });
  await stream.initialize();
  const registered: ExecutionWaitSnapshot = await stream.register({ id: 'release', targets: [target] });
  const page: readonly ExecutionWaitSnapshot[] = await stream.drainReady({ limit: 8 });
  for (const result of page) {
    for (const observation of result.observations) {
      const outcome: ExecutionCompletion['outcome'] = observation.outcome;
      // @ts-expect-error Completions never disclose the source output.
      void observation.output;
      void outcome;
    }
    // @ts-expect-error Result snapshots are immutable metadata.
    result.status = 'waiting';
  }
  await stream.inspect(registered.id); await stream.events(0); await stream.cancel(registered.id); await stream.close();
  // @ts-expect-error Targets are exact references, not unscoped run ID strings.
  await stream.register({ id: 'wrong', targets: [target.runId] });
  // @ts-expect-error This finite slice deliberately does not support any/timers.
  await stream.register({ id: 'wrong-mode', targets: [target], mode: 'any' });
  const aggregate: AggregateStore = store;
  // @ts-expect-error Aggregate-only custom adapters do not promise completion-wait persistence.
  createExecutionWorkStream({ store: aggregate, scope: { principalId: 'consumer', projectId: 'app' }, policyHash: target.policyHash, streamId: 'missing' });
}
void consume;
