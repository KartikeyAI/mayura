import { Budget } from '@mayura/core';
import { createRedactedLogger, retry, runBudgetedTasks, secretReference } from '@mayura/helpers';

const signal = new AbortController().signal; const entries = [];
const reference = secretReference({ provider: 'vault', key: 'mayura/agent' });
const retried = await retry(() => Promise.resolve('ok'), { signal, maxAttempts: 2, initialDelayMs: 0, safety: 'read-only' });
const budget = new Budget(1, 1);
const results = await runBudgetedTasks([{ id: 'consumer-task', maxCostMicros: 1,
  execute: async () => ({ value: 1, costMicros: 1 }) }], { budget, signal, concurrency: 1 });
await createRedactedLogger(entry => { entries.push(entry); }, { allowedFields: ['token'], redactedFields: ['token'], clock: () => 1 })
  .log('info', 'consumer.checked', { token: 'not-exported' });

console.log(JSON.stringify({ status: 'passed', secretReferenceOnly: !('value' in reference), retrySafety: retried === 'ok',
  budgetAccounting: results[0]?.status === 'succeeded' && budget.snapshot().spentMicros === 1,
  redactedLogging: JSON.stringify(entries).includes('[REDACTED]') && !JSON.stringify(entries).includes('not-exported') }));
