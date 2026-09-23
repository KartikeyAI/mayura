import { freezeJson, jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError, type AggregateStore, type StoredEvent } from './contracts.js';

/** Correlation pins for trusted-host accounting, never runnable execution authority. */
export interface DurableBudgetKey { readonly scope: string; readonly id: string; readonly policyHash: string }
export interface DurableBudgetLimits { readonly maxCostMicros: number; readonly maxCalls: number }
export interface DurableBudgetAccount extends DurableBudgetLimits {
  readonly id: string; readonly parentId: string | null; readonly closed: boolean;
  /** Inclusive of descendants; do not add ancestor and descendant snapshots. */
  readonly spentMicros: number | string; readonly reservedMicros: number; readonly calls: number; readonly heldCalls: number;
}
export interface DurableBudgetOperation { readonly id: string; readonly maxCostMicros: number }
export interface DurableBudgetBundle { readonly id: string; readonly accountId: string; readonly operations: readonly DurableBudgetOperation[] }
export interface DurableBudgetReservation extends DurableBudgetOperation {
  readonly accountId: string; readonly bundleId: string;
  readonly status: 'held' | 'started' | 'unknown' | 'settled' | 'cancelled'; readonly actualMicros: number | null;
}
export interface DurableBudgetSnapshot extends DurableBudgetKey {
  readonly format: 1; readonly mode: 'shared-ceiling-v1'; readonly owner: 'host-v1';
  readonly version: number; readonly eventSequence: number; readonly blocked: boolean;
  readonly accounts: readonly DurableBudgetAccount[]; readonly bundles: readonly DurableBudgetBundle[];
  readonly reservations: readonly DurableBudgetReservation[];
}
export interface DurableBudgetCreate extends DurableBudgetKey, DurableBudgetLimits {}
export interface DurableBudgetFork extends DurableBudgetKey, DurableBudgetLimits { readonly parentId: string; readonly accountId: string }
export interface DurableBudgetReserveBundle extends DurableBudgetKey {
  readonly accountId: string; readonly bundleId: string; readonly operations: readonly DurableBudgetOperation[];
}
export interface DurableBudgetTicket extends DurableBudgetKey { readonly accountId: string; readonly reservationId: string }
export interface DurableBudgetSettle extends DurableBudgetTicket { readonly actualMicros: number }
export interface DurableBudgetCloseSubtree extends DurableBudgetKey { readonly accountId: string }
export interface DurableBudgetEvents extends DurableBudgetKey { readonly after?: number }
export interface DurableBudgetCreateResult { readonly snapshot: DurableBudgetSnapshot; readonly created: boolean }
export interface DurableBudgetStartResult { readonly snapshot: DurableBudgetSnapshot; readonly status: 'started' | 'already_started' }
export interface DurableBudgetSettleResult { readonly snapshot: DurableBudgetSnapshot; readonly overrun: boolean }
/** Optional financial ledger. Hosts authenticate access and supply truthful cost evidence. */
export interface DurableBudgetStore {
  initialize(): Promise<void>;
  create(command: DurableBudgetCreate): Promise<DurableBudgetCreateResult>;
  fork(command: DurableBudgetFork): Promise<DurableBudgetSnapshot>;
  reserveBundle(command: DurableBudgetReserveBundle): Promise<DurableBudgetSnapshot>;
  start(command: DurableBudgetTicket): Promise<DurableBudgetStartResult>;
  markUnknown(command: DurableBudgetTicket): Promise<DurableBudgetSnapshot>;
  settle(command: DurableBudgetSettle): Promise<DurableBudgetSettleResult>;
  cancelReservation(command: DurableBudgetTicket): Promise<DurableBudgetSnapshot>;
  closeSubtree(command: DurableBudgetCloseSubtree): Promise<DurableBudgetSnapshot>;
  inspect(command: DurableBudgetKey): Promise<DurableBudgetSnapshot | undefined>;
  events(command: DurableBudgetEvents): Promise<readonly StoredEvent[]>;
}
export interface DurableBudgetAggregateStore extends AggregateStore { readonly durableBudgets: DurableBudgetStore }
export type DurableBudgetMethod = keyof DurableBudgetStore;
export type DurableBudgetMethodResult<M extends DurableBudgetMethod> = Awaited<ReturnType<DurableBudgetStore[M]>>;

const safe = BigInt(Number.MAX_SAFE_INTEGER);
const maximumSpent = safe * 512n;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const encoder = new TextEncoder();
const methods = new Set<DurableBudgetMethod>(['initialize', 'create', 'fork', 'reserveBundle', 'start', 'markUnknown', 'settle', 'cancelReservation', 'closeSubtree', 'inspect', 'events']);
function invalid(): never { throw new StorageError('INVALID_INPUT', 'Invalid bounded durable budget metadata.'); }
function corrupt(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Durable budget metadata failed integrity validation.'); }
function object(value: JsonValue | undefined): JsonObject { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value; }
function fields(value: JsonObject, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid();
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(); return value;
}
function id(value: unknown): string { if (typeof value !== 'string' || !identifierPattern.test(value)) invalid(); return value; }
function identifier(value: unknown): string {
  // Unicode mode treats a valid surrogate pair as one supplementary code point;
  // only unpaired units match. Native SQL UTF-8 encoding must not alias keys.
  if (typeof value !== 'string' || !value.length || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value) || encoder.encode(value).length > 256) invalid(); return value;
}
function key(value: JsonObject): void {
  identifier(value['scope']); identifier(value['id']);
  if (typeof value['policyHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['policyHash'])) invalid();
}
function limits(value: JsonObject): void { integer(value['maxCostMicros']); integer(value['maxCalls'], 1); }
function operations(raw: JsonValue | undefined): readonly DurableBudgetOperation[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 32) invalid();
  const seen = new Set<string>();
  for (const item of raw) { const value = object(item); fields(value, ['id', 'maxCostMicros']); const name = id(value['id']);
    if (seen.has(name)) invalid(); seen.add(name); integer(value['maxCostMicros']); }
  return raw as unknown as readonly DurableBudgetOperation[];
}
function capture(raw: unknown, bytes = 1_048_576): JsonObject {
  return object(jsonValue(raw, { maxBytes: bytes, maxNodes: 30_000, maxDepth: 24 }));
}
function immutable<T>(value: JsonValue): T { return freezeJson(value) as unknown as T; }

/** Exact owned command snapshots must be produced before any asynchronous transport. */
export function durableBudgetCommand(method: DurableBudgetMethod, raw: unknown): JsonObject {
  try {
    if (!methods.has(method)) invalid(); const value = capture(raw, 32_768);
    if (method === 'initialize') { fields(value, []); return immutable(value); }
    key(value); const common = ['scope', 'id', 'policyHash'];
    switch (method) {
      case 'create': fields(value, [...common, 'maxCostMicros', 'maxCalls']); limits(value); break;
      case 'fork': fields(value, [...common, 'parentId', 'accountId', 'maxCostMicros', 'maxCalls']); id(value['parentId']); id(value['accountId']); limits(value); break;
      case 'reserveBundle': fields(value, [...common, 'accountId', 'bundleId', 'operations']); id(value['accountId']); id(value['bundleId']); operations(value['operations']); break;
      case 'start': case 'markUnknown': case 'cancelReservation':
        fields(value, [...common, 'accountId', 'reservationId']); id(value['accountId']); id(value['reservationId']); break;
      case 'settle': fields(value, [...common, 'accountId', 'reservationId', 'actualMicros']); id(value['accountId']); id(value['reservationId']); integer(value['actualMicros']); break;
      case 'closeSubtree': fields(value, [...common, 'accountId']); id(value['accountId']); break;
      case 'inspect': fields(value, common); break;
      case 'events': if (!Object.hasOwn(value, 'after')) value['after'] = 0; fields(value, [...common, 'after']); integer(value['after']); break;
    }
    return immutable(value);
  } catch { return invalid(); }
}

interface Usage { spent: bigint; nominalSpent: bigint; reserved: bigint; calls: number; held: number }
function spent(value: unknown): bigint {
  if (typeof value === 'number') return BigInt(integer(value));
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,20}$/.test(value)) invalid();
  const amount = BigInt(value); if (amount <= safe || amount > maximumSpent) invalid(); return amount;
}
function sortedArray(value: JsonValue | undefined, maximum: number, minimum = 0): JsonObject[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid();
  let previous = ''; const result: JsonObject[] = [];
  for (const entry of value) { const item = object(entry); const name = id(item['id']); if (name <= previous) invalid(); previous = name; result.push(item); }
  return result;
}

/** Validate complete immutable evidence and independently rederive every inclusive account total. */
export function durableBudgetSnapshot(raw: unknown, context?: DurableBudgetKey): DurableBudgetSnapshot {
  try {
    const value = capture(raw);
    fields(value, ['format', 'mode', 'owner', 'scope', 'id', 'policyHash', 'version', 'eventSequence', 'blocked', 'accounts', 'bundles', 'reservations']); key(value);
    if (value['format'] !== 1 || value['mode'] !== 'shared-ceiling-v1' || value['owner'] !== 'host-v1' || typeof value['blocked'] !== 'boolean') invalid();
    integer(value['version'], 1, 2_048); if (value['eventSequence'] !== value['version']) invalid();
    if (context) { const expected = durableBudgetCommand('inspect', context); for (const name of ['scope', 'id', 'policyHash']) if (value[name] !== expected[name]) invalid(); }
    const accountRows = sortedArray(value['accounts'], 128, 1); const accounts = new Map<string, DurableBudgetAccount>();
    for (const account of accountRows) {
      fields(account, ['id', 'parentId', 'maxCostMicros', 'maxCalls', 'closed', 'spentMicros', 'reservedMicros', 'calls', 'heldCalls']); limits(account);
      if (typeof account['closed'] !== 'boolean') invalid();
      if (account['id'] === 'root') { if (account['parentId'] !== null) invalid(); } else id(account['parentId']);
      spent(account['spentMicros']); integer(account['reservedMicros']); integer(account['calls']); integer(account['heldCalls']);
      accounts.set(account['id'] as string, account as unknown as DurableBudgetAccount);
    }
    if (!accounts.has('root')) invalid();
    const paths = new Map<string, readonly DurableBudgetAccount[]>(); const usage = new Map<string, Usage>();
    for (const account of accounts.values()) {
      const path: DurableBudgetAccount[] = []; const seen = new Set<string>(); let current: DurableBudgetAccount | undefined = account;
      while (current) {
        if (seen.has(current.id) || path.length > 16) invalid(); seen.add(current.id); path.push(current);
        if (current.parentId === null) break;
        const parent = accounts.get(current.parentId); if (!parent || current.maxCostMicros > parent.maxCostMicros || current.maxCalls > parent.maxCalls) invalid(); current = parent;
      }
      if (path.at(-1)?.id !== 'root') invalid(); paths.set(account.id, path); usage.set(account.id, { spent: 0n, nominalSpent: 0n, reserved: 0n, calls: 0, held: 0 });
    }
    const bundleRows = sortedArray(value['bundles'], 128); const admitted = new Map<string, { bundleId: string; accountId: string; bound: number }>();
    for (const bundle of bundleRows) {
      fields(bundle, ['id', 'accountId', 'operations']); const accountId = id(bundle['accountId']); if (!accounts.has(accountId)) invalid();
      const items = operations(bundle['operations']); const bound = items.reduce((sum, operation) => sum + BigInt(operation.maxCostMicros), 0n);
      // Released tickets still attest an atomic historical admission; cancellation
      // must not hide a bundle that could never fit its immutable ancestor ceilings.
      for (const ancestor of paths.get(accountId)!) if (bound > BigInt(ancestor.maxCostMicros) || items.length > ancestor.maxCalls) invalid();
      for (const operation of items) { if (admitted.has(operation.id)) invalid(); admitted.set(operation.id, { bundleId: bundle['id'] as string, accountId, bound: operation.maxCostMicros }); }
    }
    const reservations = sortedArray(value['reservations'], 512); if (reservations.length !== admitted.size) invalid();
    let blocked = false;
    let minimumVersion = accounts.size + bundleRows.length + accountRows.filter(account => account['closed'] === true).length;
    let maximumVersion = minimumVersion;
    for (const reservation of reservations) {
      fields(reservation, ['id', 'accountId', 'bundleId', 'maxCostMicros', 'status', 'actualMicros']);
      const entry = admitted.get(reservation['id'] as string);
      if (!entry || reservation['accountId'] !== entry.accountId || reservation['bundleId'] !== entry.bundleId || reservation['maxCostMicros'] !== entry.bound) invalid();
      const status = reservation['status']; if (!['held', 'started', 'unknown', 'settled', 'cancelled'].includes(status as string)) invalid();
      const actual = status === 'settled' ? integer(reservation['actualMicros']) : 0;
      if (status !== 'settled' && reservation['actualMicros'] !== null) invalid();
      const overrun = status === 'settled' && actual > entry.bound; blocked ||= overrun;
      const path = paths.get(entry.accountId)!;
      // Unknown-before-settlement and individual-versus-subtree cancellation are
      // intentionally not replayed here. Their finite ranges still reject forged
      // version inflation that would consume required terminal evidence headroom.
      const minimumTransitions = status === 'held' ? 0 : status === 'started' ? 1 : status === 'unknown' || status === 'settled' ? 2
        : path.some(ancestor => ancestor.closed) ? 0 : 1;
      const maximumTransitions = status === 'settled' ? 3 : status === 'cancelled' ? 1 : minimumTransitions;
      minimumVersion += minimumTransitions; maximumVersion += maximumTransitions;
      for (const ancestor of path) {
        if (status === 'held' && ancestor.closed) invalid(); const total = usage.get(ancestor.id)!;
        if (status === 'held') total.held++; if (status === 'started' || status === 'unknown' || status === 'settled') total.calls++;
        if (status === 'held' || status === 'started' || status === 'unknown') total.reserved += BigInt(entry.bound);
        if (status === 'settled') {
          total.spent += BigInt(actual);
          // Excess actual cost is truthful evidence, not a reason to bypass the
          // original admission ceilings. Retain both exact and nominal spending.
          total.nominalSpent += BigInt(Math.min(actual, entry.bound));
        }
      }
    }
    if (value['blocked'] !== blocked) invalid();
    if ((value['version'] as number) < minimumVersion || (value['version'] as number) > maximumVersion) invalid();
    for (const account of accounts.values()) {
      const total = usage.get(account.id)!;
      if (spent(account.spentMicros) !== total.spent || BigInt(account.reservedMicros) !== total.reserved || account.calls !== total.calls || account.heldCalls !== total.held
        || total.calls + total.held > account.maxCalls || total.reserved > BigInt(account.maxCostMicros)
        || total.nominalSpent + total.reserved > BigInt(account.maxCostMicros)) invalid();
    }
    return immutable(value);
  } catch { return corrupt(); }
}

function eventPage(raw: unknown, after: number): readonly StoredEvent[] {
  const value = jsonValue(raw, { maxBytes: 1_048_576, maxNodes: 30_000, maxDepth: 8 });
  if (!Array.isArray(value) || value.length > 1_000) invalid(); let sequence = after;
  for (const entry of value) {
    const event = object(entry); fields(event, ['sequence', 'type', 'data', 'createdAt']);
    const next = integer(event['sequence'], 1, 2_048); if (next !== sequence + 1) invalid(); sequence = next;
    const date = event['createdAt']; if (typeof date !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(date) || new Date(date).toISOString() !== date) invalid();
    const data = object(event['data']);
    switch (event['type']) {
      case 'budget.created': fields(data, []); if (next !== 1) invalid(); break;
      case 'budget.forked': fields(data, ['accountId', 'parentId']); id(data['accountId']); id(data['parentId']); break;
      case 'budget.reserved': fields(data, ['accountId', 'bundleId']); id(data['accountId']); id(data['bundleId']); break;
      case 'budget.started': case 'budget.unknown': case 'budget.reservation_cancelled': fields(data, ['accountId', 'reservationId']); id(data['accountId']); id(data['reservationId']); break;
      case 'budget.settled': fields(data, ['accountId', 'reservationId', 'overrun']); id(data['accountId']); id(data['reservationId']); if (typeof data['overrun'] !== 'boolean') invalid(); break;
      case 'budget.subtree_closed': fields(data, ['accountId', 'cancelledReservations']); id(data['accountId']); integer(data['cancelledReservations'], 0, 512); break;
      default: invalid();
    }
    if (next === 1 && event['type'] !== 'budget.created') invalid();
  }
  return immutable(value);
}

/** Validate replies independently of adapter assertions, including command-specific ownership and transitions. */
export function durableBudgetResult<M extends DurableBudgetMethod>(method: M, raw: unknown, context: unknown): DurableBudgetMethodResult<M> {
  const command = durableBudgetCommand(method, context);
  try {
    if (method === 'initialize') { if (raw !== undefined) invalid(); return undefined as DurableBudgetMethodResult<M>; }
    if (method === 'events') return eventPage(raw, command['after'] as number) as DurableBudgetMethodResult<M>;
    if (method === 'inspect' && raw === undefined) return undefined as DurableBudgetMethodResult<M>;
    const envelope = ['create', 'start', 'settle'].includes(method) ? capture(raw) : undefined;
    const state = durableBudgetSnapshot(envelope ? envelope['snapshot'] : raw, { scope: command['scope'] as string, id: command['id'] as string, policyHash: command['policyHash'] as string });
    const account = state.accounts.find(item => item.id === command['accountId']);
    const ticket = state.reservations.find(item => item.id === command['reservationId']);
    if (['fork', 'reserveBundle', 'start', 'markUnknown', 'settle', 'cancelReservation', 'closeSubtree'].includes(method) && !account) invalid();
    if (['start', 'markUnknown', 'settle', 'cancelReservation'].includes(method) && (!ticket || ticket.accountId !== command['accountId'])) invalid();
    if (method === 'create') {
      fields(envelope!, ['snapshot', 'created']); if (typeof envelope!['created'] !== 'boolean') invalid(); const root = state.accounts.find(item => item.id === 'root')!;
      if (root.maxCostMicros !== command['maxCostMicros'] || root.maxCalls !== command['maxCalls']) invalid();
      if (envelope!['created'] === true && (state.version !== 1 || state.accounts.length !== 1 || state.bundles.length || root.closed || state.blocked)) invalid();
    } else if (method === 'fork') {
      if (account!.parentId !== command['parentId'] || account!.maxCostMicros !== command['maxCostMicros'] || account!.maxCalls !== command['maxCalls']) invalid();
    } else if (method === 'reserveBundle') {
      const bundle = state.bundles.find(item => item.id === command['bundleId']); const requested = command['operations'] as unknown as readonly DurableBudgetOperation[];
      if (!bundle || bundle.accountId !== command['accountId'] || bundle.operations.length !== requested.length
        || bundle.operations.some((item, index) => item.id !== requested[index]!.id || item.maxCostMicros !== requested[index]!.maxCostMicros)) invalid();
    } else if (method === 'start') {
      fields(envelope!, ['snapshot', 'status']); const status = envelope!['status'];
      if (!['started', 'already_started'].includes(status as string) || !['started', 'unknown', 'settled'].includes(ticket!.status)
        || (status === 'started' && ticket!.status !== 'started')) invalid();
      if (status === 'started') {
        if (state.blocked) invalid(); let current = account!;
        for (;;) { if (current.closed) invalid(); if (current.parentId === null) break; current = state.accounts.find(item => item.id === current.parentId)!; }
      }
    } else if (method === 'markUnknown') { if (!['unknown', 'settled'].includes(ticket!.status)) invalid(); }
    else if (method === 'settle') {
      fields(envelope!, ['snapshot', 'overrun']); if (ticket!.status !== 'settled' || ticket!.actualMicros !== command['actualMicros']
        || envelope!['overrun'] !== (ticket!.actualMicros! > ticket!.maxCostMicros)) invalid();
    } else if (method === 'cancelReservation') { if (ticket!.status !== 'cancelled') invalid(); }
    else if (method === 'closeSubtree') { if (!account!.closed) invalid(); }
    return (envelope ? immutable({ ...envelope, snapshot: state as unknown as JsonValue }) : state) as DurableBudgetMethodResult<M>;
  } catch { return corrupt(); }
}
