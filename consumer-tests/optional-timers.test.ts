import { createTimerWorkStream, type TimerSnapshot } from '@mayura/workstream/timers';
import type { AggregateStore } from '@mayura/storage-contracts';

/** Public timer types work with a driver-free custom aggregate adapter. */
async function consume(store: AggregateStore): Promise<void> {
  const timers = createTimerWorkStream({ store, scope: { principalId: 'consumer', projectId: 'app' }, streamId: 'timers' });
  await timers.initialize(); const scheduled: TimerSnapshot = await timers.schedule({ id: 'wake', dueAtMs: 1, payload: { run: 'a' } });
  await timers.inspect(scheduled.id); await timers.sweepDue({ limit: 8 }); await timers.cancel(scheduled.id); await timers.list({ limit: 8 }); await timers.events(0);
  // @ts-expect-error Snapshots are immutable.
  scheduled.status = 'fired';
  // @ts-expect-error Due time is always an absolute number.
  await timers.schedule({ id: 'bad', dueAtMs: new Date() });
}
void consume;
