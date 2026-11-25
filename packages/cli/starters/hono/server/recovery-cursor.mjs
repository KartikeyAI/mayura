import { isStorageError } from 'mayura/storage-contracts';

const cursorId = 'conversation-cursor';
const definitionHash = 'notebook-recovery-cursor-v1';

/** Advance the scheduled scan across fresh Worker invocations using a single versioned D1 record. */
export async function recoverConversationPage(store, projectId, recover) {
  const scope = JSON.stringify(['notebook-recovery', projectId]);
  const record = await store.read(scope, cursorId);
  if (record && (record.definitionHash !== definitionHash || record.state.format !== 1 || !Object.hasOwn(record.state, 'after'))) {
    throw new Error('Invalid conversation recovery cursor record.');
  }
  const after = record?.state.after ?? undefined;
  const report = await recover(after);
  if (after === undefined && report.next === null) return report;

  const state = { format: 1, after: report.next };
  try {
    if (record) {
      await store.update({ scope, id: cursorId, expectedVersion: record.version, state, events: [] });
    } else {
      await store.create({ scope, id: cursorId, idempotencyKey: cursorId, definitionHash, state, events: [] });
    }
  } catch (error) {
    // A concurrent invocation advanced the cursor. Recovery owns its effects independently of this scan position.
    if (!isStorageError(error, 'CONFLICT')) throw error;
  }
  return report;
}
