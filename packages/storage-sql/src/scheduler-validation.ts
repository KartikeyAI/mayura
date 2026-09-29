import { freezeJson, jsonValue, type ExecutionReceipt, type ExecutionSettlement, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError } from './contracts.js';
import { identifier } from './validation.js';
import type { Claim, JobReservation, SchedulerEvidenceSource, SchedulerStore } from './scheduler-contracts.js';
import { sha256Hex } from '@mayura/core/host';

export type SchedulerMethod = keyof SchedulerStore;
export const MAX_DELAY = 30 * 86_400_000;
export function invalid(): never { throw new StorageError('INVALID_INPUT', 'Invalid bounded scheduler command.'); }
export function object(value: unknown, maxBytes = 1_048_576): JsonObject {
  try {
    const result = jsonValue(value, { maxBytes, maxDepth: 32, maxNodes: 100_000 });
    if (result === null || Array.isArray(result) || typeof result !== 'object') return invalid();
    return result;
  } catch { return invalid(); }
}
export function fields(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
export function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
export function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
export function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}
export function schedulerDigest(kind: string, value: unknown): string {
  return sha256Hex(`mayura:scheduler-${kind}:v1\n` + canonical(jsonValue(value)));
}
export function immutable<T>(value: T): T {
  try { return freezeJson(jsonValue(value, { maxBytes: 8_388_608, maxNodes: 300_000 })) as T; }
  catch { throw new StorageError('STORAGE_UNAVAILABLE', 'The scheduler result failed its bounded transport validation.'); }
}
export function receipt(value: unknown): ExecutionReceipt {
  const raw = object(value, 2048); fields(raw, ['callId', 'toolId', 'execution', 'disclosure']);
  identifier(raw['callId'], 'Receipt call'); identifier(raw['toolId'], 'Receipt tool');
  if (!['not_started', 'succeeded', 'failed', 'unknown'].includes(raw['execution'] as string) || raw['disclosure'] !== 'withheld') invalid();
  return raw as unknown as ExecutionReceipt;
}
export function settlement(value: unknown): ExecutionSettlement {
  const raw = object(value, 512); fields(raw, ['knownCostMicros', 'unknownCostMicros']);
  integer(raw['knownCostMicros']); integer(raw['unknownCostMicros']);
  if ((raw['knownCostMicros'] as number) > Number.MAX_SAFE_INTEGER - (raw['unknownCostMicros'] as number)) invalid();
  return raw as unknown as ExecutionSettlement;
}
export function evidenceSource(value: unknown): SchedulerEvidenceSource {
  const raw = object(value, 1_024); fields(raw, ['kind', 'authorityId', 'attestationHash']);
  if (raw['kind'] !== 'external_reconciliation') invalid();
  identifier(raw['authorityId'], 'Evidence authority'); hash(raw['attestationHash']);
  return raw as unknown as SchedulerEvidenceSource;
}
export function claim(value: unknown): Claim {
  const raw = object(value, 2048); fields(raw, ['scope', 'jobId', 'workerId', 'fence', 'leaseUntilMs']);
  for (const key of ['scope','jobId','workerId']) identifier(raw[key], key);
  integer(raw['fence'], 1, 128); integer(raw['leaseUntilMs']);
  return raw as unknown as Claim;
}
export function reservation(value: unknown): JobReservation {
  const raw = object(value, 20_000);
  fields(raw, ['scope','jobId','reservationKey','runId','nodeId','invocationId','definitionHash','candidateHash','intent','resourceKeys','delayMs'], ['deadlineAfterMs']);
  for (const key of ['scope','jobId','reservationKey','runId','nodeId','invocationId']) identifier(raw[key], key);
  hash(raw['definitionHash']); hash(raw['candidateHash']);
  const intent = object(raw['intent'], 4096); identifier(intent['toolId'], 'Intent tool'); identifier(intent['callId'], 'Intent call');
  if (!Array.isArray(raw['resourceKeys']) || raw['resourceKeys'].length > 32) invalid();
  const resources = [...new Set(raw['resourceKeys'].map(value => identifier(value, 'Resource')))].sort();
  integer(raw['delayMs'], 0, MAX_DELAY);
  if (raw['deadlineAfterMs'] !== undefined) integer(raw['deadlineAfterMs'], (raw['delayMs'] as number) + 1, MAX_DELAY);
  return { ...raw, intent, resourceKeys: resources } as unknown as JobReservation;
}
/** Snapshot and validate before any await/IPC, including unexpected command properties. */
export function schedulerCommand(method: SchedulerMethod, value: unknown): JsonObject {
  if (method === 'reserve') return object(reservation(value));
  const raw = object(value);
  const key = () => { identifier(raw['scope'], 'Scope'); identifier(raw['jobId'], 'Job'); };
  switch (method) {
    case 'initialize': fields(raw, []); break;
    case 'read': fields(raw, ['scope','jobId']); key(); break;
    case 'claim': fields(raw, ['scope','workerId','limit','leaseMs']); identifier(raw['scope'], 'Scope'); identifier(raw['workerId'], 'Worker'); integer(raw['limit'], 1, 32); integer(raw['leaseMs'], 1_000, 300_000); break;
    case 'renew': fields(raw, ['claim','leaseMs']); claim(raw['claim']); integer(raw['leaseMs'], 1_000, 300_000); break;
    case 'start': fields(raw, ['claim','candidateHash']); claim(raw['claim']); hash(raw['candidateHash']); break;
    case 'receipts': fields(raw, ['scope','jobId','fence']); key(); integer(raw['fence'], 1, 128); break;
    case 'recordReceipt': fields(raw, ['scope','jobId','fence','evidenceId','receipt'], ['settlement','source']); key(); integer(raw['fence'], 1, 128); identifier(raw['evidenceId'], 'Evidence'); receipt(raw['receipt']); if (raw['settlement'] !== undefined) settlement(raw['settlement']); if (raw['source'] !== undefined) evidenceSource(raw['source']); break;
    case 'complete': fields(raw, ['claim','commandId','evidenceId','outcome','output']); claim(raw['claim']); identifier(raw['commandId'], 'Command'); identifier(raw['evidenceId'], 'Evidence');
      if (!['succeeded','failed','blocked'].includes(raw['outcome'] as string) || (raw['outcome'] !== 'succeeded' && raw['output'] !== null)) invalid();
      try { jsonValue(raw['output'], { maxBytes: 65_536 }); } catch { invalid(); } break;
    case 'cancel': fields(raw, ['scope','jobId','commandId']); key(); identifier(raw['commandId'], 'Command'); break;
    case 'recover': fields(raw, ['scope','limit']); identifier(raw['scope'], 'Scope'); integer(raw['limit'], 1, 128); break;
    case 'events': fields(raw, ['scope','runId'], ['after','limit']); identifier(raw['scope'], 'Scope'); identifier(raw['runId'], 'Run'); if (raw['after'] !== undefined) integer(raw['after']); if (raw['limit'] !== undefined) integer(raw['limit'], 1, 1_000); break;
    default: invalid();
  }
  return raw;
}

/** Facade shields mutable IPC/driver replies and shares the containing adapter's lifecycle. */
export function schedulerFacade(request: (method: SchedulerMethod, input: JsonObject) => Promise<unknown>): SchedulerStore {
  const call = async <T>(method: SchedulerMethod, input: unknown): Promise<T> => {
    const result = await request(method, schedulerCommand(method, input));
    return result === undefined ? undefined as T : immutable(result) as T;
  };
  return Object.freeze({
    initialize: () => call<void>('initialize', {}), reserve: input => call('reserve', input), read: input => call('read', input),
    claim: input => call('claim', input), renew: input => call('renew', input), start: input => call('start', input),
    recordReceipt: input => call('recordReceipt', input), receipts: input => call('receipts', input), complete: input => call('complete', input),
    cancel: input => call('cancel', input), recover: input => call('recover', input), events: input => call('events', input),
  } satisfies SchedulerStore);
}
