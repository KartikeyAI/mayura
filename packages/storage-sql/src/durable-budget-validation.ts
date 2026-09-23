import type { JsonObject } from '@mayura/core';
import { durableBudgetCommand, durableBudgetResult, type DurableBudgetMethod, type DurableBudgetStore } from '@mayura/storage-contracts';

/** Own commands before await/IPC; independently validate every financial metadata reply. */
export function durableBudgetFacade(request: (method: DurableBudgetMethod, input: JsonObject) => Promise<unknown>): DurableBudgetStore {
  const call = async <T>(method: DurableBudgetMethod, value: unknown): Promise<T> => {
    const command = durableBudgetCommand(method,value);
    return durableBudgetResult(method,await request(method,command),command) as T;
  };
  return Object.freeze({
    initialize: () => call<void>('initialize',{}),
    create: value => call('create',value),
    fork: value => call('fork',value),
    reserveBundle: value => call('reserveBundle',value),
    start: value => call('start',value),
    markUnknown: value => call('markUnknown',value),
    settle: value => call('settle',value),
    cancelReservation: value => call('cancelReservation',value),
    closeSubtree: value => call('closeSubtree',value),
    inspect: value => call('inspect',value),
    events: value => call('events',value),
  } satisfies DurableBudgetStore);
}
