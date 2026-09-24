import { createHumanWorkStream, type HumanRequestDefinition, type HumanRequestSnapshot } from '@mayura/workstream/humans';
import type { Schema } from '@mayura/core';
import type { AggregateStore } from '@mayura/storage-contracts';

interface Answer { readonly choice: 'accept' | 'revise' }
const schema: Schema<Answer> = { '~standard': { version: 1, vendor: 'consumer', validate: value => ({ value: value as Answer }) } };
const request: HumanRequestDefinition<typeof schema> = { id: 'review', kind: 'plan_selection', schemaId: 'choice-v1', schemaDigest: 'a'.repeat(64),
  prompt: 'Select the next plan.', response: schema };

/** Public types work with a driver-free custom aggregate adapter. */
async function consume(store: AggregateStore): Promise<void> {
  const humans = createHumanWorkStream({ store, scope: { principalId: 'consumer', projectId: 'app' }, streamId: 'reviews', authorize: () => true });
  await humans.initialize(); const waiting: HumanRequestSnapshot<Answer> = await humans.request(request);
  const answered: HumanRequestSnapshot<Answer> = await humans.respond(request, { commandId: 'answer', actor: { id: 'reviewer' }, value: { choice: 'accept' } });
  await humans.inspect(request); await humans.cancel(request.id); await humans.sweepDeadlines({ limit: 8 });
  // @ts-expect-error Snapshots are immutable.
  answered.status = 'waiting';
  // @ts-expect-error The schema controls response input.
  await humans.respond(request, { commandId: 'bad', actor: { id: 'reviewer' }, value: { choice: 'unknown' } });
  void waiting;
}
void consume;
