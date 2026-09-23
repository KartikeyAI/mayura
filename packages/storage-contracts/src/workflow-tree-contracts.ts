import { freezeJson, jsonValue, type ExecutionReceipt, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError, type AggregateStore, type StoredRecord } from './contracts.js';
import type { Scope } from '@mayura/core';
import type { WorkflowBinding, WorkflowManifest, WorkflowManifestNode, WorkflowResourcePlan } from './scheduled-workflow-contracts.js';
import { workflowManifest, workflowResources } from './workflow-format2.js';
import type { Claim, EvidenceDisposition, JobRecord } from './scheduler-contracts.js';
import type { DurableBudgetSnapshot } from './durable-budget-contracts.js';

export interface WorkflowTreeChildPolicy {
  readonly permissions: readonly string[];
  readonly maxCostMicros: number;
  readonly maxCalls: number;
  readonly maxOutputBytes: number;
  readonly approvalTtlMs: number;
}
export interface WorkflowTreeChildManifestNode {
  readonly kind: 'child'; readonly id: string; readonly dependsOn: readonly string[];
  readonly workflow: WorkflowManifest; readonly policy: WorkflowTreeChildPolicy;
  readonly resources: WorkflowResourcePlan; readonly input: WorkflowBinding;
}
export type WorkflowTreeManifestNode = WorkflowManifestNode | WorkflowTreeChildManifestNode;
export interface WorkflowTreeManifest {
  readonly format: 4; readonly id: string; readonly version: string;
  readonly graph: readonly WorkflowTreeManifestNode[]; readonly result: WorkflowBinding;
}
export interface WorkflowTreePolicyManifest {
  readonly scope: Scope; readonly permissions: readonly string[]; readonly policyVersion: string;
  readonly maxCostMicros: number; readonly maxCalls: number;
  readonly maxOutputBytes: number; readonly approvalTtlMs: number;
}

export type WorkflowTreeBudgetSnapshot = Omit<DurableBudgetSnapshot,'owner'> & {readonly owner:'workflow-tree-v1'};
export interface WorkflowTreeRootSubmission {readonly manifest:WorkflowTreeManifest;readonly policy:WorkflowTreePolicyManifest;readonly resources:WorkflowResourcePlan;readonly input:JsonValue;readonly idempotencyKey:string}
export interface WorkflowTreeRootSnapshot {readonly record:StoredRecord;readonly profile:'scheduled-v3';readonly rootId:string;readonly accountId:'root';readonly manifestHash:string;readonly policyHash:string;readonly resourceHash:string;readonly budget:WorkflowTreeBudgetSnapshot}
export interface WorkflowTreeChildAdmission {readonly root:WorkflowTreeRootSnapshot;readonly child:StoredRecord;readonly childId:string;readonly accountId:string;readonly definitionHash:string;readonly policyHash:string;readonly resourceHash:string;readonly inputHash:string;readonly created:boolean}
export interface WorkflowTreePreparedTool {readonly root:WorkflowTreeRootSnapshot;readonly member:StoredRecord;readonly job:JobRecord;readonly created:boolean}
export interface WorkflowTreeClaimedTool {readonly root:WorkflowTreeRootSnapshot;readonly member:StoredRecord;readonly job:JobRecord;readonly claim:Claim}
export interface WorkflowTreeRenewedTool {readonly root:WorkflowTreeRootSnapshot;readonly member:StoredRecord;readonly claim:Claim}
export interface WorkflowTreeStartedTool {readonly status:'started'|'already_started';readonly root:WorkflowTreeRootSnapshot;readonly member:StoredRecord;readonly job:JobRecord}
export interface WorkflowTreeReceiptResult {readonly disposition:EvidenceDisposition;readonly root:WorkflowTreeRootSnapshot;readonly member:StoredRecord;readonly job:JobRecord}
export interface WorkflowTreeCompletedTool {readonly root:WorkflowTreeRootSnapshot;readonly member:StoredRecord;readonly job:JobRecord}
export interface WorkflowTreeMemberResult {readonly root:WorkflowTreeRootSnapshot;readonly member:StoredRecord}
export interface WorkflowTreeCancellationResult {readonly root:WorkflowTreeRootSnapshot;readonly members:readonly StoredRecord[];readonly jobs:readonly JobRecord[]}
export interface WorkflowTreeChildCancellationResult {readonly root:WorkflowTreeRootSnapshot;readonly member:StoredRecord;readonly jobs:readonly JobRecord[]}
export interface WorkflowTreeRecoveryResult {readonly root:WorkflowTreeRootSnapshot;readonly members:readonly StoredRecord[];readonly jobs:readonly JobRecord[]}

/** Explicit optional format-4 persistence capability. Every mutation is finite and root-fenced. */
export interface WorkflowTreeStore {
  initialize():Promise<void>;
  submit(command:WorkflowTreeRootSubmission):Promise<{readonly snapshot:WorkflowTreeRootSnapshot;readonly created:boolean}>;
  inspect(command:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string}):Promise<WorkflowTreeRootSnapshot|undefined>;
  admitChild(command:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly parentId:string;readonly nodeId:string;readonly expectedVersion:number;readonly input:JsonValue}):Promise<WorkflowTreeChildAdmission>;
  prepareChildTool(command:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly childId:string;readonly childPolicyHash:string;readonly nodeId:string;readonly expectedVersion:number;readonly input:JsonValue}):Promise<WorkflowTreePreparedTool>;
  claimPreparedChildTool(command:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly childId:string;readonly childPolicyHash:string;readonly nodeId:string;readonly workerId:string;readonly leaseMs:number}):Promise<WorkflowTreeClaimedTool|undefined>;
  renewClaimedChildTool(command:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly childId:string;readonly childPolicyHash:string;readonly nodeId:string;readonly claim:Claim;readonly leaseMs:number}):Promise<WorkflowTreeRenewedTool>;
  startClaimedChildTool(command:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly childId:string;readonly childPolicyHash:string;readonly nodeId:string;readonly expectedVersion:number;readonly claim:Claim;readonly input:JsonValue}):Promise<WorkflowTreeStartedTool>;
  recordChildToolReceipt(command:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly childId:string;readonly childPolicyHash:string;readonly nodeId:string;readonly fence:number;readonly evidenceId:string;readonly receipt:ExecutionReceipt}):Promise<WorkflowTreeReceiptResult>;
  completeChildTool(command:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly childId:string;readonly childPolicyHash:string;readonly nodeId:string;readonly claim:Claim;readonly commandId:string;readonly evidenceId:string;readonly outcome:'succeeded'|'failed'|'blocked';readonly output:JsonValue|null}):Promise<WorkflowTreeCompletedTool>;
  finalizeChild(command:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly childId:string;readonly childPolicyHash:string;readonly expectedVersion:number;readonly output:JsonValue}):Promise<WorkflowTreeMemberResult>;
  joinChild(command:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly nodeId:string;readonly expectedVersion:number}):Promise<WorkflowTreeRootSnapshot>;
  finalizeRoot(command:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly expectedVersion:number;readonly output:JsonValue}):Promise<WorkflowTreeRootSnapshot>;
  cancelChild(command:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly childId:string;readonly childPolicyHash:string;readonly expectedVersion:number;readonly commandId:string}):Promise<WorkflowTreeChildCancellationResult>;
  cancelRoot(command:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly expectedVersion:number;readonly commandId:string}):Promise<WorkflowTreeCancellationResult>;
  recoverExpired(command:{readonly scope:string;readonly rootId:string;readonly rootPolicyHash:string;readonly limit:number}):Promise<WorkflowTreeRecoveryResult>;
}
export interface WorkflowTreeAggregateStore extends AggregateStore {readonly workflowTrees:WorkflowTreeStore}
export type WorkflowTreeMethod=keyof WorkflowTreeStore;

const forbidden = new Set(['constructor','prototype','__proto__']);
const idPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const textEncoder = new TextEncoder();
const owned = new WeakSet<object>();
function invalid(): never { throw new StorageError('INVALID_INPUT','Invalid bounded workflow-tree metadata.'); }
function object(value: JsonValue | undefined): JsonObject { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value; }
function fields(value: JsonObject,names: readonly string[]): void { if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value,name))) invalid(); }
function id(value: unknown): string { if (typeof value !== 'string' || !idPattern.test(value) || forbidden.has(value)) invalid(); return value; }
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.length || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value) || textEncoder.encode(value).length > maximum) invalid();
  return value;
}
function integer(value: unknown,minimum=0,maximum=Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(); return value;
}
function list(value: JsonValue | undefined,maximum: number): JsonValue[] { if (!Array.isArray(value) || value.length > maximum) invalid(); return value; }
function policy(value: JsonValue | undefined, leaf: WorkflowManifest): WorkflowTreeChildPolicy {
  const item = object(value); fields(item,['permissions','maxCostMicros','maxCalls','maxOutputBytes','approvalTtlMs']);
  const permissions = list(item['permissions'],4_096).map(grant => text(grant,256));
  if (new Set(permissions).size !== permissions.length) invalid(); permissions.sort(); item['permissions'] = permissions;
  const maximum = integer(item['maxCostMicros']); const calls = integer(item['maxCalls'],1,128);
  integer(item['maxOutputBytes'],1,65_536); integer(item['approvalTtlMs'],1);
  const tools = leaf.graph.filter(node => node.kind === 'tool');
  if (tools.length > calls || tools.reduce((total,node) => total + BigInt(node.costMicros),0n) > BigInt(maximum)) invalid();
  return item as unknown as WorkflowTreeChildPolicy;
}

/**
 * Decode the complete one-level execution plan. Child leaves are legacy
 * tool/join manifests, so recursive trees cannot enter the persistence layer.
 */
export function workflowTreeManifest(value: unknown): WorkflowTreeManifest {
  try {
    if (value !== null && typeof value === 'object' && owned.has(value)) return value as WorkflowTreeManifest;
    const copy = object(jsonValue(value,{maxBytes:1_048_576,maxNodes:30_000,maxDepth:24}));
    fields(copy,['format','id','version','graph','result']);
    if (copy['format'] !== 4) invalid(); id(copy['id']); text(copy['version'],128);
    const graph = list(copy['graph'],128).map(object); if (!graph.length) invalid();
    const ids = new Set(graph.map(node => id(node['id']))); if (ids.size !== graph.length) invalid();
    let children = 0; let totalNodes = graph.length; let totalTools = 0;
    const projection: WorkflowManifestNode[] = [];
    for (const node of graph) {
      if (node['kind'] !== 'child') { projection.push(node as unknown as WorkflowManifestNode); if (node['kind'] === 'tool') totalTools++; continue; }
      children++; fields(node,['kind','id','dependsOn','workflow','policy','resources','input']);
      const leaf = workflowManifest(node['workflow']); node['workflow'] = leaf as unknown as JsonValue;
      node['policy'] = policy(node['policy'],leaf) as unknown as JsonValue;
      node['resources'] = workflowResources(node['resources'],leaf) as unknown as JsonValue;
      totalNodes += leaf.graph.length; totalTools += leaf.graph.filter(item => item.kind === 'tool').length;
      projection.push({ kind:'tool', id:node['id'] as string, dependsOn:node['dependsOn'] as string[],
        tool:`workflow/${leaf.id}`, toolVersion:leaf.version, effects:'none', capabilities:[], costMicros:0,
        approval:false, input:node['input'] as unknown as WorkflowBinding });
    }
    if (children > 16 || totalNodes > 256 || totalTools > 128) invalid();
    workflowManifest({ id:copy['id'],version:copy['version'],graph:projection,result:copy['result'] });
    const result = freezeJson(copy) as unknown as WorkflowTreeManifest; owned.add(result); return result;
  } catch { return invalid(); }
}

/** Format-4 root authority adds an explicit shared call ceiling without widening legacy policy hashes. */
export function workflowTreePolicy(value: unknown): WorkflowTreePolicyManifest {
  try {
    const copy = object(jsonValue(value,{maxBytes:1_048_576}));
    fields(copy,['scope','permissions','policyVersion','maxCostMicros','maxCalls','maxOutputBytes','approvalTtlMs']);
    const scope = object(copy['scope']); fields(scope,['principalId','projectId']); text(scope['principalId'],128); text(scope['projectId'],128);
    text(copy['policyVersion'],128); integer(copy['maxCostMicros']); integer(copy['maxCalls'],1,128);
    integer(copy['maxOutputBytes'],1,65_536); integer(copy['approvalTtlMs'],1);
    const permissions = list(copy['permissions'],4_096).map(grant => text(grant,256));
    if (new Set(permissions).size !== permissions.length) invalid(); permissions.sort(); copy['permissions'] = permissions;
    return freezeJson(copy) as unknown as WorkflowTreePolicyManifest;
  } catch { return invalid(); }
}

/** Root resources apply only to root tool nodes; child plans retain their own pinned resources. */
export function workflowTreeRootResources(value: unknown, definition: WorkflowTreeManifest): WorkflowResourcePlan {
  try {
    const manifest = workflowTreeManifest(definition);
    const projection: WorkflowManifest = {id:manifest.id,version:manifest.version,
      graph:manifest.graph.map(node => node.kind === 'child'
        ? {kind:'join',id:node.id,dependsOn:node.dependsOn}
        : node),result:manifest.result};
    return workflowResources(value,projection);
  } catch { return invalid(); }
}
