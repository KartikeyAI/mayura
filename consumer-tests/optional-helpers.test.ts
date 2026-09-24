import { Budget } from '@mayura/core';
import { createRedactedLogger, retry, runBudgetedTasks, secretReference, type BudgetedTaskResult } from '@mayura/helpers';

export async function verifyHelpers(): Promise<Readonly<{ results: readonly BudgetedTaskResult<number>[]; logs: number }>> {
  const signal = new AbortController().signal; const logs: unknown[] = [];
  secretReference({ provider: 'vault', key: 'mayura/agent' });
  await retry(() => Promise.resolve('ok'), { signal, maxAttempts: 2, initialDelayMs: 0, safety: 'read-only' });
  const results = await runBudgetedTasks([{ id: 'consumer-task', maxCostMicros: 1,
    execute: async () => ({ value: 1, costMicros: 1 }) }], { budget: new Budget(1, 1), signal, concurrency: 1 });
  await createRedactedLogger(entry => { logs.push(entry); }, { allowedFields: ['token'], redactedFields: ['token'] })
    .log('info', 'consumer.checked', { token: 'not-exported' });
  return Object.freeze({ results, logs: logs.length });
}
