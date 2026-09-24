import { MayuraError, assertBudget, publicError, type Budget, type PublicError } from '@mayura/core';

export interface BudgetedTask<T> {
  readonly id: string;
  readonly maxCostMicros: number;
  readonly execute: (signal: AbortSignal) => Promise<Readonly<{ value: T; costMicros: number }>>;
}

export type BudgetedTaskResult<T> =
  | { readonly status: 'succeeded'; readonly value: T; readonly costMicros: number }
  | { readonly status: 'failed' | 'cancelled' | 'outcome_unknown'; readonly error: PublicError };

export interface BudgetedConcurrencyOptions {
  readonly budget: Budget;
  readonly signal: AbortSignal;
  readonly concurrency: number;
}

function snapshotTasks<T>(tasks: readonly BudgetedTask<T>[]): readonly BudgetedTask<T>[] {
  try {
    if (!Array.isArray(tasks)) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(tasks); const length = Object.getOwnPropertyDescriptor(tasks, 'length');
    if (!length || !('value' in length) || typeof length.value !== 'number'
      || !Number.isSafeInteger(length.value) || length.value < 1 || length.value > 128) throw new Error();
    const size = length.value as number;
    if (Reflect.ownKeys(descriptors).length !== size + 1) throw new Error();
    const result: BudgetedTask<T>[] = [];
    for (let index = 0; index < size; index++) {
      const item = descriptors[String(index)]; if (!item || !('value' in item)) throw new Error();
      const task = item.value as BudgetedTask<T>;
      if (!task || typeof task !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(task))) throw new Error();
      const fields = Object.getOwnPropertyDescriptors(task); const keys = Reflect.ownKeys(fields);
      if (keys.length !== 3 || keys.some(key => !['id', 'maxCostMicros', 'execute'].includes(String(key)))) throw new Error();
      for (const key of ['id', 'maxCostMicros', 'execute'] as const) if (!fields[key] || !('value' in fields[key])) throw new Error();
      if (typeof fields['execute']!.value !== 'function') throw new Error();
      result.push(Object.freeze({ id: fields['id']!.value, maxCostMicros: fields['maxCostMicros']!.value,
        execute: fields['execute']!.value }) as BudgetedTask<T>);
    }
    return Object.freeze(result);
  } catch { throw new MayuraError('INVALID_CONFIG', 'Budgeted tasks must contain plain bounded definitions.'); }
}

/** Atomically admits all tasks, preserves order, and retains unknown usage after ambiguous completion. */
export async function runBudgetedTasks<T>(
  rawTasks: readonly BudgetedTask<T>[],
  options: BudgetedConcurrencyOptions,
): Promise<readonly BudgetedTaskResult<T>[]> {
  const tasks = snapshotTasks(rawTasks);
  assertBudget(options.budget);
  if (!(options.signal instanceof AbortSignal)) throw new MayuraError('INVALID_CONFIG', 'An AbortSignal is required.');
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0 || options.concurrency > 64) {
    throw new MayuraError('INVALID_CONFIG', 'Concurrency must be an integer from 1 through 64.');
  }
  if (options.signal.aborted) throw new MayuraError('CANCELLED', 'The operation was cancelled.');
  const bundle = options.budget.reserveBundle(tasks.map(task => ({ id: task.id, maxCostMicros: task.maxCostMicros })));
  const results: Array<BudgetedTaskResult<T> | undefined> = Array.from({ length: tasks.length }); let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= tasks.length) return;
      const task = tasks[index]!; const ticket = bundle.tickets[index]!;
      if (options.signal.aborted) {
        ticket.cancel(); results[index] = Object.freeze({ status: 'cancelled', error: Object.freeze(publicError(new MayuraError('CANCELLED', 'The task was cancelled before dispatch.'))) });
        continue;
      }
      const reservation = ticket.start(); let settled = false;
      try {
        const execution = await task.execute(options.signal);
        const cost = execution?.costMicros;
        if (!Number.isSafeInteger(cost) || (cost as number) < 0) {
          reservation.settleUsage(0, task.maxCostMicros); settled = true;
          results[index] = Object.freeze({ status: 'outcome_unknown', error: Object.freeze(publicError(new MayuraError('OUTCOME_UNKNOWN', 'Task usage was not reported safely.'))) });
          continue;
        }
        try { reservation.settle(cost as number); settled = true; }
        catch (error) {
          settled = true; results[index] = Object.freeze({ status: 'failed', error: Object.freeze(publicError(error, 'BUDGET_EXCEEDED')) }); continue;
        }
        results[index] = Object.freeze({ status: 'succeeded', value: execution.value, costMicros: cost as number });
      } catch (error) {
        if (!settled) reservation.settleUsage(0, task.maxCostMicros);
        results[index] = Object.freeze({ status: 'outcome_unknown', error: Object.freeze(publicError(error, 'OUTCOME_UNKNOWN')) });
      }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(options.concurrency, tasks.length) }, worker)); }
  finally { bundle.close(); }
  for (let index = 0; index < results.length; index++) {
    results[index] ??= Object.freeze({ status: 'cancelled', error: Object.freeze(publicError(new MayuraError('CANCELLED', 'The task was cancelled before dispatch.'))) });
  }
  return Object.freeze(results as BudgetedTaskResult<T>[]);
}
