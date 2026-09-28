import { createHash } from 'node:crypto';
import { jsonValue, type ExecutionReceipt, type ExecutionSettlement, type JsonObject, type JsonValue } from '@mayura/core';
import {
  assertWorkflowStateMatchesManifest, initialWorkflowState, mergeWorkflowReceipt, workflowHashMaterial,
  workflowManifest, workflowPolicy, workflowResources, workflowState,
  type Claim, type EvidenceDisposition, type JobRecord, type ScheduledWorkflowSnapshot, type SchedulerEvidence,
  type WorkflowFormat2State, type WorkflowFormat2Step, type WorkflowManifest, type WorkflowManifestNode,
  type WorkflowPolicyManifest, type WorkflowResourcePlan, type ExecutionRef, type ExecutionCompletion,
  workflowGraphManifest, workflowGraphState, workflowGraphResources, workflowGraphTargets, initialWorkflowGraphState,
  assertWorkflowGraphStateMatchesManifest, type WorkflowGraphManifest, type WorkflowGraphManifestNode,
  type WorkflowGraphFormat3State, type WorkflowGraphFormat3Step, type WorkflowGraphStoreSnapshot,
  workflowGraphDiscoveryCommand, workflowGraphDiscoveryPage,
  type WorkflowGraphDiscoveryStore, type WorkflowGraphDiscoveryScan, type WorkflowGraphDiscoveryCandidate,
} from '@mayura/storage-contracts';
import { StorageError, type StoredEventInput } from './contracts.js';
import { aggregateRecord, createAggregate, initializeOwnership, loadAggregate, lockRunIdentity, lockSql,
  storageClock, storedInteger, writeAggregate, type AggregateRow } from './aggregate-session.js';
import { ResourceBusy, SchedulerDatabase, type SchedulerBackend, type SchedulerSession } from './scheduler-database.js';
import { fields, hash, integer, object } from './scheduler-validation.js';
import { scheduledCommand, type ScheduledMethod } from './scheduled-validation.js';
import { createCommand, identifier, nextCounter } from './validation.js';
import { checkCompletion, initializeCompletions, readCompletion } from './execution-completions.js';
import { initializeWorkflowGraphDiscoveryIndex } from './workflow-graph-discovery-index.js';

interface Journal { id: string; digest: string; version: number; operation: string }
interface Owner {
  format: 1 | 2; manifest: Manifest; policy: WorkflowPolicyManifest; resources: WorkflowResourcePlan;
  clockFloor: number; commands: Journal[];
  /** Definition digests this run was migrated from, oldest first. Job history pinned to them stays valid. */
  lineage?: string[];
}
interface OwnerRow {
  scope: string; aggregate_id: string; profile: number; aggregate_version: number | string;
  definition_hash: string; policy_hash: string; resource_hash: string; data: string;
}
interface Link { node_id: string; job_id: string }
interface WaitTargetRow {
  scope: string; aggregate_id: string; node_id: string; ordinal: number | string; run_id: string; definition_hash: string; policy_hash: string;
}
type Manifest = WorkflowManifest | WorkflowGraphManifest;
type Node = WorkflowManifestNode | WorkflowGraphManifestNode;
type State = WorkflowFormat2State | WorkflowGraphFormat3State;
type Step = WorkflowFormat2Step | WorkflowGraphFormat3Step;
type Snapshot = ScheduledWorkflowSnapshot | WorkflowGraphStoreSnapshot;
type WaitTargets = Readonly<Record<string, readonly ExecutionRef[]>>;
interface LockedRun {
  row: AggregateRow; owner: Owner; ownerRow: OwnerRow; state: State;
  jobs: JobRecord[]; clock: { value: number }; events: StoredEventInput[];
  waits: WaitTargets; facts: Readonly<Record<string, readonly ExecutionCompletion[] | undefined>>;
  /** Transaction-local observations only; even absent facts are re-read by the next command. */
  targetFacts: Map<string, ExecutionCompletion | undefined>;
}
type ToolNode = Extract<WorkflowManifestNode, { kind: 'tool' }>;
const terminalSteps = new Set(['succeeded','failed','blocked','unknown','skipped']);
const terminalRuns = new Set(['succeeded','failed','blocked','outcome_unknown','cancelled']);
const STALE = Symbol('scheduled-stale');
const REVIEW_EXPIRED = Symbol('scheduled-review-expired');
function failed(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored scheduled workflow failed integrity validation.'); }
function conflict(): never { throw new StorageError('CONFLICT', 'Scheduled workflow state or command content changed.'); }
function limited(): never { throw new StorageError('LIMIT_EXCEEDED', 'Scheduled workflow history or output limit was reached.'); }
function digest(domain: string, value: unknown): string { return createHash('sha256').update(workflowHashMaterial(domain, value)).digest('hex'); }
function same(a: unknown, b: unknown): boolean { return workflowHashMaterial('compare', a) === workflowHashMaterial('compare', b); }
function graphManifest(manifest: Manifest): manifest is WorkflowGraphManifest { return 'format' in manifest && manifest.format === 3; }
interface AccountingProjection { readonly receipt: ExecutionReceipt; readonly settlement: ExecutionSettlement }

function executionSettlement(value: ExecutionSettlement | undefined, receipt: ExecutionReceipt, maximum: number): ExecutionSettlement {
  const fallback = receipt.execution === 'unknown' ? {knownCostMicros:0,unknownCostMicros:maximum}
    : receipt.execution === 'not_started' ? {knownCostMicros:0,unknownCostMicros:0}
      : {knownCostMicros:maximum,unknownCostMicros:0};
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result.knownCostMicros) || result.knownCostMicros < 0
    || !Number.isSafeInteger(result.unknownCostMicros) || result.unknownCostMicros < 0
    || result.knownCostMicros > maximum - result.unknownCostMicros
    || (receipt.execution !== 'unknown' && result.unknownCostMicros !== 0)
    || (receipt.execution === 'not_started' && result.knownCostMicros !== 0)) failed();
  return Object.freeze({knownCostMicros:result.knownCostMicros,unknownCostMicros:result.unknownCostMicros});
}

/** Finite integrated reducer. Every mutation uses its caller-owned connection/transaction. */
export class ScheduledWorkflowDatabase {
  private initialized = false;
  private discoveryInitialized = false;
  constructor(private readonly backend: SchedulerBackend, private readonly scheduler: SchedulerDatabase) {}
  private table(name: 'owners' | 'jobs' | 'wait_targets'): string { return `${this.backend.prefix}mayura_workflow_${name}`; }
  private hashEnrollment(manifest: Manifest, policy: WorkflowPolicyManifest, resources: WorkflowResourcePlan) {
    return { scope: digest('mayura:scope:v1',policy.scope), definition: digest(graphManifest(manifest) ? 'mayura:workflow:v2' : 'mayura:workflow:v1',manifest),
      policy: digest('mayura:policy:v1',policy), resources: digest('mayura:workflow-resources:v1',resources) };
  }
  private decode(row: OwnerRow, aggregate: AggregateRow): Owner {
    try {
      if (![1,2].includes(Number(row.profile)) || row.scope !== aggregate.scope || row.aggregate_id !== aggregate.id || storedInteger(row.aggregate_version) !== storedInteger(aggregate.version)) failed();
      const raw = object(JSON.parse(row.data));
      fields(raw,Object.hasOwn(raw,'lineage') ? ['format','manifest','policy','resources','clockFloor','commands','lineage'] : ['format','manifest','policy','resources','clockFloor','commands']);
      const lineage = raw['lineage'] === undefined ? undefined : raw['lineage'];
      if (lineage !== undefined && (!Array.isArray(lineage) || lineage.length < 1 || lineage.length > 64 || lineage.some(item => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item)))) failed();
      if (raw['format'] !== Number(row.profile)) failed(); integer(raw['clockFloor']);
      const manifest = raw['format'] === 2 ? workflowGraphManifest(raw['manifest']) : workflowManifest(raw['manifest']);
      const policy = workflowPolicy(raw['policy']);
      const resources = graphManifest(manifest) ? workflowGraphResources(raw['resources'],manifest) : workflowResources(raw['resources'],manifest);
      if (!same(manifest,raw['manifest']) || !same(policy,raw['policy']) || !same(resources,raw['resources'])) failed();
      const hashes = this.hashEnrollment(manifest,policy,resources);
      if (hashes.scope !== aggregate.scope || hashes.definition !== aggregate.definition_hash || hashes.definition !== row.definition_hash || hashes.policy !== row.policy_hash || hashes.resources !== row.resource_hash) failed();
      if (!Array.isArray(raw['commands']) || raw['commands'].length > 1024) failed();
      const ids = new Set<string>(); let lastVersion = 0;
      for (const entry of raw['commands']) {
        const command = object(entry); fields(command,['id','digest','version','operation']);
        const id = identifier(command['id'],'Stored command'); if (ids.has(id)) failed(); ids.add(id);
        hash(command['digest']); identifier(command['operation'],'Stored operation'); integer(command['version'],1,storedInteger(aggregate.version));
        if ((command['version'] as number) <= lastVersion) failed(); lastVersion = command['version'] as number;
      }
      return { format: raw['format'] as 1 | 2, manifest, policy, resources, clockFloor: raw['clockFloor'] as number, commands: raw['commands'] as unknown as Journal[],
        ...(lineage === undefined ? {} : { lineage: lineage as string[] }) };
    } catch { return failed(); }
  }
  private checkedState(row: AggregateRow, owner: Owner): State {
    try {
      let state: State;
      if (graphManifest(owner.manifest)) { state = workflowGraphState(aggregateRecord(row)); assertWorkflowGraphStateMatchesManifest(state,owner.manifest); }
      else { state = workflowState(aggregateRecord(row)); assertWorkflowStateMatchesManifest(state,owner.manifest); }
      const hashes = this.hashEnrollment(owner.manifest,owner.policy,owner.resources);
      if (state.definition !== hashes.definition || state.policy !== hashes.policy || state.maxCostMicros !== owner.policy.maxCostMicros) failed();
      jsonValue(state.input,{maxBytes:owner.policy.maxOutputBytes}); jsonValue(state.output,{maxBytes:owner.policy.maxOutputBytes});
      for (const step of Object.values(state.steps)) jsonValue(step.output,{maxBytes:owner.policy.maxOutputBytes});
      return state;
    } catch { return failed(); }
  }
  private async load(tx: SchedulerSession, scope: string, id: string, policyHash: string, skip = false, profile?: 1 | 2): Promise<LockedRun | undefined> {
    const row = await loadAggregate(tx,this.backend,scope,id,skip);
    if (!row) { if (skip) return undefined; throw new StorageError('NOT_FOUND','Workflow was not found in this scope.'); }
    const ownerRow = (await tx.query<OwnerRow>(`SELECT * FROM ${this.table('owners')} WHERE scope = ? AND aggregate_id = ?`,[scope,id]))[0];
    if (!ownerRow) throw new StorageError('SCHEDULED_WRITER_REQUIRED','The run is not enrolled in scheduled execution.');
    if (profile !== undefined && Number(ownerRow.profile) !== profile) conflict();
    const owner = this.decode(ownerRow,row); if (ownerRow.policy_hash !== policyHash) conflict();
    const state = this.checkedState(row,owner);
    // Lock every bounded owned job before touching any resource. Controls can safely visit them in any order afterwards.
    const jobRows = await tx.query<{ job_id: string }>(`SELECT job_id FROM ${this.backend.prefix}mayura_scheduler_jobs WHERE scope = ? AND run_id = ? ORDER BY job_id${lockSql(this.backend)}`,[scope,id]);
    // A control command may release several jobs' holds: acquire those rows in one global key order.
    await tx.query(`SELECT resource_key FROM ${this.backend.prefix}mayura_scheduler_resources WHERE scope = ? AND job_id IN (SELECT job_id FROM ${this.backend.prefix}mayura_scheduler_jobs WHERE scope = ? AND run_id = ?) ORDER BY resource_key${lockSql(this.backend)}`,[scope,scope,id]);
    const links = await tx.query<Link>(`SELECT node_id, job_id FROM ${this.table('jobs')} WHERE scope = ? AND aggregate_id = ? ORDER BY job_id`,[scope,id]);
    if (links.length > 128 || links.length !== jobRows.length || links.some((link,index) => link.job_id !== jobRows[index]?.job_id)) failed();
    const events: StoredEventInput[] = []; const clock = { value: owner.clockFloor }; const jobs: JobRecord[] = [];
    const local = this.scheduler.inSession(tx,id,events,undefined,clock);
    for (const link of links) {
      const job = await local.execute('read',{scope,jobId:link.job_id}) as JobRecord | undefined;
      const node = owner.manifest.graph.find(node => node.id === link.node_id); const step = state.steps[link.node_id];
      if (!job || !node || node.kind !== 'tool' || !step || job.nodeId !== node.id || job.runId !== id
        || (job.definitionHash !== row.definition_hash && !owner.lineage?.includes(job.definitionHash)) || job.candidateHash !== step.candidateHash
        || job.intent['toolId'] !== node.tool || job.intent['callId'] !== `${id}/${step.callId}`
        || job.intent['policyHash'] !== policyHash || !same(job.resourceKeys,owner.resources[node.id])) failed();
      if (job.state === 'succeeded' && (step.status !== 'succeeded' || !same(step.output,job.output) || !same(step.receipt,job.receipt))) failed();
      if (['ready','leased'].includes(job.state) && !['pending','approved'].includes(step.status)) failed();
      if (job.state === 'started' && step.status !== 'dispatching') failed();
      jobs.push(job);
    }
    for (const [nodeId,step] of Object.entries(state.steps)) if (step.candidateHash !== null && !links.some(link => link.node_id === nodeId)) failed();
    clock.value = await storageClock(tx,this.backend,clock.value);
    const waits = graphManifest(owner.manifest) ? workflowGraphTargets(owner.manifest,state.input) : {};
    const run: LockedRun = { row,owner,ownerRow,state,jobs,clock,events,waits,facts:{},targetFacts:new Map() };
    await this.checkWaitProjection(tx,run);
    await this.checkProjection(tx,run);
    await checkCompletion(tx,this.backend,row,policyHash,state.status,false); return run;
  }
  /** Parent-owned immutable edges are recomputed from the admitted input, never trusted as a second authority.
   * Only immutable target facts/identity columns are read here; no target workflow lock is acquired.
   */
  private async checkWaitProjection(tx: SchedulerSession, run: LockedRun): Promise<void> {
    try {
      const rows = await tx.query<WaitTargetRow>(`SELECT * FROM ${this.table('wait_targets')} WHERE scope = ? AND aggregate_id = ? LIMIT 129`,[run.row.scope,run.row.id]);
      const expected = Object.entries(run.waits); const count = expected.reduce((total,[,targets]) => total + targets.length,0);
      if (rows.length !== count || count > 128) failed();
      const seen = new Set<string>();
      for (const row of rows) {
        const ordinal = storedInteger(row.ordinal); const reference = run.waits[row.node_id]?.[ordinal];
        const key = JSON.stringify([row.node_id,ordinal]); if (seen.has(key)) failed(); seen.add(key);
        if (!reference || row.scope !== run.row.scope || row.aggregate_id !== run.row.id || row.run_id !== reference.runId
          || row.definition_hash !== reference.definitionHash || row.policy_hash !== reference.policyHash
          || row.policy_hash !== run.ownerRow.policy_hash || row.run_id === run.row.id) failed();
      }
      const facts: Record<string, readonly ExecutionCompletion[] | undefined> = {};
      for (const [nodeId,targets] of expected) {
        const observations: ExecutionCompletion[] = []; let complete = true;
        for (const reference of targets) {
          const key = JSON.stringify([reference.kind,reference.runId,reference.definitionHash,reference.policyHash]);
          if (!run.targetFacts.has(key)) {
            await this.checkTargetIdentity(tx,run.row.scope,run.row.id,run.ownerRow.policy_hash,reference);
            run.targetFacts.set(key,await readCompletion(tx,this.backend,run.row.scope,reference));
          }
          // Repeated edges retain independent row/order checks above. Only immutable identities
          // and facts share this command-local observation; no target business lock is acquired.
          const fact = run.targetFacts.get(key);
          if (fact) observations.push(fact); else complete = false;
        }
        facts[nodeId] = complete ? observations : undefined;
        const step = run.state.steps[nodeId];
        // A wait can fail only after a complete observation fails output admission.
        // It cannot fabricate terminal failure while any target is still pending.
        if (step?.status === 'failed' && !complete) failed();
        if (!step || step.kind !== 'wait' || run.jobs.some(job => job.nodeId === nodeId)
          || step.receipt !== null || step.approval !== null || step.candidateHash !== null || step.costReserved !== 0) failed();
        if (step.status === 'succeeded' && (!complete || !same(step.output,observations))) failed();
      }
      run.facts = facts;
    } catch { failed(); }
  }
  /** Verify already-existing immutable owner identities without taking target business locks. */
  private async checkTargetIdentity(tx: SchedulerSession, scope: string, parentId: string, policyHash: string, reference: ExecutionRef): Promise<void> {
    if (reference.runId === parentId || reference.policyHash !== policyHash) conflict();
    const row = (await tx.query<Pick<OwnerRow,'scope'|'aggregate_id'|'profile'|'definition_hash'|'policy_hash'>>(
      `SELECT scope,aggregate_id,profile,definition_hash,policy_hash FROM ${this.table('owners')} WHERE scope = ? AND aggregate_id = ?`,[scope,reference.runId]))[0];
    if (!row || row.scope !== scope || row.aggregate_id !== reference.runId || ![1,2].includes(Number(row.profile))
      || row.definition_hash !== reference.definitionHash || row.policy_hash !== policyHash) conflict();
  }
  /** Independently derive effect facts and accounting from the attempt ledger, never from aggregate claims. */
  private async checkProjection(tx: SchedulerSession,run: LockedRun): Promise<void> {
    try {
      let spent = 0;
      for (const node of run.owner.manifest.graph) {
        const step = run.state.steps[node.id]!; const job = run.jobs.find(item => item.nodeId === node.id);
        if (!job) {
          if (step.candidateHash !== null || step.receipt !== null || step.costReserved !== 0 || step.status === 'dispatching' || step.status === 'unknown') failed();
          if (node.kind === 'tool' && step.status === 'succeeded') failed();
          if (node.kind === 'join' && step.status === 'succeeded' && !same(step.output,node.dependsOn.map(id => run.state.steps[id]!.output))) failed();
          continue;
        }
        if (node.kind !== 'tool' || step.candidateHash === null) failed();
        const allowed: Record<JobRecord['state'], readonly string[]> = {
          ready: [node.approval ? 'approved' : 'pending'], leased: [node.approval ? 'approved' : 'pending'],
          started: ['dispatching'], succeeded: ['succeeded'], failed: ['failed'], blocked: ['blocked'],
          cancelled: ['skipped','failed','blocked'], outcome_unknown: ['unknown'],
        };
        if (!allowed[job.state].includes(step.status) || (node.approval && !step.approval?.humanId)) failed();
        const accounting = await this.accounting(tx,run,job,node); let projected = accounting?.receipt ?? null;
        if (projected && job.state === 'succeeded') projected = { ...projected,disclosure:'released' };
        if (!same(projected,step.receipt)) failed();
        const expectedReservation = accounting ? accounting.settlement.unknownCostMicros
          : job.startedAtMs === null && ['cancelled','blocked'].includes(job.state) ? 0 : node.costMicros;
        if (step.costReserved !== expectedReservation) failed();
        if (accounting) spent = nextCounter(spent,accounting.settlement.knownCostMicros);
      }
      if (spent !== run.state.spentMicros || (['succeeded','failed','blocked','outcome_unknown'].includes(run.state.status)
        && Object.values(run.state.steps).some(step => !terminalSteps.has(step.status)))) failed();
    } catch { failed(); }
  }
  private snapshot(run: LockedRun): Snapshot {
    return { record: aggregateRecord(run.row), profile:run.owner.format === 1 ? 'scheduled-v1' : 'scheduled-v2', manifestHash:run.ownerRow.definition_hash,
      policyHash:run.ownerRow.policy_hash, resourceHash:run.ownerRow.resource_hash, jobs:run.jobs };
  }
  /** Reconstruct cost facts from immutable attempt evidence; legacy evidence remains conservatively fixed-cost. */
  private async accounting(tx: SchedulerSession,run: LockedRun,job: JobRecord,node: ToolNode): Promise<AccountingProjection | undefined> {
    if (job.fence === 0) return undefined;
    const evidence = await this.local(tx,run).execute('receipts',{scope:run.row.scope,jobId:job.jobId,fence:job.fence}) as SchedulerEvidence[];
    let projected: AccountingProjection | undefined;
    for (const item of evidence) if (item.disposition !== 'conflicting') {
      const current = executionSettlement(item.settlement,item.receipt,node.costMicros);
      if (!projected) projected = {receipt:mergeWorkflowReceipt(null,item.receipt),settlement:current};
      else {
        const merged = mergeWorkflowReceipt(projected.receipt,item.receipt);
        if (projected.receipt.execution === 'unknown' && item.receipt.execution !== 'unknown') projected = {receipt:merged,settlement:current};
        else if (projected.receipt.execution === 'unknown' && item.receipt.execution === 'unknown' && !same(projected.settlement,current)) {
          const refines = (next: ExecutionSettlement,before: ExecutionSettlement): boolean => next.knownCostMicros >= before.knownCostMicros
            && next.unknownCostMicros <= before.unknownCostMicros
            && next.knownCostMicros + next.unknownCostMicros <= before.knownCostMicros + before.unknownCostMicros;
          if (refines(current,projected.settlement)) projected = {receipt:merged,settlement:current};
          else if (!refines(projected.settlement,current)) failed();
        }
        else {
          if (!same(projected.settlement,current) && !(projected.receipt.execution !== 'unknown' && item.receipt.execution === 'unknown')) failed();
          projected = {receipt:merged,settlement:projected.settlement};
        }
      }
    }
    return projected && Object.freeze({receipt:projected.receipt,settlement:projected.settlement});
  }
  private local(tx: SchedulerSession, run: LockedRun, jobId?: string, admissionExpiresAt?: number): SchedulerDatabase {
    return this.scheduler.inSession(tx,run.row.id,run.events,jobId,run.clock,admissionExpiresAt);
  }
  private replaceJob(run: LockedRun, job: JobRecord): void {
    const index = run.jobs.findIndex(item => item.jobId === job.jobId); if (index < 0) run.jobs.push(job); else run.jobs[index] = job;
    run.jobs.sort((a,b) => a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0);
  }
  private semantic(method: ScheduledMethod, input: JsonObject): string {
    const value = { ...input }; delete value['expectedVersion'];
    if (value['claim']) { const token = { ...value['claim'] as JsonObject }; delete token['leaseUntilMs']; value['claim'] = token; }
    return digest('mayura:scheduled-command:v1',{ operation:method,...value });
  }
  private retry(run: LockedRun, method: ScheduledMethod, input: JsonObject): boolean {
    if (input['commandId'] === undefined) return false;
    const previous = run.owner.commands.find(item => item.id === input['commandId']);
    if (!previous) return false; if (previous.digest !== this.semantic(method,input) || previous.operation !== method) conflict(); return true;
  }
  private journal(run: LockedRun, method: ScheduledMethod, input: JsonObject): void {
    if (input['commandId'] === undefined) return;
    if (run.owner.commands.length >= 1024) limited();
    run.owner.commands.push({ id:input['commandId'] as string,digest:this.semantic(method,input),version:nextCounter(storedInteger(run.row.version),1),operation:method });
  }
  private async save(tx: SchedulerSession, run: LockedRun, method?: ScheduledMethod, input?: JsonObject, event?: StoredEventInput): Promise<void> {
    if (method && input) this.journal(run,method,input);
    if (event) run.events.push(event);
    if (run.events.length === 0) run.events.push({type:'workflow.control',data:{operation:method ?? 'projection'}});
    run.owner.clockFloor = run.clock.value;
    const next = jsonValue(run.state) as JsonObject;
    this.checkedState({ ...run.row,state:JSON.stringify(next) },run.owner);
    await this.checkWaitProjection(tx,run);
    await this.checkProjection(tx,run);
    run.row = await writeAggregate(tx,this.backend,run.row,next,run.events,run.clock.value);
    run.ownerRow.aggregate_version = run.row.version; run.ownerRow.data = JSON.stringify(object(run.owner));
    await tx.query(`UPDATE ${this.table('owners')} SET aggregate_version = ?, data = ? WHERE scope = ? AND aggregate_id = ?`,[run.row.version,run.ownerRow.data,run.row.scope,run.row.id]);
    await checkCompletion(tx,this.backend,run.row,run.ownerRow.policy_hash,run.state.status,true);
    run.events.length = 0;
  }
  /**
   * Apply a reviewed migration to a locked, paused run. Everything is re-verified here: the caller's plan is advisory.
   * Steps with scheduler history and non-pending waits must be unchanged; other steps may only be carried unchanged
   * or re-enter as fresh pending steps. No other run may depend on this run's identity.
   */
  private async migrateRun(tx: SchedulerSession, run: LockedRun, input: JsonObject): Promise<void> {
    const refuse = (message: string): never => { throw new StorageError('CONFLICT', `Migration refused: ${message}`); };
    if (run.state.status !== 'paused') refuse('the run must be paused.');
    if (run.jobs.some(job => job.state === 'leased' || job.state === 'started')) refuse('a job is leased or started.');
    const dependents = await tx.query<{ aggregate_id: string }>(`SELECT aggregate_id FROM ${this.table('wait_targets')} WHERE scope = ? AND run_id = ? LIMIT 1`,[run.row.scope,run.row.id]);
    if (dependents.length) refuse('another workflow waits on this run.');
    // Execution waits are optional storage; probe the table without failing the transaction when it was never created.
    const waitTable = `${this.backend.prefix}mayura_execution_wait_targets`;
    const present = this.backend.dialect === 'postgres'
      ? (await tx.query<{ found: string | null }>('SELECT to_regclass(?)::text AS found',[waitTable]))[0]?.found
      : (await tx.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",[waitTable]))[0]?.name;
    if (present && (await tx.query(`SELECT run_id FROM ${waitTable} WHERE scope = ? AND run_id = ? LIMIT 1`,[run.row.scope,run.row.id])).length) refuse('an execution wait targets this run.');
    const manifest = input['manifest'] as unknown as Manifest; const resources = input['resources'] as unknown as WorkflowResourcePlan;
    if (graphManifest(manifest) !== graphManifest(run.owner.manifest)) refuse('the workflow format cannot change.');
    const hashes = this.hashEnrollment(manifest,run.owner.policy,resources);
    if (hashes.definition === run.ownerRow.definition_hash) refuse('the definition is unchanged.');
    const previous = run.state; const next = input['state'] as unknown as State;
    const checked = graphManifest(manifest) ? workflowGraphState({ id: run.row.id, state: next as unknown as JsonObject }) : workflowState({ id: run.row.id, state: next as unknown as JsonObject });
    if (checked.definition !== hashes.definition || checked.policy !== previous.policy || checked.maxCostMicros !== previous.maxCostMicros || checked.status !== 'paused'
      || !same(checked.input,previous.input) || checked.spentMicros !== previous.spentMicros || checked.output !== null) refuse('only steps and the definition may change.');
    const oldNodes = new Map(run.owner.manifest.graph.map(node => [node.id,node])); const newNodes = new Map(manifest.graph.map(node => [node.id,node]));
    for (const [id,step] of Object.entries(checked.steps)) {
      const before = previous.steps[id]; const jobbed = run.jobs.some(job => job.nodeId === id);
      if (before && same(step,before)) {
        // Carried unchanged: a step with history must also keep its exact node definition and resources.
        if ((jobbed || !['pending','skipped'].includes(before.status)) && (!same(oldNodes.get(id),newNodes.get(id)) || !same(run.owner.resources[id] ?? null,resources[id] ?? null))) {
          if (jobbed || before.status === 'waiting' && before.kind === 'wait') refuse(`step "${id}" has execution history and its definition changed.`);
        }
        continue;
      }
      if (jobbed) refuse(`step "${id}" has scheduler history and cannot change.`);
      if (before && !['pending','waiting','approved'].includes(before.status)) refuse(`settled step "${id}" can only be carried unchanged.`);
      if (step.status !== 'pending' || step.receipt !== null || step.approval !== null || step.candidateHash !== null || step.costReserved !== 0) refuse(`step "${id}" must re-enter as a fresh pending step.`);
    }
    for (const [id,before] of Object.entries(previous.steps)) {
      if (Object.hasOwn(checked.steps,id)) continue;
      if (run.jobs.some(job => job.nodeId === id && !['cancelled'].includes(job.state)) || before.status === 'dispatching' || before.status === 'unknown') refuse(`step "${id}" has execution history and cannot be removed.`);
    }
    // Waits: started wait nodes keep identical targets; the target rows are re-projected from the new manifest.
    const waits = graphManifest(manifest) ? workflowGraphTargets(manifest,checked.input) : {};
    for (const [nodeId,targets] of Object.entries(run.waits)) {
      const step = previous.steps[nodeId];
      if (step && step.status !== 'pending' && !same(waits[nodeId] ?? null,targets)) refuse(`wait "${nodeId}" already started and its targets changed.`);
    }
    await tx.query(`DELETE FROM ${this.table('wait_targets')} WHERE scope = ? AND aggregate_id = ?`,[run.row.scope,run.row.id]);
    for (const [nodeId,targets] of Object.entries(waits)) for (const [ordinal,target] of targets.entries()) {
      await this.checkTargetIdentity(tx,run.row.scope,run.row.id,run.ownerRow.policy_hash,target);
      await tx.query(`INSERT INTO ${this.table('wait_targets')} (scope,aggregate_id,node_id,ordinal,run_id,definition_hash,policy_hash) VALUES (?,?,?,?,?,?,?)`,
        [run.row.scope,run.row.id,nodeId,ordinal,target.runId,target.definitionHash,target.policyHash]);
    }
    const lineage = [...(run.owner.lineage ?? []), run.ownerRow.definition_hash];
    if (lineage.length > 64) limited();
    run.owner = { ...run.owner, manifest, resources, lineage };
    run.state = checked; run.waits = waits; run.targetFacts = new Map();
    await tx.query(`UPDATE ${this.backend.prefix}mayura_aggregates SET definition_hash = ? WHERE scope = ? AND id = ?`,[hashes.definition,run.row.scope,run.row.id]);
    await tx.query(`UPDATE ${this.table('owners')} SET definition_hash = ?, resource_hash = ? WHERE scope = ? AND aggregate_id = ?`,[hashes.definition,hashes.resources,run.row.scope,run.row.id]);
    run.row = { ...run.row, definition_hash: hashes.definition }; run.ownerRow = { ...run.ownerRow, definition_hash: hashes.definition, resource_hash: hashes.resources };
  }
  private node(run: LockedRun,id: string): ToolNode {
    const node = run.owner.manifest.graph.find(node => node.id === id); if (!node || node.kind !== 'tool') conflict(); return node;
  }
  /** A paused run schedules nothing; only recording an already-requested approval is admitted. */
  private ready(run: LockedRun,node: Node,allowPaused = false): void {
    if (terminalRuns.has(run.state.status) || (run.state.status === 'paused' && !allowPaused)
      || node.dependsOn.some(id => run.state.steps[id]?.status !== 'succeeded')) conflict();
  }
  private unprepared(run: LockedRun,node: ToolNode,allowPaused = false): Step {
    this.ready(run,node,allowPaused); const step = run.state.steps[node.id]!;
    if (run.jobs.some(job => job.nodeId === node.id) || !['pending','waiting','approved'].includes(step.status) || step.receipt || step.costReserved || step.candidateHash) conflict();
    return step;
  }
  private authorized(run: LockedRun,node: ToolNode): boolean {
    return [`tool:${node.tool}`,...node.capabilities,...(node.effects === 'none' ? [] : [`effect:${node.effects}`])].every(grant => run.owner.policy.permissions.includes(grant));
  }
  private candidate(run: LockedRun,node: ToolNode,input: JsonValue,expiresAt: number | null): string {
    try { jsonValue(input,{maxBytes:run.owner.policy.maxOutputBytes}); }
    catch { throw new StorageError('INVALID_INPUT','Candidate input exceeds the pinned workflow limit.'); }
    return digest('mayura:approval:v1',{runId:run.row.id,nodeId:node.id,tool:node.tool,toolVersion:node.toolVersion,input,policy:run.ownerRow.policy_hash,expiresAt});
  }
  private refund(run: LockedRun,step: Step,executed = false): void {
    run.state.reservedMicros -= step.costReserved;
    if (executed) run.state.spentMicros = nextCounter(run.state.spentMicros,step.costReserved);
    step.costReserved = 0;
  }
  private async refreshJob(tx: SchedulerSession,run: LockedRun,jobId: string): Promise<JobRecord> {
    const job = await this.local(tx,run).execute('read',{scope:run.row.scope,jobId}) as JobRecord | undefined;
    if (!job) failed(); this.replaceJob(run,job); return job;
  }
  private job(run: LockedRun,input: JsonObject): JobRecord {
    const token = input['claim'] as unknown as Claim | undefined; const id = token?.jobId ?? input['jobId'];
    if (token && token.scope !== run.row.scope) conflict();
    const job = run.jobs.find(job => job.jobId === id); if (!job) conflict(); return job;
  }
  private mirrorJob(run: LockedRun,job: JobRecord): void {
    const step = run.state.steps[job.nodeId]!;
    if (job.state === 'outcome_unknown') { step.status = 'unknown'; step.output = null; }
    else if (job.state === 'cancelled' && job.startedAtMs === null) { if (!terminalSteps.has(step.status)) step.status = 'skipped'; this.refund(run,step); }
    else if (job.state === 'blocked' && job.startedAtMs === null) { step.status = 'blocked'; this.refund(run,step); }
  }
  private async cancelJob(tx: SchedulerSession,run: LockedRun,job: JobRecord,commandId: string): Promise<JobRecord> {
    const result = await this.local(tx,run).execute('cancel',{scope:run.row.scope,jobId:job.jobId,commandId}) as JobRecord;
    this.replaceJob(run,result); this.mirrorJob(run,result); return result;
  }
  private expiredReview(run: LockedRun,job: JobRecord): boolean {
    const node = this.node(run,job.nodeId); const review = run.state.steps[node.id]!.approval;
    return node.approval && (!review || review.expiresAt <= run.clock.value);
  }
  /** Leave room for every future receipt, review identity and control counter before releasing output.
   * A full aggregate must never prevent cancellation or settlement of an already-started effect.
   * Control characters deliberately bound JSON escaping for a maximum-size verified human identity.
   */
  private admitsOutput(run: LockedRun,value: JsonValue,nodeId?: string): boolean {
    try {
      const output = jsonValue(value,{maxBytes:run.owner.policy.maxOutputBytes});
      const steps: Record<string,Step> = {};
      for (const node of run.owner.manifest.graph) {
        const step = { ...run.state.steps[node.id]!,output:node.id === nodeId ? output : run.state.steps[node.id]!.output };
        if (node.kind === 'tool') {
          step.status = 'dispatching'; step.candidateHash = 'f'.repeat(64); step.costReserved = Number.MAX_SAFE_INTEGER;
          step.receipt = {callId:`${run.row.id}/${step.callId}`,toolId:node.tool,execution:'not_started',disclosure:'withheld'};
          step.approval = node.approval ? {digest:'f'.repeat(64),expiresAt:Number.MAX_SAFE_INTEGER,humanId:'\u0001'.repeat(256)} : null;
        } else {
          step.status = 'succeeded';
          // Every unresolved wait must retain room to settle after earlier tool outputs are admitted.
          // Use the longest terminal spelling and safe-counter widths; references are immutable.
          if (node.kind === 'wait' && node.id !== nodeId && step.output === null) step.output = jsonValue(run.waits[node.id]!.map(reference => ({
            reference, outcome:'outcome_unknown', sourceVersion:Number.MAX_SAFE_INTEGER, sourceEventSequence:Number.MAX_SAFE_INTEGER,
          })));
        }
        steps[node.id] = step;
      }
      // This is a size/depth/node-count projection only, not a persistable execution state.
      jsonValue({...run.state,status:'outcome_unknown',steps,spentMicros:Number.MAX_SAFE_INTEGER,reservedMicros:Number.MAX_SAFE_INTEGER,
        output:nodeId === undefined ? output : run.state.output});
      return true;
    } catch { return false; }
  }
  private async blockExpiredReview(tx: SchedulerSession,run: LockedRun,job: JobRecord): Promise<boolean> {
    if (job.startedAtMs !== null || !['ready','leased'].includes(job.state) || !this.expiredReview(run,job)) return false;
    await this.cancelJob(tx,run,job,`review-expired:${job.jobId}`); run.state.steps[job.nodeId]!.status = 'blocked';
    run.events.push({type:'approval.expired',data:{nodeId:job.nodeId}}); return true;
  }
  private async observeReviewExpiry(tx: SchedulerSession,run: LockedRun,nodeId: string): Promise<void> {
    const job = run.jobs.find(item => item.nodeId === nodeId);
    if (job) await this.blockExpiredReview(tx,run,job);
    if (run.events.length === 0 && run.clock.value > run.owner.clockFloor) run.events.push({type:'approval.expiry_observed',data:{nodeId}});
    // A rejected approval is not journaled as a successful command. Its monotonic observation is
    // nevertheless durable, so wall-clock rollback cannot make the same expired digest live again.
    if (run.events.length > 0) await this.save(tx,run);
  }
  private advance(run: LockedRun): void {
    if (terminalRuns.has(run.state.status) || run.state.status === 'paused') return;
    for (let pass = 0; pass < run.owner.manifest.graph.length; pass++) {
      let changed = false;
      for (const node of run.owner.manifest.graph) {
        const step = run.state.steps[node.id]!;
        if (!['pending','waiting','approved'].includes(step.status) || run.jobs.some(job => job.nodeId === node.id)) continue;
        const dependencies = node.dependsOn.map(id => run.state.steps[id]!);
        if (dependencies.some(step => terminalSteps.has(step.status) && step.status !== 'succeeded')) {
          step.status = 'skipped'; changed = true; run.events.push({type:'step.skipped',data:{nodeId:node.id}});
        } else if (node.kind === 'join' && dependencies.every(step => step.status === 'succeeded')) {
          const output = dependencies.map(step => step.output);
          if (this.admitsOutput(run,output,node.id)) { step.output = output; step.status = 'succeeded'; run.events.push({type:'step.completed',data:{nodeId:node.id}}); }
          else { step.output = null; step.status = 'failed'; run.events.push({type:'step.failed',data:{nodeId:node.id,reason:'OUTPUT_LIMIT'}}); }
          changed = true;
        } else if (node.kind === 'wait' && dependencies.every(step => step.status === 'succeeded')) {
          const facts = run.facts[node.id];
          if (facts) {
            const output = jsonValue(facts);
            if (this.admitsOutput(run,output,node.id)) {
              step.output = output; step.status = 'succeeded'; run.events.push({type:'workflow.wait_resolved',data:{nodeId:node.id}});
            } else { step.output = null; step.status = 'failed'; run.events.push({type:'step.failed',data:{nodeId:node.id,reason:'OUTPUT_LIMIT'}}); }
            changed = true;
          } else if (step.status === 'pending') {
            step.status = 'waiting'; changed = true; run.events.push({type:'workflow.waiting',data:{nodeId:node.id}});
          }
        }
      }
      if (!changed) break;
    }
    const steps = Object.values(run.state.steps);
    if (steps.every(step => terminalSteps.has(step.status)) && !steps.every(step => step.status === 'succeeded')) {
      run.state.status = steps.some(step => step.status === 'unknown') ? 'outcome_unknown' : steps.some(step => step.status === 'blocked') ? 'blocked' : 'failed';
    } else run.state.status = steps.some(step => step.status === 'waiting') && !steps.some(step => step.status === 'dispatching') ? 'waiting' : 'running';
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return; await this.scheduler.execute('initialize',{});
    await this.backend.transaction(async tx => {
      if (this.backend.dialect === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(hashtext(?))',[`mayura:scheduled-schema:${this.backend.prefix}`]);
      await initializeOwnership(tx,this.backend);
      await initializeCompletions(tx,this.backend);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${this.table('jobs')} (scope TEXT NOT NULL, aggregate_id TEXT NOT NULL, node_id TEXT NOT NULL, job_id TEXT NOT NULL,
        PRIMARY KEY(scope,aggregate_id,node_id), UNIQUE(scope,job_id), FOREIGN KEY(scope,aggregate_id) REFERENCES ${this.table('owners')}(scope,aggregate_id),
        FOREIGN KEY(scope,job_id) REFERENCES ${this.backend.prefix}mayura_scheduler_jobs(scope,job_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${this.table('wait_targets')} (
        scope TEXT NOT NULL, aggregate_id TEXT NOT NULL, node_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 31),
        run_id TEXT NOT NULL, definition_hash TEXT NOT NULL, policy_hash TEXT NOT NULL,
        PRIMARY KEY(scope,aggregate_id,node_id,ordinal), UNIQUE(scope,aggregate_id,node_id,run_id),
        FOREIGN KEY(scope,aggregate_id) REFERENCES ${this.table('owners')}(scope,aggregate_id))`);
    }); this.initialized = true;
  }
  /** Discovery provisions its index only when explicitly requested, never as an unindexed fallback. */
  private async initializeDiscovery(): Promise<void> {
    if (this.discoveryInitialized) return;
    await this.initialize();
    await this.backend.transaction(async tx => {
      if (this.backend.dialect === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(hashtext(?))',[`mayura:scheduled-schema:${this.backend.prefix}`]);
      await initializeWorkflowGraphDiscoveryIndex(tx,this.backend);
    });
    this.discoveryInitialized = true;
  }
  /**
   * Finite recovery hints, not a ready queue or execution grant. Selection releases its transaction
   * before each ordinary parent validation; no two parent locks or mutable target locks overlap.
   */
  async discover(method: keyof WorkflowGraphDiscoveryStore, value: unknown): Promise<unknown> {
    const input = workflowGraphDiscoveryCommand(method,value);
    if (method === 'initialize') return this.initializeDiscovery();
    if (!this.discoveryInitialized) throw new StorageError('STORE_NOT_INITIALIZED','Initialize workflow graph discovery before use.');
    const command = input as unknown as WorkflowGraphDiscoveryScan;
    try {
      const afterId = command.cursor?.afterId ?? '';
      const collation = this.backend.dialect === 'postgres' ? '"C"' : 'BINARY';
      const rows = await this.backend.transaction(tx => tx.query<{ aggregate_id: string }>(
        `SELECT aggregate_id FROM ${this.table('owners')} WHERE scope = ? AND policy_hash = ? AND profile = 2
          AND aggregate_id COLLATE ${collation} > ? ORDER BY aggregate_id COLLATE ${collation} LIMIT ?`,
        [command.scope,command.policyHash,afterId,command.limit]));
      if (rows.length > command.limit) failed();
      const candidates: WorkflowGraphDiscoveryCandidate[] = [];
      let previous = afterId;
      for (const row of rows) {
        const id = hash(row.aggregate_id); if (id <= previous) failed(); previous = id;
        const candidate = await this.backend.transaction(async tx => {
          // Do not use SKIP LOCKED: a selected parent is either validated or fails this entire page.
          const run = await this.load(tx,command.scope,id,command.policyHash,false,2);
          if (!run) failed();
          if (run.state.status !== 'running' && run.state.status !== 'waiting' && run.state.status !== 'paused') return undefined;
          return { reference:{kind:'scheduled-workflow' as const,runId:id,definitionHash:run.row.definition_hash,policyHash:command.policyHash},
            version:storedInteger(run.row.version),status:run.state.status };
        });
        if (candidate) candidates.push(candidate);
      }
      return workflowGraphDiscoveryPage({ candidates,examined:rows.length,nextCursor:rows.length === command.limit
        ? {format:1,scope:command.scope,policyHash:command.policyHash,afterId:previous} : null },command);
    } catch { return failed(); }
  }
  /** Internal finite maintenance; validates the full enrolled source before publishing old terminal state. */
  async materializeCompletion(scope: string, reference: ExecutionRef): Promise<ExecutionCompletion | undefined> {
    if (!this.initialized) throw new StorageError('STORE_NOT_INITIALIZED','Initialize scheduled workflow storage first.');
    return this.backend.transaction(async tx => {
      const run = await this.load(tx,scope,reference.runId,reference.policyHash);
      if (!run) throw new StorageError('NOT_FOUND','Workflow was not found in this scope.');
      if (run.row.definition_hash !== reference.definitionHash) conflict();
      return checkCompletion(tx,this.backend,run.row,reference.policyHash,run.state.status,true);
    });
  }
  private async enroll(tx: SchedulerSession,row: AggregateRow,input: JsonObject,now: number): Promise<LockedRun> {
    const manifest = input['manifest'] as unknown as Manifest; const policy = input['policy'] as unknown as WorkflowPolicyManifest;
    const resources = input['resources'] as unknown as WorkflowResourcePlan; const hashes = this.hashEnrollment(manifest,policy,resources);
    if (hashes.scope !== row.scope || hashes.definition !== row.definition_hash) conflict();
    const existingState = graphManifest(manifest) ? workflowGraphState(aggregateRecord(row)) : workflowState(aggregateRecord(row));
    if (existingState.policy !== hashes.policy || existingState.maxCostMicros !== policy.maxCostMicros) conflict();
    const profile = graphManifest(manifest) ? 2 : 1;
    const owner: Owner = {format:profile,manifest,policy,resources,clockFloor:now,commands:[]}; const state = this.checkedState(row,owner);
    if (state.status !== 'running' || state.spentMicros !== 0 || state.reservedMicros !== 0 || state.output !== null || Object.values(state.steps).some(step => step.status !== 'pending' || step.receipt !== null || step.approval !== null || step.candidateHash !== null || step.costReserved !== 0 || step.output !== null)) conflict();
    if ((await tx.query(`SELECT job_id FROM ${this.backend.prefix}mayura_scheduler_jobs WHERE scope = ? AND run_id = ? LIMIT 1`,[row.scope,row.id])).length) conflict();
    const ownerRow: OwnerRow = {scope:row.scope,aggregate_id:row.id,profile,aggregate_version:row.version,definition_hash:hashes.definition,policy_hash:hashes.policy,resource_hash:hashes.resources,data:JSON.stringify(object(owner))};
    await tx.query(`INSERT INTO ${this.table('owners')} (scope,aggregate_id,profile,aggregate_version,definition_hash,policy_hash,resource_hash,data) VALUES (?,?,?,?,?,?,?,?)`,[row.scope,row.id,profile,row.version,hashes.definition,hashes.policy,hashes.resources,ownerRow.data]);
    const waits = graphManifest(manifest) ? workflowGraphTargets(manifest,state.input) : {};
    return {row,owner,ownerRow,state,jobs:[],clock:{value:now},events:[],waits,facts:{},targetFacts:new Map()};
  }
  private async submit(input: JsonObject, profile: 1 | 2): Promise<unknown> {
    const manifest = input['manifest'] as unknown as Manifest; const policy = input['policy'] as unknown as WorkflowPolicyManifest; const resources = input['resources'] as unknown as WorkflowResourcePlan;
    const hashes = this.hashEnrollment(manifest,policy,resources); const key = input['idempotencyKey'] as string;
    const id = digest('mayura:run-id:v1',{scope:hashes.scope,submissionKey:key}); jsonValue(input['input'],{maxBytes:policy.maxOutputBytes});
    const state = graphManifest(manifest) ? initialWorkflowGraphState(manifest,input['input']!,hashes.definition,hashes.policy,policy.maxCostMicros)
      : initialWorkflowState(manifest,input['input']!,hashes.definition,hashes.policy,policy.maxCostMicros);
    const waits = graphManifest(manifest) ? workflowGraphTargets(manifest,state.input) : {};
    // Resolve every edge before parent creation, using independent target-only transactions.
    // No API may attach or mutate graph edges later, so every edge points to an earlier run.
    for (const targets of Object.values(waits)) for (const target of targets) {
      if (target.runId === id || target.policyHash !== hashes.policy) conflict();
      await this.materializeCompletion(hashes.scope,target);
    }
    return this.backend.transaction(async tx => {
      await lockRunIdentity(tx,this.backend,hashes.scope,id); await loadAggregate(tx,this.backend,hashes.scope,id);
      const now = await storageClock(tx,this.backend);
      const created = await createAggregate(tx,this.backend,createCommand({scope:hashes.scope,id,idempotencyKey:key,definitionHash:hashes.definition,state:jsonValue(state) as JsonObject,events:[{type:'run.created',data:{}}]}),now);
      if (!created.created) {
        const run = await this.load(tx,hashes.scope,id,hashes.policy,false,profile); if (!run || run.ownerRow.resource_hash !== hashes.resources) conflict();
        return {snapshot:this.snapshot(run),created:false};
      }
      const run = await this.enroll(tx,created.row,input,now);
      for (const [nodeId,targets] of Object.entries(waits)) {
        for (const [ordinal,target] of targets.entries()) {
          await this.checkTargetIdentity(tx,hashes.scope,id,hashes.policy,target);
          await tx.query(`INSERT INTO ${this.table('wait_targets')} (scope,aggregate_id,node_id,ordinal,run_id,definition_hash,policy_hash) VALUES (?,?,?,?,?,?,?)`,
            [hashes.scope,id,nodeId,ordinal,target.runId,target.definitionHash,target.policyHash]);
        }
        run.events.push({type:'workflow.wait_registered',data:{nodeId}});
      }
      if (profile === 2 && !this.admitsOutput(run,null)) throw new StorageError('LIMIT_EXCEEDED','Workflow graph cannot retain its bounded future control evidence.');
      await this.save(tx,run,undefined,undefined,{type:'workflow.enrolled',data:{profile:profile === 1 ? 'scheduled-v1' : 'scheduled-v2'}});
      return {snapshot:this.snapshot(run),created:true};
    });
  }
  async execute(method: ScheduledMethod,value: unknown,profile: 1 | 2 = 1): Promise<unknown> {
    const input = scheduledCommand(method,value,profile);
    if (method === 'initialize') return this.initialize();
    if (!this.initialized) throw new StorageError('STORE_NOT_INITIALIZED','Initialize scheduled workflow storage before use.');
    if (method === 'submit') return this.submit(input,profile);
    if (method === 'claim') return this.claim(input,profile);
    const result = await this.backend.transaction(async tx => {
      const scope = input['scope'] as string; const id = input['id'] as string; const policyHash = input['policyHash'] as string;
      let run: LockedRun;
      if (method === 'attach') {
        await lockRunIdentity(tx,this.backend,scope,id); const row = await loadAggregate(tx,this.backend,scope,id);
        if (!row) throw new StorageError('NOT_FOUND','Workflow was not found in this scope.');
        const exists = (await tx.query(`SELECT aggregate_id FROM ${this.table('owners')} WHERE scope = ? AND aggregate_id = ?`,[scope,id])).length > 0;
        if (exists) { const previous = await this.load(tx,scope,id,policyHash,false,profile); if (!previous || !this.retry(previous,method,input)) conflict(); return this.snapshot(previous); }
        if (storedInteger(row.version) !== input['expectedVersion']) conflict();
        const hashes = this.hashEnrollment(input['manifest'] as unknown as WorkflowManifest,input['policy'] as unknown as WorkflowPolicyManifest,input['resources'] as unknown as WorkflowResourcePlan);
        if (hashes.policy !== policyHash) conflict();
        run = await this.enroll(tx,row,input,await storageClock(tx,this.backend));
        await this.save(tx,run,method,input,{type:'workflow.enrolled',data:{profile:'scheduled-v1'}}); return this.snapshot(run);
      }
      run = (await this.load(tx,scope,id,policyHash,false,profile))!;
      const originalState = JSON.stringify(run.state);
      if (method === 'inspect') return this.snapshot(run);
      if (this.retry(run,method,input)) return method === 'start' ? {status:'already_started',snapshot:this.snapshot(run)} : this.snapshot(run);
      if (input['expectedVersion'] !== undefined && input['expectedVersion'] !== storedInteger(run.row.version)) conflict();
      if (method === 'recordReceipt') {
        const job = this.job(run,input); const node = this.node(run,job.nodeId); const prior = await this.accounting(tx,run,job,node);
        const result = await this.local(tx,run).execute('recordReceipt',{scope,jobId:job.jobId,fence:input['fence'],evidenceId:input['evidenceId'],receipt:input['receipt'],
          ...(input['settlement'] === undefined ? {} : {settlement:input['settlement']}),
          ...(input['source'] === undefined ? {} : {source:input['source']})}) as {disposition:EvidenceDisposition;job:JobRecord};
        if (run.events.length === 0) return this.snapshot(run);
        this.replaceJob(run,result.job); const step = run.state.steps[job.nodeId]!; const receipt = input['receipt'] as unknown as ExecutionReceipt;
        if (result.disposition !== 'conflicting') {
          step.receipt = mergeWorkflowReceipt(step.receipt,receipt);
          const projected = await this.accounting(tx,run,result.job,node); if (!projected) failed();
          const priorKnown = prior?.settlement.knownCostMicros ?? 0;
          if (projected.settlement.knownCostMicros < priorKnown) failed();
          run.state.spentMicros = nextCounter(run.state.spentMicros,projected.settlement.knownCostMicros-priorKnown);
          run.state.reservedMicros -= step.costReserved; step.costReserved = projected.settlement.unknownCostMicros;
          run.state.reservedMicros = nextCounter(run.state.reservedMicros,step.costReserved);
        }
        this.mirrorJob(run,result.job); await this.save(tx,run); return this.snapshot(run);
      }
      if (method === 'requestApproval' || method === 'approve' || method === 'prepare' || method === 'failNode') {
        const node = this.node(run,input['nodeId'] as string); const previous = run.state.steps[node.id]!;
        const expired = node.approval && previous.approval !== null && previous.approval.expiresAt <= run.clock.value;
        if (expired && method !== 'failNode' && (method !== 'requestApproval' || run.jobs.some(job => job.nodeId === node.id))) {
          await this.observeReviewExpiry(tx,run,node.id); return REVIEW_EXPIRED;
        }
        const step = this.unprepared(run,node,method === 'approve');
        if (method === 'requestApproval') {
          if (!node.approval || !this.authorized(run,node)) conflict();
          if (step.approval && step.approval.expiresAt > run.clock.value && step.approval.digest === this.candidate(run,node,input['input']!,step.approval.expiresAt)) return this.snapshot(run);
          let expiresAt: number; let candidate: string;
          try { expiresAt = nextCounter(run.clock.value,run.owner.policy.approvalTtlMs); candidate = this.candidate(run,node,input['input']!,expiresAt); }
          catch (error) { if (!expired) throw error; await this.observeReviewExpiry(tx,run,node.id); return REVIEW_EXPIRED; }
          step.approval = {digest:candidate,expiresAt,humanId:null}; step.status = 'waiting'; run.state.status = 'waiting';
        } else if (method === 'approve') {
          if (!node.approval || step.status !== 'waiting' || !step.approval || step.approval.digest !== input['digest'] || step.approval.expiresAt <= run.clock.value) conflict();
          step.approval.humanId = input['humanId'] as string; step.status = 'approved'; if (run.state.status !== 'paused') run.state.status = 'running';
        } else if (method === 'failNode') { step.status = input['outcome'] as 'failed'|'blocked'; }
        else {
          if (!this.authorized(run,node)) conflict();
          const expiresAt = node.approval ? step.approval?.expiresAt ?? 0 : null; const candidate = this.candidate(run,node,input['input']!,expiresAt);
          if (node.approval && (step.status !== 'approved' || !step.approval?.humanId || step.approval.digest !== candidate || step.approval.expiresAt <= run.clock.value)) conflict();
          if (node.costMicros > run.state.maxCostMicros - run.state.spentMicros - run.state.reservedMicros) { step.status = 'blocked'; }
          else {
            const jobId = digest('mayura:workflow-job:v1',{scope,id,nodeId:node.id});
            const job = (await this.local(tx,run).execute('reserve',{scope,jobId,reservationKey:jobId,runId:id,nodeId:node.id,invocationId:`${id}/${step.callId}`,definitionHash:run.ownerRow.definition_hash,candidateHash:candidate,
              intent:{toolId:node.tool,callId:`${id}/${step.callId}`,policyHash},resourceKeys:run.owner.resources[node.id]!,delayMs:0}) as {job:JobRecord}).job;
            await tx.query(`INSERT INTO ${this.table('jobs')} (scope,aggregate_id,node_id,job_id) VALUES (?,?,?,?)`,[scope,id,node.id,jobId]);
            step.candidateHash = candidate; step.costReserved = node.costMicros; run.state.reservedMicros = nextCounter(run.state.reservedMicros,node.costMicros);
            this.replaceJob(run,job);
          }
        }
        await this.save(tx,run,method,input,{type:method === 'requestApproval' ? 'approval.requested' : method === 'approve' ? 'approval.resolved' : method === 'prepare' ? 'step.prepared' : 'step.failed',data:{nodeId:node.id}});
        return this.snapshot(run);
      }
      if (method === 'start' || method === 'renew' || method === 'complete' || method === 'abandon') {
        const job = this.job(run,input); const token = input['claim'] as unknown as Claim; const step = run.state.steps[job.nodeId]!; const node = this.node(run,job.nodeId);
        const admissionExpiresAt = node.approval ? step.approval?.expiresAt ?? 0 : undefined;
        if (method !== 'renew' && terminalRuns.has(run.state.status)) conflict();
        if (await this.blockExpiredReview(tx,run,job)) { await this.save(tx,run); return STALE; }
        try {
          if (method === 'renew') {
            const renewed = await this.local(tx,run,job.jobId,admissionExpiresAt).execute('renew',{claim:token,leaseMs:input['leaseMs']}) as Claim;
            await this.refreshJob(tx,run,job.jobId); await this.save(tx,run); return renewed;
          }
          if (method === 'start') {
            if (!this.authorized(run,node) || this.candidate(run,node,input['input']!,node.approval ? step.approval?.expiresAt ?? 0 : null) !== step.candidateHash) conflict();
            this.ready(run,node);
            if (node.approval && (step.status !== 'approved' && step.status !== 'dispatching' || !step.approval?.humanId || step.approval.expiresAt <= run.clock.value)) conflict();
            const started = await this.local(tx,run,job.jobId,admissionExpiresAt).execute('start',{claim:token,candidateHash:step.candidateHash}) as {status:'started'|'already_started';job:JobRecord};
            this.replaceJob(run,started.job);
            if (started.status === 'already_started') return {status:'already_started',snapshot:this.snapshot(run)};
            step.status = 'dispatching'; run.state.status = 'running'; await this.save(tx,run,method,input,{type:'step.dispatching',data:{nodeId:node.id}});
            return {status:'started',snapshot:this.snapshot(run)};
          }
          if (method === 'abandon') {
            // A live renewal validates the precise never-started token without manufacturing a start marker.
            if (job.startedAtMs !== null || job.state !== 'leased') conflict();
            await this.local(tx,run,job.jobId,admissionExpiresAt).execute('renew',{claim:token,leaseMs:1000});
            await this.cancelJob(tx,run,job,digest('mayura:scheduled-internal-command:v1',{operation:'abandon',commandId:input['commandId']})); step.status = input['outcome'] as 'failed'|'blocked';
          } else {
            if (step.status !== 'dispatching') conflict();
            const outputAllowed = input['outcome'] !== 'succeeded' || this.admitsOutput(run,input['output']!,node.id);
            const outcome = outputAllowed ? input['outcome'] as 'succeeded'|'failed'|'blocked' : 'blocked';
            const completed = await this.local(tx,run).execute('complete',{claim:token,commandId:input['commandId'],evidenceId:input['evidenceId'],outcome,output:outcome === 'succeeded' ? input['output'] : null}) as JobRecord;
            this.replaceJob(run,completed); step.receipt = completed.receipt; step.status = outcome; step.output = completed.output;
            if (!outputAllowed) run.events.push({type:'step.output_blocked',data:{nodeId:node.id,reason:'OUTPUT_LIMIT'}});
            if (step.costReserved > 0 && step.receipt && step.receipt.execution !== 'unknown') this.refund(run,step,step.receipt.execution !== 'not_started');
          }
          await this.save(tx,run,method,input,{type:'step.completed',data:{nodeId:node.id,outcome:step.status}}); return this.snapshot(run);
        } catch (error) {
          if (!(error instanceof StorageError) || error.storageCode !== 'STALE_CLAIM') throw error;
          await this.blockExpiredReview(tx,run,job);
          if (run.events.length > 0) { this.mirrorJob(run,await this.refreshJob(tx,run,job.jobId)); await this.save(tx,run); }
          return STALE;
        }
      }
      if (method === 'cancel') {
        if (!terminalRuns.has(run.state.status)) {
          run.state.status = 'cancelled'; run.state.output = null;
          for (const job of [...run.jobs]) await this.cancelJob(tx,run,job,digest('mayura:scheduled-internal-command:v1',{operation:'cancel',commandId:input['commandId']}));
          for (const [nodeId,step] of Object.entries(run.state.steps)) if (!run.jobs.some(job => job.nodeId === nodeId) && !terminalSteps.has(step.status)) step.status = 'skipped';
        }
      } else if (method === 'recover') {
        for (const job of [...run.jobs]) {
          if (await this.blockExpiredReview(tx,run,job)) continue;
          const recovered = await this.local(tx,run,job.jobId).execute('recover',{scope,limit:1}) as JobRecord[];
          for (const item of recovered) { this.replaceJob(run,item); this.mirrorJob(run,item); }
        }
        this.advance(run);
      } else if (method === 'pause') {
        if (run.state.status !== 'paused') {
          if (terminalRuns.has(run.state.status)) conflict();
          // Quiescence: a claimed or started job must settle, be released or be recovered first.
          if (run.jobs.some(job => job.state === 'leased' || job.state === 'started')) conflict();
          run.state.status = 'paused';
        }
      } else if (method === 'resume') {
        if (run.state.status !== 'paused') conflict();
        run.state.status = 'running'; this.advance(run);
      } else if (method === 'migrate') {
        await this.migrateRun(tx,run,input);
        await this.save(tx,run,method,input,{type:'run.migrated',data:{migrationId:input['migrationId']!,from:run.owner.lineage!.at(-1)!,to:run.ownerRow.definition_hash,actorId:input['actorId']!,commandId:input['commandId']!}});
        return this.snapshot(run);
      } else if (method === 'advance') this.advance(run);
      else if (method === 'finalize') {
        if (terminalRuns.has(run.state.status) || run.state.status === 'paused' || Object.values(run.state.steps).some(step => step.status !== 'succeeded') || run.state.reservedMicros !== 0) conflict();
        if (input['validation'] === 'passed' && this.admitsOutput(run,input['output']!)) { run.state.output = input['output']!; run.state.status = 'succeeded'; }
        else { run.state.output = null; run.state.status = 'failed'; }
      } else conflict();
      // A no-op is not a committed transition, so it consumes neither a version nor a command journal entry.
      if (run.events.length === 0 && JSON.stringify(run.state) === originalState) return this.snapshot(run);
      const transition = method === 'cancel' ? 'run.cancelled' : method === 'finalize' ? 'run.completed'
        : method === 'pause' ? 'run.paused' : method === 'resume' ? 'run.resumed' : 'workflow.advanced';
      await this.save(tx,run,method,input,{type:transition,data:{status:run.state.status}});
      return this.snapshot(run);
    });
    if (result === STALE) throw new StorageError('STALE_CLAIM','Scheduled ownership expired or no longer permits the transition.');
    // Keep this text in sync with reviewExpiredMessage in @mayura/workflows: the driver recognizes it.
    if (result === REVIEW_EXPIRED) throw new StorageError('CONFLICT','The approval expired; request a new review before admission.');
    return result;
  }
  private async claim(input: JsonObject, profile: 1 | 2): Promise<unknown> {
    const scope = input['scope'] as string; const id = input['id'] as string; const policy = input['policyHash'] as string;
    const hints = await this.backend.transaction(async tx => { const run = await this.load(tx,scope,id,policy,false,profile); return run?.jobs.filter(job => job.state === 'ready').map(job => job.jobId) ?? []; });
    const results: {job:JobRecord;claim:Claim}[] = [];
    for (const jobId of hints) {
      if (results.length >= (input['limit'] as number)) break;
      try {
        const result = await this.backend.transaction(async tx => {
          // This is an explicit run request, not a global queue scan: skipping its busy aggregate
          // can make every cooperating worker return while eligible work is still ready.
          const run = await this.load(tx,scope,id,policy,false,profile); if (!run || terminalRuns.has(run.state.status) || run.state.status === 'paused') return undefined;
          const job = run.jobs.find(job => job.jobId === jobId); if (!job || job.state !== 'ready') return undefined;
          if (await this.blockExpiredReview(tx,run,job)) { await this.save(tx,run); return undefined; }
          const claims = await this.local(tx,run,jobId).execute('claim',{scope,workerId:input['workerId'],limit:1,leaseMs:input['leaseMs']}) as {job:JobRecord;claim:Claim}[];
          if (!claims[0]) return undefined; this.replaceJob(run,claims[0].job);
          // Resource acquisition can wait; recheck review expiry using the scheduler's post-lock clock.
          if (await this.blockExpiredReview(tx,run,claims[0].job)) { await this.save(tx,run); return undefined; }
          await this.save(tx,run); return claims[0];
        });
        if (result) results.push(result);
      } catch (error) { if (!(error instanceof ResourceBusy)) throw error; }
    }
    return results;
  }
}
