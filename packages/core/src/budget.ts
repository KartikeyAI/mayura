import { MayuraError, assertPositiveInteger } from './errors.js';

export interface Reservation {
  /** Settle only confirmed cost. Unknown cost deliberately retains the complete reservation. */
  settle(actualMicros: number): void;
  /** Atomically charge confirmed usage, retain an unresolved bound and release unused capacity. */
  settleUsage(knownCostMicros: number, unknownCostMicros: number): void;
}

/** One fixed-cost future execution; IDs remain unique throughout their shared ledger's lifetime. */
export interface BundleOperation {
  readonly id: string;
  readonly maxCostMicros: number;
}

/** Genuine receiver-bound authority for one held execution, not an executor or a transferable ID. */
export interface BudgetTicket {
  readonly id: string;
  readonly maxCostMicros: number;
  /** Consume one held call exactly once. Monetary settlement remains independently required. */
  start(): Reservation;
  /** Release only never-started capacity, including after account closure; repeated cancellation is harmless. */
  cancel(): void;
}

/** Atomically admitted future calls. Closure cancels held tickets, never already-started usage. */
export interface BudgetBundle {
  readonly tickets: readonly BudgetTicket[];
  close(): void;
}

/** Child limits are ceilings on shared funds, not prepaid allocations or guaranteed earmarks. */
export interface BudgetForkOptions {
  /** Unique within the entire ledger; root is reserved and closed identities cannot be reused. */
  readonly id: string;
  readonly maxCostMicros: number;
  readonly maxCalls: number;
}

/** Correlate account usage without exposing an authority-bearing parent/root account reference. */
export interface BudgetIdentity {
  readonly id: string;
  readonly parentId?: string;
  /** Root identity is included; the root has depth zero. */
  readonly lineage: readonly string[];
  readonly depth: number;
}

export interface BudgetSnapshot {
  readonly spentMicros: number | string;
  readonly reservedMicros: number;
  readonly calls: number;
}

interface Ledger {
  readonly ids: Set<string>;
  readonly ticketIds: Set<string>;
  /** Only named bundle tickets count here: held plus started but not yet validly settled. */
  outstandingTickets: number;
  blocked: boolean;
}
interface Account {
  readonly ledger: Ledger;
  readonly ancestors: readonly Account[];
  readonly identity: BudgetIdentity;
  readonly maxCostMicros: number;
  readonly maxCalls: number;
  reserved: bigint;
  spent: bigint;
  calls: number;
  heldCalls: number;
  closed: boolean;
}

interface TicketState {
  readonly account: Account;
  readonly path: readonly Account[];
  readonly maxCostMicros: number;
  readonly bound: bigint;
  status: 'held' | 'started' | 'cancelled' | 'settled' | 'unknown';
}
interface BundleState { readonly tickets: readonly TicketState[]; closed: boolean }

const maximumAccounts = 1_024;
const maximumDepth = 32;
const maximumBundleOperations = 128;
const maximumOutstandingTickets = 1_024;
const maximumTicketIds = 16_384;
const safeInteger = BigInt(Number.MAX_SAFE_INTEGER);
// Runtime-private state prevents JavaScript writes to TypeScript-only private/readonly fields.
const accounts = new WeakMap<Budget, Account>();
const tickets = new WeakMap<BudgetTicket, TicketState>();
const bundles = new WeakMap<BudgetBundle, BundleState>();

function costLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new MayuraError('INVALID_CONFIG', 'maxCostMicros must be a non-negative safe integer.');
}

/** Reject structural lookalikes, inherited prototypes, and proxy wrappers around real accounts. */
export function assertBudget(value: unknown): asserts value is Budget {
  if (typeof value !== 'object' || value === null || !accounts.has(value as Budget)) {
    throw new MayuraError('INVALID_CONFIG', 'A genuine shared execution Budget is required.');
  }
}

/** Trusted-host ownership check; a common ledger or copied identity does not convey this account's authority. */
export function assertBudgetTicket(value: unknown, owner: Budget): asserts value is BudgetTicket {
  assertBudget(owner);
  const ticket = typeof value === 'object' && value !== null ? tickets.get(value as BudgetTicket) : undefined;
  if (!ticket || ticket.account !== accounts.get(owner)) {
    throw new MayuraError('INVALID_CONFIG', 'A genuine execution ticket owned by the exact account is required.');
  }
}

function accountFor(value: Budget): Account {
  assertBudget(value);
  return accounts.get(value)!;
}

function pathFor(account: Account): readonly Account[] { return [...account.ancestors, account]; }

function assertOpen(account: Account, path: readonly Account[]): void {
  if (account.ledger.blocked || path.some(ancestor => ancestor.closed)) {
    throw new MayuraError('BUDGET_EXCEEDED', 'Execution budget admissions are closed; no new call was dispatched.');
  }
}

/** Snapshot child configuration without invoking accessor properties or reflecting thrown text. */
function forkOptions(value: BudgetForkOptions): BudgetForkOptions {
  let id: unknown; let maxCostMicros: unknown; let maxCalls: unknown;
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 3 || keys.some(key => !['id', 'maxCostMicros', 'maxCalls'].includes(key as string))) throw new Error();
    for (const key of ['id', 'maxCostMicros', 'maxCalls'] as const) if (!descriptors[key] || !('value' in descriptors[key])) throw new Error();
    id = descriptors['id']!.value; maxCostMicros = descriptors['maxCostMicros']!.value; maxCalls = descriptors['maxCalls']!.value;
  } catch { throw new MayuraError('INVALID_CONFIG', 'Child budget configuration must contain plain data fields.'); }
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id)) {
    throw new MayuraError('INVALID_CONFIG', 'Child budget ID must be a bounded stable identifier.');
  }
  costLimit(maxCostMicros as number); assertPositiveInteger(maxCalls as number, 'maxCalls');
  return { id, maxCostMicros: maxCostMicros as number, maxCalls: maxCalls as number };
}

/** Snapshot every supplied descriptor before checking mutable ledger state; never execute getters or iterators. */
function bundleOperations(value: readonly BundleOperation[]): readonly BundleOperation[] {
  const excessiveLength = Symbol('bundle-length');
  try {
    if (!Array.isArray(value)) throw new Error();
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 1) throw new Error();
    if (length.value > maximumBundleOperations) throw excessiveLength;
    const size = length.value as number;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== size + 1 || keys.some(key => key !== 'length'
      && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= size))) throw new Error();
    const result: BundleOperation[] = [];
    for (let index = 0; index < size; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor)) throw new Error();
      const operation = descriptor.value as unknown;
      if (!operation || typeof operation !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(operation))) throw new Error();
      const fields = Object.getOwnPropertyDescriptors(operation);
      const fieldKeys = Reflect.ownKeys(fields);
      if (fieldKeys.length !== 2 || fieldKeys.some(key => key !== 'id' && key !== 'maxCostMicros')
        || !fields['id'] || !('value' in fields['id']) || !fields['maxCostMicros'] || !('value' in fields['maxCostMicros'])) throw new Error();
      const id: unknown = fields['id'].value; const maxCostMicros: unknown = fields['maxCostMicros'].value;
      if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(id)
        || typeof maxCostMicros !== 'number' || !Number.isSafeInteger(maxCostMicros) || maxCostMicros < 0) throw new Error();
      result.push({ id, maxCostMicros });
    }
    return result;
  } catch (error) {
    if (error === excessiveLength) throw new MayuraError('LIMIT_EXCEEDED', 'The execution bundle operation limit was reached.');
    throw new MayuraError('INVALID_CONFIG', 'Bundle operations must be a bounded list of plain execution identities and cost bounds.');
  }
}

/** Existing settlement semantics, shared by ordinary reservations and consumed bundle tickets. */
function reservationFor(account: Account, path: readonly Account[], maxMicros: number, ticket?: TicketState): Reservation {
  const bound = BigInt(maxMicros); let settled = false;
  const settleUsage = (knownCostMicros: number, unknownCostMicros: number): void => {
    if (settled) throw new MayuraError('CONFLICT', 'Reservation is already settled.');
    if (!Number.isSafeInteger(knownCostMicros) || knownCostMicros < 0
      || !Number.isSafeInteger(unknownCostMicros) || unknownCostMicros < 0) {
      throw new MayuraError('BUDGET_EXCEEDED', 'Reported cost is invalid; reservation retained.');
    }
    settled = true;
    const known = BigInt(knownCostMicros); const unknown = BigInt(unknownCostMicros);
    // Closing, cancellation, or another reservation's overrun never discards known late usage.
    for (const ancestor of path) { ancestor.reserved -= bound; ancestor.reserved += unknown; ancestor.spent += known; }
    if (ticket) {
      ticket.status = unknownCostMicros === 0 ? 'settled' : 'unknown';
      if (unknownCostMicros === 0) account.ledger.outstandingTickets--;
    }
    if (known + unknown > bound) {
      account.ledger.blocked = true;
      throw new MayuraError('BUDGET_EXCEEDED', 'Reported usage exceeded its bound; known and unresolved usage were retained.');
    }
  };
  return Object.freeze({
    settle: (actualMicros: number): void => { settleUsage(actualMicros, 0); },
    settleUsage,
  });
}

function ticketFor(value: BudgetTicket): TicketState {
  const ticket = tickets.get(value);
  if (!ticket) throw new MayuraError('INVALID_CONFIG', 'A genuine execution ticket receiver is required.');
  return ticket;
}

/** Private cleanup deliberately ignores closure and overruns: undispatched holds are still releasable. */
function cancelHeld(ticket: TicketState): void {
  ticket.status = 'cancelled';
  for (const ancestor of ticket.path) { ancestor.heldCalls--; ancestor.reserved -= ticket.bound; }
  ticket.account.ledger.outstandingTickets--;
}

function startTicket(this: BudgetTicket): Reservation {
  const ticket = ticketFor(this);
  if (ticket.status !== 'held') throw new MayuraError('CONFLICT', 'Execution ticket is no longer held.');
  assertOpen(ticket.account, ticket.path);
  // Every admission already counts these held slots; converting one cannot increase total capacity use.
  ticket.status = 'started';
  for (const ancestor of ticket.path) { ancestor.heldCalls--; ancestor.calls++; }
  return reservationFor(ticket.account, ticket.path, ticket.maxCostMicros, ticket);
}

function cancelTicket(this: BudgetTicket): void {
  const ticket = ticketFor(this);
  if (ticket.status === 'cancelled') return;
  if (ticket.status !== 'held') throw new MayuraError('CONFLICT', 'Started execution tickets cannot be cancelled.');
  cancelHeld(ticket);
}

function closeBundle(this: BudgetBundle): void {
  const bundle = bundles.get(this);
  if (!bundle) throw new MayuraError('INVALID_CONFIG', 'A genuine execution bundle receiver is required.');
  if (bundle.closed) return;
  for (const ticket of bundle.tickets) if (ticket.status === 'held') cancelHeld(ticket);
  bundle.closed = true;
}

/**
 * Process-local shared synchronous ledger. Reserve before awaits so children cannot spend
 * the same remaining funds. Ancestor totals include descendants and must not be added together.
 * Every admitted execution counts once at each ancestor, even when its monetary bound is zero.
 * Accounts are final, frozen authority handles; they are not a sandbox for arbitrary local code.
 */
export class Budget {
  constructor(readonly maxCostMicros: number, readonly maxCalls: number) {
    if (new.target !== Budget) throw new MayuraError('INVALID_CONFIG', 'Budget accounts cannot be subclassed.');
    costLimit(maxCostMicros); assertPositiveInteger(maxCalls, 'maxCalls');
    accounts.set(this, {
      ledger: { ids: new Set(['root']), ticketIds: new Set(), outstandingTickets: 0, blocked: false }, ancestors: Object.freeze([]),
      identity: Object.freeze({ id: 'root', lineage: Object.freeze(['root']), depth: 0 }),
      maxCostMicros, maxCalls, reserved: 0n, spent: 0n, calls: 0, heldCalls: 0, closed: false,
    });
    Object.freeze(this);
  }

  /** Frozen correlation metadata; contains no reference through which a child could spend as its parent. */
  get identity(): BudgetIdentity { return accountFor(this).identity; }

  /**
   * Create a child ceiling without consuming funds or calls. Children compete for remaining
   * ancestor capacity at reserve time. At most 1,024 lifetime accounts and depth 32 per ledger.
   */
  fork(options: BudgetForkOptions): Budget {
    const parent = accountFor(this); const path = pathFor(parent);
    const config = forkOptions(options);
    assertOpen(parent, path);
    if (config.maxCostMicros > parent.maxCostMicros || config.maxCalls > parent.maxCalls) {
      throw new MayuraError('INVALID_CONFIG', 'Child ceilings cannot exceed their parent ceilings.');
    }
    if (parent.ledger.ids.has(config.id)) throw new MayuraError('CONFLICT', 'The budget account identity is already in use.');
    if (parent.identity.depth >= maximumDepth || parent.ledger.ids.size >= maximumAccounts) {
      throw new MayuraError('LIMIT_EXCEEDED', 'The budget account count or ancestry depth limit was reached.');
    }
    const child = new Budget(config.maxCostMicros, config.maxCalls);
    const identity: BudgetIdentity = Object.freeze({ id: config.id, parentId: parent.identity.id,
      lineage: Object.freeze([...parent.identity.lineage, config.id]), depth: parent.identity.depth + 1,
    });
    accounts.set(child, { ledger: parent.ledger, ancestors: Object.freeze(path), identity,
      maxCostMicros: config.maxCostMicros, maxCalls: config.maxCalls, reserved: 0n, spent: 0n, calls: 0, heldCalls: 0, closed: false,
    });
    parent.ledger.ids.add(config.id);
    return child;
  }

  /** Atomically reserve every ancestor before dispatch; rejected admission changes no counter. */
  reserve(maxMicros: number): Reservation {
    const account = accountFor(this); const path = Object.freeze(pathFor(account));
    if (!Number.isSafeInteger(maxMicros) || maxMicros < 0) throw new MayuraError('INVALID_CONFIG', 'A non-negative safe-integer cost bound is required.');
    assertOpen(account, path);
    const bound = BigInt(maxMicros);
    if (path.some(ancestor => ancestor.heldCalls >= ancestor.maxCalls - ancestor.calls || bound > BigInt(ancestor.maxCostMicros) - ancestor.spent - ancestor.reserved)) {
      throw new MayuraError('BUDGET_EXCEEDED', 'Execution budget exhausted; no new call was dispatched.');
    }
    // No callback or await can interleave ancestor validation and commit.
    for (const ancestor of path) { ancestor.calls++; ancestor.reserved += bound; }
    return reservationFor(account, path, maxMicros);
  }

  /**
   * Atomically protect 1–128 future calls and their money on this account and every ancestor.
   * Each ledger permits 1,024 held/unsettled bundle tickets and 16,384 lifetime ticket identities.
   * Held calls do not count as consumed calls until start; failed admission never burns identities.
   * IDs use 1–256 ASCII letters/digits plus internal '.', '_', ':', '/', or '-'.
   */
  reserveBundle(operations: readonly BundleOperation[]): BudgetBundle {
    const account = accountFor(this); const path = Object.freeze(pathFor(account));
    const config = bundleOperations(operations);
    const identities = new Set(config.map(operation => operation.id));
    const bound = config.reduce((total, operation) => total + BigInt(operation.maxCostMicros), 0n);
    // Reflection above can invoke a trusted Proxy trap that reenters this account. Therefore all
    // mutable ledger predicates are evaluated only after the complete descriptor snapshot.
    assertOpen(account, path);
    if (identities.size !== config.length || config.some(operation => account.ledger.ticketIds.has(operation.id))) {
      throw new MayuraError('CONFLICT', 'An execution ticket identity is already in use.');
    }
    if (account.ledger.outstandingTickets + config.length > maximumOutstandingTickets
      || account.ledger.ticketIds.size + config.length > maximumTicketIds) {
      throw new MayuraError('LIMIT_EXCEEDED', 'The execution ticket count or lifetime identity limit was reached.');
    }
    if (path.some(ancestor => config.length > ancestor.maxCalls - ancestor.calls - ancestor.heldCalls
      || bound > BigInt(ancestor.maxCostMicros) - ancestor.spent - ancestor.reserved)) {
      throw new MayuraError('BUDGET_EXCEEDED', 'Execution budget exhausted; no future call was admitted.');
    }
    const states: TicketState[] = [];
    const handles = config.map(operation => {
      const state: TicketState = { account, path, maxCostMicros: operation.maxCostMicros, bound: BigInt(operation.maxCostMicros), status: 'held' };
      const handle: BudgetTicket = Object.freeze({ id: operation.id, maxCostMicros: operation.maxCostMicros, start: startTicket, cancel: cancelTicket });
      states.push(state); tickets.set(handle, state); return handle;
    });
    const bundle: BudgetBundle = Object.freeze({ tickets: Object.freeze(handles), close: closeBundle });
    bundles.set(bundle, { tickets: Object.freeze(states), closed: false });
    for (const ancestor of path) { ancestor.reserved += bound; ancestor.heldCalls += config.length; }
    for (const operation of config) account.ledger.ticketIds.add(operation.id);
    account.ledger.outstandingTickets += config.length;
    return bundle;
  }

  /** Frozen future-call capacity, including descendants; additive to the unchanged usage snapshot. */
  capacitySnapshot(): Readonly<{ heldCalls: number }> {
    return Object.freeze({ heldCalls: accountFor(this).heldCalls });
  }

  /** Stop new reserves/forks/starts throughout this subtree; explicit cleanup and late settlement remain valid. */
  close(): void { accountFor(this).closed = true; }

  /** Very large provider overruns use an exact decimal string instead of a lossy JSON number. */
  snapshot(): Readonly<BudgetSnapshot> {
    const account = accountFor(this);
    const spentMicros = account.spent <= safeInteger ? Number(account.spent) : account.spent.toString();
    // Reservations remain bounded by the originally configured safe-integer ceiling, even after overruns.
    return Object.freeze({ spentMicros, reservedMicros: Number(account.reserved), calls: account.calls });
  }
}

// Protect the owned method table as well as instances; this does not modify host/built-in prototypes.
Object.freeze(Budget.prototype);
Object.freeze(Budget);
