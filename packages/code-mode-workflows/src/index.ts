import { createHash } from 'node:crypto';
import { freezeJson, jsonValue, MayuraError, type Effect, type ExecutionEvidence, type JsonObject, type Schema, type Scope } from '@mayura/core';
import { assertCodeMode, assertCodeProgram, type CodeMode, type CodeProgramDefinition } from '@mayura/code-mode';
import { workflowHashMaterial, type AggregateStore, type StoredRecord } from '@mayura/storage-contracts';
import { defineTool } from '@mayura/tools';
import { defineWorkflow, type Binding, type WorkflowDefinition } from '@mayura/workflows';

export interface DurableCodeAuditEntry {
  readonly format: 2;
  readonly runId: string;
  readonly phaseId: string;
  readonly executionId: string;
  readonly programDigest: string;
  readonly outcome: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
  readonly evidence: readonly ExecutionEvidence[];
  readonly usage: {
    readonly toolCalls: number;
    readonly unknownCalls: number;
    readonly knownCostMicros: number;
    readonly unknownCostMicros: number;
    readonly maximumCostMicros: number;
  };
}

export interface DurableCodeAudit {
  inspect(runId: string, phaseId: string): Promise<DurableCodeAuditEntry | undefined>;
}

export interface DurableCodeAuditOptions {
  readonly store: AggregateStore;
  readonly scope: Scope;
}

export interface DurableCodePhase {
  readonly id: string;
  readonly program: CodeProgramDefinition;
  readonly input: Binding;
  readonly dependsOn?: readonly string[];
}

export interface DurableCodeWorkflowOptions<I extends Schema, O extends Schema> {
  readonly id: string;
  readonly version: string;
  readonly input: I;
  readonly output: O;
  readonly codeMode: CodeMode;
  readonly audit: DurableCodeAudit;
  readonly phases: readonly DurableCodePhase[];
  readonly result: Binding;
}

const effectRank: Readonly<Record<Effect, number>> = Object.freeze({ none: 0, read: 1, write: 2, host: 3 });
const audits = new WeakMap<object, { readonly store: AggregateStore; readonly scope: string }>();
const digest = (domain: string, value: unknown): string => createHash('sha256').update(workflowHashMaterial(domain, value), 'utf8').digest('hex');
const auditDefinitionHash = digest('mayura:code-phase-audit-definition:v2', { format: 2 });

function identifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value)
    || ['constructor', 'prototype', '__proto__'].includes(value)) throw new MayuraError('INVALID_INPUT', `${name} is invalid.`);
}

function runIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new MayuraError('INVALID_INPUT', 'Run identity is invalid.');
}

function auditId(scope: string, runId: string, phaseId: string): string {
  return digest('mayura:code-phase-audit-id:v1', { scope, runId, phaseId });
}

function auditEntry(value: unknown, expected: { readonly runId: string; readonly phaseId: string; readonly programDigest?: string }): DurableCodeAuditEntry {
  const snapshot = freezeJson(jsonValue(value, { maxBytes: 65_536 }));
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new MayuraError('STORAGE_UNAVAILABLE', 'Code phase audit is invalid.');
  const item = snapshot as unknown as Record<string, unknown>;
  const executionId = `${expected.runId}/step:${expected.phaseId}:sandbox`;
  const usage = item['usage'];
  if (Object.keys(item).length !== 8 || item['format'] !== 2 || item['runId'] !== expected.runId || item['phaseId'] !== expected.phaseId
    || item['executionId'] !== executionId
    || (expected.programDigest !== undefined && item['programDigest'] !== expected.programDigest)
    || typeof item['executionId'] !== 'string' || item['executionId'].length > 256 || !/^[a-f0-9]{64}$/.test(String(item['programDigest']))
    || !['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(String(item['outcome']))
    || !Array.isArray(item['evidence']) || item['evidence'].length > 64
    || !usage || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new MayuraError('STORAGE_UNAVAILABLE', 'Code phase audit is invalid.');
  }
  const accounting = usage as Record<string, unknown>;
  if (Object.keys(accounting).length !== 5 || !Number.isSafeInteger(accounting['toolCalls']) || (accounting['toolCalls'] as number) < 0
    || (accounting['toolCalls'] as number) > 64 || !Number.isSafeInteger(accounting['unknownCalls'])
    || (accounting['unknownCalls'] as number) < 0 || (accounting['unknownCalls'] as number) > (accounting['toolCalls'] as number)
    || !Number.isSafeInteger(accounting['knownCostMicros'])
    || (accounting['knownCostMicros'] as number) < 0 || !Number.isSafeInteger(accounting['unknownCostMicros'])
    || (accounting['unknownCostMicros'] as number) < 0 || !Number.isSafeInteger(accounting['maximumCostMicros'])
    || (accounting['maximumCostMicros'] as number) < 0
    || (accounting['knownCostMicros'] as number) + (accounting['unknownCostMicros'] as number) > (accounting['maximumCostMicros'] as number)
    || item['evidence'].length > (accounting['toolCalls'] as number)) {
    throw new MayuraError('STORAGE_UNAVAILABLE', 'Code phase audit usage is invalid.');
  }
  const sequences = new Set<number>();
  let unknownReceipts = 0;
  for (const evidence of item['evidence']) {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new MayuraError('STORAGE_UNAVAILABLE', 'Code phase audit is invalid.');
    const record = evidence as Record<string, unknown>; const receipt = record['receipt'];
    if (Object.keys(record).length !== 2 || record['runId'] !== expected.runId || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      throw new MayuraError('STORAGE_UNAVAILABLE', 'Code phase audit is invalid.');
    }
    const fields = receipt as Record<string, unknown>;
    const callId = fields['callId']; const toolId = fields['toolId'];
    const sequence = typeof callId === 'string' && callId.startsWith(`${executionId}:code:`) ? Number(callId.slice(executionId.length + 6)) : NaN;
    if (Object.keys(fields).length !== 4 || typeof callId !== 'string' || callId.length > 256
      || typeof toolId !== 'string' || !/^[A-Za-z][A-Za-z0-9._/-]{0,127}$/.test(toolId)
      || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 64 || sequences.has(sequence)
      || !['not_started', 'succeeded', 'failed', 'unknown'].includes(String(fields['execution']))
      || !['released', 'withheld'].includes(String(fields['disclosure']))) throw new MayuraError('STORAGE_UNAVAILABLE', 'Code phase audit is invalid.');
    if (fields['execution'] === 'unknown') unknownReceipts++;
    sequences.add(sequence);
  }
  if (unknownReceipts > (accounting['unknownCalls'] as number)
    || ((accounting['unknownCalls'] as number) > 0 && item['outcome'] !== 'outcome_unknown')) {
    throw new MayuraError('STORAGE_UNAVAILABLE', 'Code phase audit reconciliation state is invalid.');
  }
  return snapshot as unknown as DurableCodeAuditEntry;
}

function assertAuditRecord(record: StoredRecord, scope: string, id: string): void {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 6
    || record.scope !== scope || record.id !== id || record.idempotencyKey !== id || record.definitionHash !== auditDefinitionHash
    || !Number.isSafeInteger(record.version) || record.version < 1) {
    throw new MayuraError('STORAGE_UNAVAILABLE', 'Code phase audit identity is invalid.');
  }
}

/** Creates an immutable per-phase nested-receipt ledger on an explicitly selected aggregate store. */
export function createDurableCodeAudit(options: DurableCodeAuditOptions): DurableCodeAudit {
  const value = data(options, ['store', 'scope']);
  const store = value['store'] as AggregateStore;
  if (!store || typeof store.create !== 'function' || typeof store.read !== 'function') throw new MayuraError('INVALID_CONFIG', 'A durable aggregate store is required.');
  const scopeValue = freezeJson(jsonValue(value['scope'], { maxBytes: 2_048 }));
  if (!scopeValue || typeof scopeValue !== 'object' || Array.isArray(scopeValue) || Object.keys(scopeValue).length !== 2
    || typeof scopeValue['principalId'] !== 'string' || scopeValue['principalId'].trim().length === 0 || scopeValue['principalId'].length > 256
    || typeof scopeValue['projectId'] !== 'string' || scopeValue['projectId'].trim().length === 0 || scopeValue['projectId'].length > 256) {
    throw new MayuraError('INVALID_CONFIG', 'A bounded audit scope is required.');
  }
  const scope = digest('mayura:scope:v1', scopeValue);
  const audit = Object.freeze({
    async inspect(runId: string, phaseId: string): Promise<DurableCodeAuditEntry | undefined> {
      runIdentifier(runId); identifier(phaseId, 'Phase identity');
      const id = auditId(scope, runId, phaseId); const record = await store.read(scope, id);
      if (!record) return undefined;
      assertAuditRecord(record, scope, id);
      return auditEntry(record.state, { runId, phaseId });
    },
  });
  audits.set(audit, Object.freeze({ store, scope }));
  return audit;
}

async function recordAudit(audit: DurableCodeAudit, entry: DurableCodeAuditEntry): Promise<void> {
  const registration = audits.get(audit);
  if (!registration) throw new MayuraError('INVALID_CONFIG', 'Use createDurableCodeAudit from this package instance.');
  const admitted = auditEntry(entry, entry);
  const id = auditId(registration.scope, entry.runId, entry.phaseId);
  const result = await registration.store.create({ scope: registration.scope, id, idempotencyKey: id,
    definitionHash: auditDefinitionHash, state: admitted as unknown as JsonObject,
    events: [{ type: 'code.phase.evidence', data: { phaseId: entry.phaseId, programDigest: entry.programDigest,
      outcome: entry.outcome, receipts: entry.evidence.length, toolCalls: entry.usage.toolCalls, unknownCalls: entry.usage.unknownCalls,
      knownCostMicros: entry.usage.knownCostMicros, unknownCostMicros: entry.usage.unknownCostMicros } }],
  });
  assertAuditRecord(result.record, registration.scope, id);
  auditEntry(result.record.state, entry);
}

function data(value: unknown, fields: readonly string[], required: readonly string[] = fields): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new MayuraError('INVALID_CONFIG', 'Durable Code Mode definitions must be plain data.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !fields.includes(key))
    || required.some(key => !descriptors[key])) throw new MayuraError('INVALID_CONFIG', 'Durable Code Mode fields are invalid.');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) throw new MayuraError('INVALID_CONFIG', 'Durable Code Mode fields must be data properties.');
    if (descriptor.value !== undefined || required.includes(key)) result[key] = descriptor.value;
  }
  return result;
}

function phaseTool(mode: CodeMode, audit: DurableCodeAudit, phaseId: string, program: CodeProgramDefinition) {
  assertCodeProgram(program);
  const auditRegistration = audits.get(audit);
  if (!auditRegistration) throw new MayuraError('INVALID_CONFIG', 'Use createDurableCodeAudit from this package instance.');
  if (program.manifest.limits.maxToolCalls > 64) throw new MayuraError('LIMIT_EXCEEDED', 'Durable phases support at most 64 auditable nested calls.');
  const maximumToolCost = program.manifest.tools.reduce((maximum, tool) => Math.max(maximum, tool.costMicros), 0);
  const costMicros = maximumToolCost * program.manifest.limits.maxToolCalls;
  if (!Number.isSafeInteger(costMicros)) throw new MayuraError('LIMIT_EXCEEDED', 'Durable phase maximum tool cost exceeds safe accounting.');
  const effects = program.manifest.tools.reduce<Effect>((strongest, tool) => effectRank[tool.effects] > effectRank[strongest] ? tool.effects : strongest, 'none');
  return defineTool({
    id: `code.${program.manifest.digest.slice(0, 32)}`,
    version: program.manifest.digest,
    description: `Approved Code Mode phase: ${program.manifest.id}`,
    input: program.input,
    output: program.output,
    effects,
    capabilities: [`code:execute`, 'code:audit:v2', `code:audit-scope:${auditRegistration.scope}`, `code:program:${program.manifest.digest}`],
    timeoutMs: program.manifest.limits.wallTimeMillis,
    costMicros,
    execute: async (input, context) => {
      if (digest('mayura:scope:v1', context.scope) !== auditRegistration.scope) {
        throw new MayuraError('PERMISSION_DENIED', 'The durable audit is bound to a different execution scope.');
      }
      const outcome = await mode.execute(program, input, { runId: context.runId, executionId: `${context.callId}:sandbox`,
        scope: context.scope, signal: context.signal });
      const toolCosts = new Map(program.manifest.tools.map(tool => [tool.id, tool.costMicros]));
      let evidencedKnownCost = 0; let evidencedUnknownCost = 0; let evidencedUnknownCalls = 0;
      for (const item of outcome.evidence ?? []) {
        const toolCost = toolCosts.get(item.receipt.toolId);
        if (toolCost === undefined) throw new MayuraError('OUTCOME_UNKNOWN', 'Code Mode usage could not be bound to the approved program.');
        if (item.receipt.execution === 'unknown') { evidencedUnknownCalls++; evidencedUnknownCost += toolCost; }
        else if (item.receipt.execution !== 'not_started') evidencedKnownCost += toolCost;
      }
      if (!Number.isSafeInteger(evidencedKnownCost) || !Number.isSafeInteger(evidencedUnknownCost)
        || outcome.usage.maximumCostMicros !== costMicros || outcome.usage.toolCalls > program.manifest.limits.maxToolCalls
        || outcome.usage.knownCostMicros !== evidencedKnownCost || outcome.usage.unknownCalls < evidencedUnknownCalls
        || outcome.usage.unknownCostMicros < evidencedUnknownCost) {
        throw new MayuraError('OUTCOME_UNKNOWN', 'Code Mode usage could not be bound to the approved program.');
      }
      context.reportUsage({ knownCostMicros: outcome.usage.knownCostMicros, unknownCostMicros: outcome.usage.unknownCostMicros });
      await recordAudit(audit, Object.freeze({ format: 2, runId: context.runId, phaseId, executionId: `${context.callId}:sandbox`,
        programDigest: program.manifest.digest, outcome: outcome.status, evidence: Object.freeze([...(outcome.evidence ?? [])]),
        usage: outcome.usage }));
      if (outcome.status === 'succeeded') return outcome.output;
      throw new MayuraError(outcome.error.code, 'Durable Code Mode phase failed; nested details are withheld.');
    },
  });
}

/**
 * Creates a finite durable workflow whose Code Mode phases all require exact human approval.
 * Persistence, leasing and no-replay behavior are supplied by the selected scheduled-workflow runtime.
 */
export function defineDurableCodeWorkflow<I extends Schema, O extends Schema>(
  options: DurableCodeWorkflowOptions<I, O>,
): WorkflowDefinition<I, O> {
  const value = data(options, ['id', 'version', 'input', 'output', 'codeMode', 'audit', 'phases', 'result']);
  const mode = value['codeMode'] as CodeMode;
  assertCodeMode(mode);
  const audit = value['audit'] as DurableCodeAudit;
  if (!audits.has(audit)) throw new MayuraError('INVALID_CONFIG', 'Use createDurableCodeAudit from this package instance.');
  if (!Array.isArray(value['phases']) || value['phases'].length < 1 || value['phases'].length > 128) {
    throw new MayuraError('INVALID_CONFIG', 'Durable Code Mode requires 1–128 explicit phases.');
  }
  const phases = value['phases'].map(item => {
    const phase = data(item, ['id', 'program', 'input', 'dependsOn'], ['id', 'program', 'input']);
    if (typeof phase['id'] !== 'string') throw new MayuraError('INVALID_CONFIG', 'Durable Code Mode phase id is invalid.');
    const program = phase['program'] as CodeProgramDefinition;
    return Object.freeze({ kind: 'tool' as const, id: phase['id'], tool: phaseTool(mode, audit, phase['id'], program), input: phase['input'] as Binding,
      ...(phase['dependsOn'] === undefined ? {} : { dependsOn: phase['dependsOn'] as readonly string[] }), approval: true });
  });
  return defineWorkflow({ id: value['id'] as string, version: value['version'] as string, input: value['input'] as I,
    output: value['output'] as O, nodes: phases, result: value['result'] as Binding });
}
