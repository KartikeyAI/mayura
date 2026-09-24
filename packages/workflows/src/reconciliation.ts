import { MayuraError } from '@mayura/core';
import type { ExternalEffectReconciliationRequest, VerifiedExternalEffect } from './scheduled.js';

const identity = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const toolId = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

export interface ExternalEffectProviderAttestation {
  readonly attestationId: string;
  readonly execution: 'not_started' | 'succeeded' | 'failed';
  readonly knownCostMicros: number;
}

export interface ExternalEffectVerifierOptions {
  /** Stable provider/audit authority recorded with accepted evidence. */
  readonly authorityId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  /** Authenticate and inspect the provider using only the caller-supplied credential. */
  readonly verify: (request: ExternalEffectReconciliationRequest, credential: unknown) => PromiseLike<ExternalEffectProviderAttestation>;
}

export interface ExternalEffectVerifier {
  readonly authorityId: string;
  readonly toolId: string;
  readonly toolVersion: string;
}

export type ExternalEffectVerificationRouter =
  (request: ExternalEffectReconciliationRequest, credential: unknown) => Promise<VerifiedExternalEffect>;

const implementations = new WeakMap<ExternalEffectVerifier, ExternalEffectVerifierOptions['verify']>();

function own(value: unknown, expected: readonly string[]): Record<string, PropertyDescriptor> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new MayuraError('INVALID_CONFIG', 'External-effect verifier configuration must be plain data.');
  }
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== expected.length || expected.some(key => !fields[key] || !('value' in fields[key]!))) {
    throw new MayuraError('INVALID_CONFIG', 'External-effect verifier configuration has an invalid shape.');
  }
  return fields;
}

/** Defines one exact provider/tool verification route without exposing its credential callback as public data. */
export function defineExternalEffectVerifier(options: ExternalEffectVerifierOptions): ExternalEffectVerifier {
  const fields = own(options, ['authorityId', 'toolId', 'toolVersion', 'verify']);
  const authority = fields['authorityId']!.value; const id = fields['toolId']!.value;
  const version = fields['toolVersion']!.value; const verify = fields['verify']!.value;
  if (typeof authority !== 'string' || !identity.test(authority) || typeof id !== 'string' || !toolId.test(id)
    || typeof version !== 'string' || version.trim().length === 0 || version.length > 128 || typeof verify !== 'function') {
    throw new MayuraError('INVALID_CONFIG', 'External-effect verifier identity or callback is invalid.');
  }
  const definition = Object.freeze({ authorityId: authority, toolId: id, toolVersion: version });
  implementations.set(definition, verify as ExternalEffectVerifierOptions['verify']);
  return definition;
}

function attestation(value: unknown, request: ExternalEffectReconciliationRequest): ExternalEffectProviderAttestation {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new MayuraError('PERMISSION_DENIED', 'External-effect verification did not authorize reconciliation.');
  }
  const fields = Object.getOwnPropertyDescriptors(value);
  const names = ['attestationId', 'execution', 'knownCostMicros'];
  if (Reflect.ownKeys(fields).length !== names.length || names.some(key => !fields[key] || !('value' in fields[key]!))) {
    throw new MayuraError('PERMISSION_DENIED', 'External-effect verification did not authorize reconciliation.');
  }
  const id = fields['attestationId']!.value; const execution = fields['execution']!.value; const cost = fields['knownCostMicros']!.value;
  if (typeof id !== 'string' || !identity.test(id) || !['not_started', 'succeeded', 'failed'].includes(execution as string)
    || typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 0 || cost > request.maximumCostMicros
    || (execution === 'not_started' && cost !== 0)) {
    throw new MayuraError('PERMISSION_DENIED', 'External-effect verification did not authorize reconciliation.');
  }
  return Object.freeze({ attestationId: id, execution, knownCostMicros: cost }) as ExternalEffectProviderAttestation;
}

function reconciliationRequest(value: unknown): ExternalEffectReconciliationRequest {
  const denied = (): never => { throw new MayuraError('PERMISSION_DENIED', 'External-effect verification request is invalid.'); };
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return denied();
  const names = ['runId', 'definitionHash', 'nodeId', 'jobId', 'fence', 'callId', 'toolId', 'toolVersion', 'maximumCostMicros', 'scope'];
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== names.length || names.some(key => !fields[key] || !('value' in fields[key]!))) return denied();
  const scopeValue = fields['scope']!.value;
  if (!scopeValue || typeof scopeValue !== 'object' || Object.getPrototypeOf(scopeValue) !== Object.prototype) return denied();
  const scopeFields = Object.getOwnPropertyDescriptors(scopeValue);
  if (Reflect.ownKeys(scopeFields).length !== 2 || !scopeFields['principalId'] || !('value' in scopeFields['principalId'])
    || !scopeFields['projectId'] || !('value' in scopeFields['projectId'])) return denied();
  const bounded = (item: unknown): item is string => typeof item === 'string' && item.length > 0 && item.length <= 256;
  const runId = fields['runId']!.value; const definitionHash = fields['definitionHash']!.value; const nodeId = fields['nodeId']!.value;
  const jobId = fields['jobId']!.value; const fence = fields['fence']!.value; const callId = fields['callId']!.value;
  const id = fields['toolId']!.value; const version = fields['toolVersion']!.value; const maximum = fields['maximumCostMicros']!.value;
  const principalId = scopeFields['principalId'].value; const projectId = scopeFields['projectId'].value;
  if (![runId, jobId, callId, principalId, projectId].every(bounded) || typeof definitionHash !== 'string' || !/^[a-f0-9]{64}$/.test(definitionHash)
    || typeof nodeId !== 'string' || !toolId.test(nodeId) || typeof id !== 'string' || !toolId.test(id)
    || typeof version !== 'string' || version.trim().length === 0 || version.length > 128 || !Number.isSafeInteger(fence) || fence < 1
    || !Number.isSafeInteger(maximum) || maximum < 0) return denied();
  return Object.freeze({ runId, definitionHash, nodeId, jobId, fence, callId, toolId: id, toolVersion: version,
    maximumCostMicros: maximum, scope: Object.freeze({ principalId, projectId }) });
}

/** Composes registered exact provider/tool routes into the scheduled runtime's trusted verification callback. */
export function composeExternalEffectVerifiers(verifiers: readonly ExternalEffectVerifier[]): ExternalEffectVerificationRouter {
  if (!Array.isArray(verifiers) || verifiers.length < 1 || verifiers.length > 64) {
    throw new MayuraError('INVALID_CONFIG', 'External-effect verifiers must be a bounded nonempty array.');
  }
  const routes = new Map<string, { readonly definition: ExternalEffectVerifier; readonly verify: ExternalEffectVerifierOptions['verify'] }>();
  for (const definition of verifiers) {
    const verify = implementations.get(definition);
    if (!verify) throw new MayuraError('INVALID_CONFIG', 'External-effect verifier was not created by this package instance.');
    const key = `${definition.toolId}\u0000${definition.toolVersion}`;
    if (routes.has(key)) throw new MayuraError('INVALID_CONFIG', 'External-effect verifier routes must be unique.');
    routes.set(key, { definition, verify });
  }
  return async (request, credential) => {
    const admitted = reconciliationRequest(request);
    const route = routes.get(`${admitted.toolId}\u0000${admitted.toolVersion}`);
    if (!route) throw new MayuraError('PERMISSION_DENIED', 'No trusted verifier is registered for this external effect.');
    const verified = attestation(await route.verify(admitted, credential), admitted);
    return Object.freeze({ authorityId: route.definition.authorityId, attestationId: verified.attestationId,
      execution: verified.execution, knownCostMicros: verified.knownCostMicros });
  };
}
