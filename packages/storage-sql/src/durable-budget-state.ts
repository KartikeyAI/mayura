import { durableBudgetCommand, durableBudgetSnapshot, StorageError,
  type DurableBudgetAccount, type DurableBudgetBundle, type DurableBudgetMethod, type DurableBudgetOperation,
  type DurableBudgetReservation, type DurableBudgetSnapshot, type StoredEventInput } from '@mayura/storage-contracts';
import type { WorkflowTreeBudgetSnapshot } from '@mayura/storage-contracts';
import type { JsonObject } from '@mayura/core';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Account = Mutable<DurableBudgetAccount>;
type Reservation = Mutable<DurableBudgetReservation>;
type State = Omit<Mutable<DurableBudgetSnapshot>, 'accounts' | 'bundles' | 'reservations'> & {
  accounts: Account[]; bundles: DurableBudgetBundle[]; reservations: Reservation[];
};
export type DurableBudgetMutation = Exclude<DurableBudgetMethod, 'initialize' | 'inspect' | 'events'>;
export interface DurableBudgetReduction {
  readonly snapshot: DurableBudgetSnapshot; readonly changed: boolean; readonly event?: StoredEventInput;
  readonly startStatus?: 'started' | 'already_started'; readonly overrun?: boolean;
}
function conflict(): never { throw new StorageError('CONFLICT', 'Durable budget authority or immutable command content conflicts.'); }
function missing(): never { throw new StorageError('NOT_FOUND', 'Durable budget account or reservation was not found.'); }
function limited(): never { throw new StorageError('LIMIT_EXCEEDED', 'Durable budget admission exceeds its finite ceilings.'); }
const safe = BigInt(Number.MAX_SAFE_INTEGER);

/** The complete bounded root starts with one atomically persisted creation event. */
export function initialDurableBudgetState(raw: unknown): DurableBudgetSnapshot {
  const command = durableBudgetCommand('create', raw);
  return durableBudgetSnapshot({ scope: command['scope'], id: command['id'], policyHash: command['policyHash'],
    format: 1, mode: 'shared-ceiling-v1', owner: 'host-v1', version: 1, eventSequence: 1, blocked: false,
    accounts: [{ id: 'root', parentId: null, maxCostMicros: command['maxCostMicros'], maxCalls: command['maxCalls'], closed: false,
      spentMicros: 0, reservedMicros: 0, calls: 0, heldCalls: 0 }], bundles: [], reservations: [] });
}

/** Scheduler-owned accounting retains the host ledger's exact invariants under a distinct fixed owner. */
export function initialWorkflowTreeBudgetState(raw: unknown): WorkflowTreeBudgetSnapshot {
  return workflowTreeSnapshot(initialDurableBudgetState(raw));
}

function hostSnapshot(raw: WorkflowTreeBudgetSnapshot): DurableBudgetSnapshot {
  return durableBudgetSnapshot({ ...raw, owner: 'host-v1' });
}

function workflowTreeSnapshot(raw: DurableBudgetSnapshot): WorkflowTreeBudgetSnapshot {
  return Object.freeze({ ...raw, owner: 'workflow-tree-v1' });
}

/**
 * Pure reducer for the root-locked SQL session. No supplied deltas are trusted;
 * all inclusive account projections are rebuilt from immutable ticket evidence.
 */
export function reduceDurableBudgetState(raw: unknown, method: DurableBudgetMutation, input: unknown): DurableBudgetReduction {
  const command = durableBudgetCommand(method, input);
  const prior = durableBudgetSnapshot(raw);
  if (prior.scope !== command['scope'] || prior.id !== command['id'] || prior.policyHash !== command['policyHash']) conflict();
  const state = structuredClone(prior) as State;
  const accounts = new Map(state.accounts.map(account => [account.id, account]));
  const accountFor = (id: string): Account => accounts.get(id) ?? missing();
  const pathFor = (account: Account): readonly Account[] => {
    const path: Account[] = [account]; let current = account;
    while (current.parentId !== null) { current = accountFor(current.parentId); path.push(current); } return path;
  };
  const open = (account: Account): void => { if (state.blocked || pathFor(account).some(ancestor => ancestor.closed)) conflict(); };
  const ticketFor = (): Reservation => {
    accountFor(command['accountId'] as string);
    const ticket = state.reservations.find(item => item.id === command['reservationId']); if (!ticket) missing();
    if (ticket.accountId !== command['accountId']) conflict(); return ticket;
  };
  const unchanged = (extra: Pick<DurableBudgetReduction, 'startStatus' | 'overrun'> = {}): DurableBudgetReduction => ({ snapshot: prior, changed: false, ...extra });
  let event: StoredEventInput; let startStatus: DurableBudgetReduction['startStatus']; let overrun: boolean | undefined;
  if (method === 'create') {
    const root = accountFor('root'); if (root.maxCostMicros !== command['maxCostMicros'] || root.maxCalls !== command['maxCalls']) conflict(); return unchanged();
  } else if (method === 'fork') {
    const parent = accountFor(command['parentId'] as string); const accountId = command['accountId'] as string; const existing = accounts.get(accountId);
    if (existing) {
      if (existing.parentId !== parent.id || existing.maxCostMicros !== command['maxCostMicros'] || existing.maxCalls !== command['maxCalls']) conflict(); return unchanged();
    }
    open(parent);
    if (state.accounts.length >= 128 || pathFor(parent).length > 16) limited();
    if ((command['maxCostMicros'] as number) > parent.maxCostMicros || (command['maxCalls'] as number) > parent.maxCalls) limited();
    const child: Account = { id: accountId, parentId: parent.id, maxCostMicros: command['maxCostMicros'] as number, maxCalls: command['maxCalls'] as number,
      closed: false, spentMicros: 0, reservedMicros: 0, calls: 0, heldCalls: 0 };
    state.accounts.push(child); accounts.set(child.id, child); event = { type: 'budget.forked', data: { accountId, parentId: parent.id } };
  } else if (method === 'reserveBundle') {
    const account = accountFor(command['accountId'] as string); const bundleId = command['bundleId'] as string;
    const operations = command['operations'] as unknown as readonly DurableBudgetOperation[];
    const existing = state.bundles.find(bundle => bundle.id === bundleId);
    if (existing) {
      if (existing.accountId !== account.id || existing.operations.length !== operations.length
        || existing.operations.some((operation, index) => operation.id !== operations[index]!.id || operation.maxCostMicros !== operations[index]!.maxCostMicros)) conflict();
      return unchanged();
    }
    if (operations.some(operation => state.reservations.some(ticket => ticket.id === operation.id))) conflict();
    open(account); if (state.bundles.length >= 128 || state.reservations.length + operations.length > 512) limited();
    const amount = operations.reduce((total, operation) => total + BigInt(operation.maxCostMicros), 0n);
    for (const ancestor of pathFor(account)) {
      if (BigInt(ancestor.spentMicros) + BigInt(ancestor.reservedMicros) + amount > BigInt(ancestor.maxCostMicros)
        || BigInt(ancestor.calls) + BigInt(ancestor.heldCalls) + BigInt(operations.length) > BigInt(ancestor.maxCalls)) limited();
    }
    state.bundles.push({ id: bundleId, accountId: account.id, operations });
    for (const operation of operations) state.reservations.push({ ...operation, accountId: account.id, bundleId, status: 'held', actualMicros: null });
    event = { type: 'budget.reserved', data: { accountId: account.id, bundleId } };
  } else if (method === 'closeSubtree') {
    const account = accountFor(command['accountId'] as string); if (account.closed) return unchanged();
    account.closed = true; let cancelledReservations = 0;
    for (const ticket of state.reservations) if (ticket.status === 'held' && pathFor(accountFor(ticket.accountId)).some(ancestor => ancestor.id === account.id)) {
      ticket.status = 'cancelled'; cancelledReservations++;
    }
    event = { type: 'budget.subtree_closed', data: { accountId: account.id, cancelledReservations } };
  } else {
    const ticket = ticketFor(); const data: JsonObject = { accountId: ticket.accountId, reservationId: ticket.id };
    if (method === 'start') {
      if (ticket.status === 'cancelled') conflict();
      if (ticket.status !== 'held') return unchanged({ startStatus: 'already_started' });
      open(accountFor(ticket.accountId)); ticket.status = 'started'; startStatus = 'started'; event = { type: 'budget.started', data };
    } else if (method === 'markUnknown') {
      if (ticket.status === 'unknown' || ticket.status === 'settled') return unchanged();
      if (ticket.status !== 'started') conflict(); ticket.status = 'unknown'; event = { type: 'budget.unknown', data };
    } else if (method === 'settle') {
      const actual = command['actualMicros'] as number; overrun = actual > ticket.maxCostMicros;
      if (ticket.status === 'settled') { if (ticket.actualMicros !== actual) conflict(); return unchanged({ overrun }); }
      if (ticket.status !== 'started' && ticket.status !== 'unknown') conflict();
      ticket.status = 'settled'; ticket.actualMicros = actual; state.blocked ||= overrun; event = { type: 'budget.settled', data: { ...data, overrun } };
    } else if (method === 'cancelReservation') {
      if (ticket.status === 'cancelled') return unchanged(); if (ticket.status !== 'held') conflict();
      ticket.status = 'cancelled'; event = { type: 'budget.reservation_cancelled', data };
    } else conflict();
  }
  // Admissions are bounded so all starts/unknowns/settlements/closures fit; never
  // evict historical identities to manufacture fresh spending or event capacity.
  if (state.version >= 2_048) limited(); state.version++; state.eventSequence++;
  const totals = new Map(state.accounts.map(account => [account.id, { spent: 0n, reserved: 0n, calls: 0, held: 0 }]));
  for (const ticket of state.reservations) for (const ancestor of pathFor(accountFor(ticket.accountId))) {
    const total = totals.get(ancestor.id)!;
    if (ticket.status === 'held') total.held++;
    if (ticket.status === 'started' || ticket.status === 'unknown' || ticket.status === 'settled') total.calls++;
    if (ticket.status === 'held' || ticket.status === 'started' || ticket.status === 'unknown') total.reserved += BigInt(ticket.maxCostMicros);
    if (ticket.status === 'settled') total.spent += BigInt(ticket.actualMicros!);
  }
  for (const account of state.accounts) {
    const total = totals.get(account.id)!; account.spentMicros = total.spent <= safe ? Number(total.spent) : total.spent.toString();
    account.reservedMicros = Number(total.reserved); account.calls = total.calls; account.heldCalls = total.held;
  }
  const order = (left: { id: string }, right: { id: string }): number => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  state.accounts.sort(order); state.bundles.sort(order); state.reservations.sort(order);
  return { snapshot: durableBudgetSnapshot(state), changed: true, event,
    ...(startStatus === undefined ? {} : { startStatus }), ...(overrun === undefined ? {} : { overrun }) };
}

/** Fixed-owner reducer seam used only by the integrated workflow-tree writer. */
export function reduceWorkflowTreeBudgetState(
  raw: WorkflowTreeBudgetSnapshot,
  method: DurableBudgetMutation,
  input: unknown,
): Omit<DurableBudgetReduction, 'snapshot'> & { readonly snapshot: WorkflowTreeBudgetSnapshot } {
  const result = reduceDurableBudgetState(hostSnapshot(raw), method, input);
  return { ...result, snapshot: workflowTreeSnapshot(result.snapshot) };
}
