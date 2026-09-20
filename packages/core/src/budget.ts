import { MayuraError, assertPositiveInteger } from './errors.js';

export interface Reservation {
  /** Settle only confirmed cost. Unknown cost deliberately retains the complete reservation. */
  settle(actualMicros: number): void;
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

interface Ledger { readonly ids: Set<string>; blocked: boolean }
interface Account {
  readonly ledger: Ledger;
  readonly ancestors: readonly Account[];
  readonly identity: BudgetIdentity;
  readonly maxCostMicros: number;
  readonly maxCalls: number;
  reserved: bigint;
  spent: bigint;
  calls: number;
  closed: boolean;
}

const maximumAccounts = 1_024;
const maximumDepth = 32;
const safeInteger = BigInt(Number.MAX_SAFE_INTEGER);
// Runtime-private state prevents JavaScript writes to TypeScript-only private/readonly fields.
const accounts = new WeakMap<Budget, Account>();

function costLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new MayuraError('INVALID_CONFIG', 'maxCostMicros must be a non-negative safe integer.');
}

/** Reject structural lookalikes, inherited prototypes, and proxy wrappers around real accounts. */
export function assertBudget(value: unknown): asserts value is Budget {
  if (typeof value !== 'object' || value === null || !accounts.has(value as Budget)) {
    throw new MayuraError('INVALID_CONFIG', 'A genuine shared execution Budget is required.');
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
      ledger: { ids: new Set(['root']), blocked: false }, ancestors: Object.freeze([]),
      identity: Object.freeze({ id: 'root', lineage: Object.freeze(['root']), depth: 0 }),
      maxCostMicros, maxCalls, reserved: 0n, spent: 0n, calls: 0, closed: false,
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
      maxCostMicros: config.maxCostMicros, maxCalls: config.maxCalls, reserved: 0n, spent: 0n, calls: 0, closed: false,
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
    if (path.some(ancestor => ancestor.calls >= ancestor.maxCalls || bound > BigInt(ancestor.maxCostMicros) - ancestor.spent - ancestor.reserved)) {
      throw new MayuraError('BUDGET_EXCEEDED', 'Execution budget exhausted; no new call was dispatched.');
    }
    // No callback or await can interleave ancestor validation and commit.
    for (const ancestor of path) { ancestor.calls++; ancestor.reserved += bound; }
    let settled = false;
    return Object.freeze({
      settle: (actualMicros: number): void => {
        if (settled) throw new MayuraError('CONFLICT', 'Reservation is already settled.');
        if (!Number.isSafeInteger(actualMicros) || actualMicros < 0) {
          throw new MayuraError('BUDGET_EXCEEDED', 'Reported cost is invalid; reservation retained.');
        }
        settled = true;
        // Closing, cancellation, or another reservation's overrun never discards known late usage.
        for (const ancestor of path) { ancestor.reserved -= bound; ancestor.spent += BigInt(actualMicros); }
        if (actualMicros > maxMicros) {
          account.ledger.blocked = true;
          throw new MayuraError('BUDGET_EXCEEDED', 'Reported cost exceeded its bound; full actual usage recorded.');
        }
      },
    });
  }

  /** Stop new reserves/forks throughout this subtree; retain all unresolved usage and permit settlement. */
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
