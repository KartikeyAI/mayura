import { MayuraError, freezeJson, jsonValue, type JsonValue } from '@mayura/core';
import { digest } from './definition.js';

/**
 * Reviewed in-place migration of an in-flight durable run from one definition version to another. The migration is a
 * declaration; the framework decides what is safe from the run's actual state and refuses everything else.
 */
export interface WorkflowMigrationOptions<F, T> {
  /** Stable identity recorded in the run's audit trail, for example `invoice-review-1-to-2` (letters, digits, `.`, `_`, `-`). */
  readonly id: string;
  readonly from: F;
  readonly to: T;
  /** Target node id -> source node id, for steps that were renamed. Only unstarted or waiting steps can be renamed. */
  readonly renames?: Readonly<Record<string, string>>;
  /** Target node ids whose definition changed but whose settled source result the reviewer accepts as-is. */
  readonly acceptCompleted?: readonly string[];
  /** Source node ids that settled and are removed by the new definition; the reviewer accepts dropping their results. */
  readonly acceptRemoved?: readonly string[];
  readonly description?: string;
}
export interface WorkflowMigration<F = unknown, T = unknown> {
  readonly kind: 'mayura.workflow-migration';
  readonly id: string;
  readonly from: F;
  readonly to: T;
  readonly renames: Readonly<Record<string, string>>;
  readonly acceptCompleted: readonly string[];
  readonly acceptRemoved: readonly string[];
  readonly description: string;
}

/**
 * One node of a definition, reduced to what a migration compares. `fingerprint` covers the node's full definition.
 * `evidence` names what a settled step's recorded state is bound to (for a tool step, the tool its receipt names):
 * a changed node can only accept an existing result when this is unchanged.
 */
export interface MigrationNode { readonly id: string; readonly kind: string; readonly dependsOn: readonly string[]; readonly fingerprint: string; readonly evidence?: string }

/** Evidence of a manifest node: the tool a receipt must name, or whether a human request carries a deadline. */
export function nodeEvidence(node: { readonly kind: string; readonly tool?: unknown; readonly deadlineAtMs?: unknown }): string | undefined {
  if (node.kind === 'tool' && typeof node.tool === 'string') return `tool:${node.tool}`;
  if (node.kind === 'human') return node.deadlineAtMs === null || node.deadlineAtMs === undefined ? 'human' : 'human:deadline';
  return undefined;
}
/** The run's current state of one source step, normalized across formats. */
export interface MigrationStep { readonly id: string; readonly status: string }

export type MigrationAction =
  | 'keep'        // unchanged node; state carried
  | 'update'      // changed node that never started; carried as pending under the new definition
  | 'reset'       // changed node that was waiting (approval, human, timer, signal); re-issued as pending
  | 'accept'      // changed node that settled; the reviewer accepts the existing result
  | 'add'         // new node; starts pending
  | 'remove';     // source node dropped by the new definition
export interface MigrationPlanEntry {
  readonly action: MigrationAction;
  /** Node id in the target definition (absent for `remove`). */
  readonly target?: string;
  /** Node id in the source definition (absent for `add`). */
  readonly source?: string;
  readonly status?: string;
}
export interface MigrationBlocker { readonly node: string; readonly reason: string }
export interface MigrationPlan {
  readonly migrationId: string;
  readonly format: string;
  readonly runId: string;
  readonly fromDigest: string;
  readonly toDigest: string;
  readonly entries: readonly MigrationPlanEntry[];
  readonly blockers: readonly MigrationBlocker[];
  readonly allowed: boolean;
}

/** Statuses of a step that has not started and holds nothing. */
const unstarted = new Set(['pending']);
/** Statuses of a step parked on an external decision; a changed definition re-issues the request. */
const parked = new Set(['waiting', 'approved', 'forward_waiting', 'compensation_waiting']);
/** Statuses with work possibly in flight or with an unresolved effect; never changed, removed or renamed. */
const inFlight = new Set(['dispatching', 'unknown', 'leased', 'started', 'running']);
/** Successfully settled statuses that dependent steps may build on (a bypassed lifecycle step never ran; its output is null). */
const succeeded = new Set(['succeeded', 'compensated', 'bypassed']);
/** A step whose condition did not hold: it holds nothing, so a changed definition decides the condition again. */
const reconsidered = new Set(['bypassed']);

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const nodePattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
/** Migration ids appear in URLs and audit events: no separators. */
const migrationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function defineWorkflowMigration<F, T>(options: WorkflowMigrationOptions<F, T>): WorkflowMigration<F, T> {
  try {
    if (!options || typeof options !== 'object' || typeof options.id !== 'string' || !migrationIdPattern.test(options.id) || !options.from || !options.to) throw new Error();
    const renames = Object.entries(options.renames ?? {});
    if (renames.length > 256 || renames.some(([to, from]) => !nodePattern.test(to) || typeof from !== 'string' || !nodePattern.test(from))
      || new Set(renames.map(([, from]) => from)).size !== renames.length) throw new Error();
    const list = (value: unknown): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > 256 || value.some(item => typeof item !== 'string' || !nodePattern.test(item))) throw new Error();
      return [...new Set(value as string[])].sort();
    };
    const description = options.description ?? '';
    if (typeof description !== 'string' || description.length > 2_048) throw new Error();
    return Object.freeze({ kind: 'mayura.workflow-migration' as const, id: options.id, from: options.from, to: options.to,
      renames: Object.freeze(Object.fromEntries(renames)), acceptCompleted: Object.freeze(list(options.acceptCompleted)),
      acceptRemoved: Object.freeze(list(options.acceptRemoved)), description });
  } catch { throw new MayuraError('INVALID_CONFIG', 'A workflow migration needs a bounded id, both definitions, and bounded node lists.'); }
}

export function assertWorkflowMigration(value: unknown): asserts value is WorkflowMigration {
  if (!value || typeof value !== 'object' || (value as WorkflowMigration).kind !== 'mayura.workflow-migration' || !Object.isFrozen(value)) {
    throw new MayuraError('INVALID_CONFIG', 'A genuine defineWorkflowMigration value is required.');
  }
}

/** Canonical fingerprint of one manifest node: every field except the node's id. */
export function nodeFingerprint(node: Readonly<Record<string, unknown>>): string {
  const { id: _id, ...rest } = node; void _id;
  return digest('mayura:migration-node:v1', freezeJson(jsonValue(rest)) as JsonValue);
}

/**
 * Decide, from the run's real state, what a migration does to each node. The format migrator applies the entries only
 * when `allowed`; blockers explain every refusal.
 */
export function planWorkflowMigration(input: {
  readonly migration: WorkflowMigration; readonly format: string; readonly runId: string; readonly fromDigest: string; readonly toDigest: string;
  readonly from: readonly MigrationNode[]; readonly to: readonly MigrationNode[]; readonly steps: readonly MigrationStep[];
  /** Format-level refusals found before node planning (for example: run not paused, run is a wait target). */
  readonly preconditions?: readonly MigrationBlocker[];
}): MigrationPlan {
  const { migration } = input;
  const source = new Map(input.from.map(node => [node.id, node])); const target = new Map(input.to.map(node => [node.id, node]));
  const status = new Map(input.steps.map(step => [step.id, step.status]));
  const blockers: MigrationBlocker[] = [...(input.preconditions ?? [])]; const entries: MigrationPlanEntry[] = [];
  const renamed = new Map(Object.entries(migration.renames)); const renamedSources = new Set(renamed.values());
  const accepted = new Set(migration.acceptCompleted); const removable = new Set(migration.acceptRemoved);
  if (input.fromDigest === input.toDigest) blockers.push({ node: '*', reason: 'The source and target definitions are identical.' });
  for (const [to, from] of renamed) {
    if (!target.has(to)) blockers.push({ node: to, reason: 'A rename targets a node the new definition does not have.' });
    if (!source.has(from)) blockers.push({ node: from, reason: 'A rename names a source node the old definition does not have.' });
    if (source.has(to) && to !== from) blockers.push({ node: to, reason: 'A rename cannot target a node id that still exists in the old definition.' });
  }
  for (const id of accepted) if (!target.has(id)) blockers.push({ node: id, reason: 'acceptCompleted names a node the new definition does not have.' });
  for (const id of removable) if (!source.has(id) || target.has(id)) blockers.push({ node: id, reason: 'acceptRemoved names a node that is not removed.' });

  const carried = new Map<string, string>(); // target id -> effective carried status
  for (const node of input.to) {
    const from = renamed.get(node.id) ?? (source.has(node.id) && !renamedSources.has(node.id) ? node.id : undefined);
    if (from === undefined) { entries.push({ action: 'add', target: node.id }); carried.set(node.id, 'pending'); continue; }
    const previous = source.get(from); const current = status.get(from) ?? 'pending';
    if (!previous) continue;
    const changed = previous.fingerprint !== node.fingerprint || previous.kind !== node.kind || from !== node.id;
    if (inFlight.has(current)) {
      if (changed) blockers.push({ node: node.id, reason: `Step "${from}" is ${current}; a step with work in flight or an unresolved effect cannot change.` });
      entries.push({ action: 'keep', target: node.id, source: from, status: current }); carried.set(node.id, current); continue;
    }
    if (!changed) { entries.push({ action: 'keep', target: node.id, source: from, status: current }); carried.set(node.id, current); continue; }
    if (previous.kind !== node.kind && !unstarted.has(current)) {
      blockers.push({ node: node.id, reason: `Step "${from}" already started as a ${previous.kind} and cannot become a ${node.kind}.` }); carried.set(node.id, current); continue;
    }
    if (unstarted.has(current)) { entries.push({ action: 'update', target: node.id, source: from, status: current }); carried.set(node.id, 'pending'); continue; }
    if (parked.has(current) || reconsidered.has(current)) { entries.push({ action: 'reset', target: node.id, source: from, status: current }); carried.set(node.id, 'pending'); continue; }
    // Blocked nodes still count with their current status below, so dependents report only root causes.
    if (from !== node.id) { blockers.push({ node: node.id, reason: `Step "${from}" already settled (${current}); settled steps cannot be renamed.` }); carried.set(node.id, current); continue; }
    if (!accepted.has(node.id)) {
      blockers.push({ node: node.id, reason: `Step "${from}" already settled (${current}) and its definition changed; list it in acceptCompleted to keep the existing result.` });
      carried.set(node.id, current); continue;
    }
    // A recorded result stays bound to what produced it: a receipt from one tool cannot stand for another tool.
    if (previous.evidence !== node.evidence) {
      blockers.push({ node: node.id, reason: `Step "${from}" settled (${current}) under ${previous.evidence ?? 'another definition'}; the new definition names ${node.evidence ?? 'something else'}, so its result cannot be accepted.` });
      carried.set(node.id, current); continue;
    }
    entries.push({ action: 'accept', target: node.id, source: from, status: current }); carried.set(node.id, current);
  }
  for (const node of input.from) {
    const kept = target.has(node.id) && !renamedSources.has(node.id) && !renamed.has(node.id);
    if (kept || renamedSources.has(node.id)) continue;
    const current = status.get(node.id) ?? 'pending';
    if (inFlight.has(current)) blockers.push({ node: node.id, reason: `Step "${node.id}" is ${current} and cannot be removed.` });
    else if (!unstarted.has(current) && !parked.has(current) && current !== 'skipped' && !reconsidered.has(current) && !removable.has(node.id)) {
      blockers.push({ node: node.id, reason: `Step "${node.id}" already settled (${current}); list it in acceptRemoved to drop its result.` });
    } else entries.push({ action: 'remove', source: node.id, status: current });
  }
  // A step that keeps a started or settled state must have dependencies that already succeeded under the new graph.
  for (const node of input.to) {
    const current = carried.get(node.id);
    if (current === undefined || unstarted.has(current)) continue;
    for (const dependency of node.dependsOn) {
      const dependencyStatus = carried.get(dependency) ?? 'pending';
      if (!succeeded.has(dependencyStatus)) blockers.push({ node: node.id, reason: `Step "${node.id}" is ${current} but its new dependency "${dependency}" has not succeeded.` });
    }
  }
  return freezeJson(jsonValue({ migrationId: migration.id, format: input.format, runId: input.runId, fromDigest: input.fromDigest, toDigest: input.toDigest,
    entries, blockers, allowed: blockers.length === 0 })) as unknown as MigrationPlan;
}

/** Result of a migration request: always the plan; the migrated snapshot unless it was a dry run. */
export interface WorkflowMigrationResult<S> { readonly plan: MigrationPlan; readonly snapshot?: S }

/** Audit event payload recorded with every applied migration. */
export function migrationEvent(plan: MigrationPlan, actorId: string, commandId: string): { readonly type: 'run.migrated'; readonly data: Record<string, JsonValue> } {
  return { type: 'run.migrated', data: { migrationId: plan.migrationId, from: plan.fromDigest, to: plan.toDigest, actorId, commandId,
    actions: plan.entries.map(entry => `${entry.action}:${entry.target ?? entry.source}`).join(',').slice(0, 2_048) } };
}

/** Reject a plan with blockers, surfacing the first reason. */
export function assertMigrationAllowed(plan: MigrationPlan): void {
  if (!plan.allowed) throw new MayuraError('CONFLICT', `Migration refused: ${plan.blockers[0]?.reason ?? 'unknown reason'}`);
}

/** Identity of the actor and command applying a migration; both are recorded in the audit event. */
export interface MigrationCommand { readonly id: string; readonly actorId: string; readonly commandId: string; readonly dryRun?: boolean }
export function migrationCommand(value: MigrationCommand): MigrationCommand {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id) || typeof value.actorId !== 'string' || !identifier.test(value.actorId)
    || typeof value.commandId !== 'string' || !identifier.test(value.commandId) || (value.dryRun !== undefined && typeof value.dryRun !== 'boolean')) {
    throw new MayuraError('INVALID_INPUT', 'A migration command needs a run id, a bounded actor id and a bounded command id.');
  }
  return value;
}

/** Reviewed migrations a host offers, indexed by source definition digest. */
export interface WorkflowMigrationCatalog<M extends WorkflowMigration = WorkflowMigration> {
  /** Migrations whose source is the given pinned definition digest, in registration order. */
  from(definitionHash: string): readonly M[];
  get(id: string): M | undefined;
  readonly all: readonly M[];
}
export function createWorkflowMigrationCatalog<M extends WorkflowMigration>(migrations: readonly M[]): WorkflowMigrationCatalog<M> {
  if (!Array.isArray(migrations) || migrations.length > 1_024) throw new MayuraError('INVALID_CONFIG', 'A migration catalog holds at most 1,024 migrations.');
  const byId = new Map<string, M>(); const bySource = new Map<string, M[]>();
  for (const migration of migrations) {
    const candidate: unknown = migration; assertWorkflowMigration(candidate);
    const from = (migration.from as { readonly digest?: unknown }).digest; const to = (migration.to as { readonly digest?: unknown }).digest;
    if (typeof from !== 'string' || typeof to !== 'string' || from === to) throw new MayuraError('INVALID_CONFIG', `Migration "${migration.id}" must connect two different definition versions.`);
    if (byId.has(migration.id)) throw new MayuraError('INVALID_CONFIG', `Migration id "${migration.id}" is registered twice.`);
    byId.set(migration.id, migration); bySource.set(from, [...(bySource.get(from) ?? []), migration]);
  }
  return Object.freeze({ from: (definitionHash: string) => Object.freeze([...(bySource.get(definitionHash) ?? [])]),
    get: (id: string) => byId.get(id), all: Object.freeze([...migrations]) });
}
