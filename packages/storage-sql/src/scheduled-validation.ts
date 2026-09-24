import { jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import { workflowManifest, workflowPolicy, workflowResources, workflowGraphManifest, workflowGraphResources, type ScheduledWorkflowStore, type WorkflowGraphStore } from '@mayura/storage-contracts';
import { claim, evidenceSource, fields, hash, immutable, integer, invalid, object, receipt, settlement } from './scheduler-validation.js';
import { identifier } from './validation.js';

export type ScheduledMethod = keyof ScheduledWorkflowStore;
const writes = new Set<ScheduledMethod>(['attach','requestApproval','approve','prepare','start','complete','abandon','failNode','advance','finalize','cancel','recover']);
export function scheduledCommand(method: ScheduledMethod, value: unknown, profile: 1 | 2 = 1): JsonObject {
  if (profile === 2 && method === 'attach') invalid();
  const raw = object(value);
  if (method === 'initialize') { fields(raw, []); return raw; }
  const common = method === 'submit' ? [] : ['scope','id','policyHash'];
  if (common.length) { hash(raw['scope']); hash(raw['id']); hash(raw['policyHash']); }
  if (writes.has(method)) { common.push('expectedVersion','commandId'); integer(raw['expectedVersion'], 1); identifier(raw['commandId'], 'Command'); }
  const node = () => identifier(raw['nodeId'], 'Node');
  const input = () => { try { raw['input'] = jsonValue(raw['input'], { maxBytes: 65_536 }); } catch { invalid(); } };
  switch (method) {
    case 'submit': case 'attach': {
      fields(raw, [...common, 'manifest','policy','resources', ...(method === 'submit' ? ['input','idempotencyKey'] : [])]);
      if (profile === 2) {
        const manifest = workflowGraphManifest(raw['manifest']);
        raw['manifest'] = manifest as unknown as JsonValue;
        raw['resources'] = workflowGraphResources(raw['resources'], manifest) as unknown as JsonValue;
      } else {
        const manifest = workflowManifest(raw['manifest']);
        raw['manifest'] = manifest as unknown as JsonValue;
        raw['resources'] = workflowResources(raw['resources'], manifest) as unknown as JsonValue;
      }
      raw['policy'] = workflowPolicy(raw['policy']) as unknown as JsonValue;
      if (method === 'submit') { input(); const key = identifier(raw['idempotencyKey'], 'Submission key'); if (key.length > 128) invalid(); }
      break;
    }
    case 'inspect': fields(raw, common); break;
    case 'requestApproval': case 'prepare': fields(raw, [...common,'nodeId','input']); node(); input(); break;
    case 'approve': fields(raw, [...common,'nodeId','digest','humanId']); node(); hash(raw['digest']); identifier(raw['humanId'], 'Human'); break;
    case 'claim': fields(raw, [...common,'workerId','limit','leaseMs']); identifier(raw['workerId'], 'Worker'); integer(raw['limit'],1,32); integer(raw['leaseMs'],1000,300_000); break;
    case 'renew': fields(raw, [...common,'claim','leaseMs']); claim(raw['claim']); integer(raw['leaseMs'],1000,300_000); break;
    case 'start': fields(raw, [...common,'claim','input']); claim(raw['claim']); input(); break;
    case 'recordReceipt': fields(raw, [...common,'jobId','fence','evidenceId','receipt'], ['settlement','source']); identifier(raw['jobId'],'Job'); integer(raw['fence'],1,128); identifier(raw['evidenceId'],'Evidence'); receipt(raw['receipt']); if (raw['settlement'] !== undefined) settlement(raw['settlement']); if (raw['source'] !== undefined) evidenceSource(raw['source']); break;
    case 'complete': fields(raw, [...common,'claim','evidenceId','outcome','output']); claim(raw['claim']); identifier(raw['evidenceId'],'Evidence');
      if (!['succeeded','failed','blocked'].includes(raw['outcome'] as string) || (raw['outcome'] !== 'succeeded' && raw['output'] !== null)) invalid();
      try { raw['output'] = jsonValue(raw['output'], { maxBytes: 65_536 }); } catch { invalid(); } break;
    case 'abandon': fields(raw, [...common,'claim','outcome']); claim(raw['claim']); if (!['failed','blocked'].includes(raw['outcome'] as string)) invalid(); break;
    case 'failNode': fields(raw, [...common,'nodeId','outcome']); node(); if (!['failed','blocked'].includes(raw['outcome'] as string)) invalid(); break;
    case 'advance': case 'cancel': case 'recover': fields(raw, common); break;
    case 'finalize': fields(raw, [...common,'validation', ...(raw['validation'] === 'passed' ? ['output'] : [])]);
      if (!['passed','failed'].includes(raw['validation'] as string)) invalid();
      if (raw['validation'] === 'passed') { try { raw['output'] = jsonValue(raw['output'], { maxBytes: 65_536 }); } catch { invalid(); } } break;
    default: invalid();
  }
  return raw;
}
/** Public finite facade snapshots before await/IPC and returns immutable transport-safe values. */
export function scheduledFacade(request: (method: ScheduledMethod, input: JsonObject) => Promise<unknown>): ScheduledWorkflowStore {
  const call = async <T>(method: ScheduledMethod, input: unknown): Promise<T> => {
    const result = await request(method, scheduledCommand(method, input)); return result === undefined ? undefined as T : immutable(result) as T;
  };
  return Object.freeze({
    initialize: () => call<void>('initialize', {}), submit: value => call('submit',value), attach: value => call('attach',value), inspect: value => call('inspect',value),
    requestApproval: value => call('requestApproval',value), approve: value => call('approve',value), prepare: value => call('prepare',value),
    claim: value => call('claim',value), renew: value => call('renew',value), start: value => call('start',value), recordReceipt: value => call('recordReceipt',value),
    complete: value => call('complete',value), abandon: value => call('abandon',value), failNode: value => call('failNode',value),
    advance: value => call('advance',value), finalize: value => call('finalize',value), cancel: value => call('cancel',value), recover: value => call('recover',value),
  } satisfies ScheduledWorkflowStore);
}

/** Separate opt-in capability; legacy facades never admit graph manifests or an attach migration. */
export function workflowGraphFacade(request: (method: keyof WorkflowGraphStore, input: JsonObject) => Promise<unknown>): WorkflowGraphStore {
  const call = async <T>(method: keyof WorkflowGraphStore, input: unknown): Promise<T> => {
    const result = await request(method, scheduledCommand(method, input, 2)); return result === undefined ? undefined as T : immutable(result) as T;
  };
  return Object.freeze({
    initialize: () => call<void>('initialize', {}), submit: value => call('submit', value), inspect: value => call('inspect', value),
    requestApproval: value => call('requestApproval', value), approve: value => call('approve', value), prepare: value => call('prepare', value),
    claim: value => call('claim', value), renew: value => call('renew', value), start: value => call('start', value), recordReceipt: value => call('recordReceipt', value),
    complete: value => call('complete', value), abandon: value => call('abandon', value), failNode: value => call('failNode', value),
    advance: value => call('advance', value), finalize: value => call('finalize', value), cancel: value => call('cancel', value), recover: value => call('recover', value),
  } satisfies WorkflowGraphStore);
}
