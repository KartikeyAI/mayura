import { ClientError, type MayuraClient, type RemoteHumanRequest } from './index.js';

export interface HumanTextField {
  readonly kind: 'text' | 'textarea'; readonly name: string; readonly label: string; readonly required?: boolean;
  readonly minLength?: number; readonly maxLength?: number;
}
export interface HumanNumberField {
  readonly kind: 'number' | 'integer'; readonly name: string; readonly label: string; readonly required?: boolean;
  readonly minimum?: number; readonly maximum?: number;
}
export interface HumanBooleanField { readonly kind: 'boolean'; readonly name: string; readonly label: string; readonly required?: boolean }
export interface HumanSelectOption { readonly value: string; readonly label: string }
export interface HumanSelectField {
  readonly kind: 'select'; readonly name: string; readonly label: string; readonly required?: boolean;
  readonly options: readonly HumanSelectOption[];
}
export type HumanResponseField = HumanTextField | HumanNumberField | HumanBooleanField | HumanSelectField;
export interface HumanResponseFormDefinition {
  readonly schemaId: string; readonly schemaDigest: string; readonly fields: readonly HumanResponseField[];
}
export type HumanResponseDraft = Readonly<Record<string, string | boolean>>;
export interface HumanResponseSubmission {
  readonly id: string; readonly digest: string; readonly value: Readonly<Record<string, string | number | boolean>>;
}
export type HumanResponseCommandStatus = 'idle' | 'submitting' | 'succeeded' | 'conflict' | 'failed' | 'disposed';
export interface HumanResponseCommandState {
  readonly revision: number; readonly status: HumanResponseCommandStatus; readonly requestId: string; readonly requestDigest: string;
  readonly responseStatus: RemoteHumanRequest['status'] | null; readonly errorCode: string | null;
}
export interface HumanResponseControllerOptions {
  readonly client: Pick<MayuraClient, 'respondHumanRequest'>; readonly request: RemoteHumanRequest; readonly maxSubscribers?: number;
}
export interface HumanResponseController {
  getSnapshot(): HumanResponseCommandState;
  subscribe(listener: () => void): () => void;
  submit(submission: HumanResponseSubmission, options: { readonly commandId: string; readonly signal?: AbortSignal }): Promise<RemoteHumanRequest>;
  reset(): HumanResponseCommandState;
  dispose(): void;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const fieldPattern = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const definitions = new WeakSet<object>();
const submissions = new WeakSet<object>();
const encoder = new TextEncoder();
function invalid(code = 'INVALID_FORM_CONFIG'): never { throw new ClientError(code); }
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value) || encoder.encode(value).byteLength > maximum) return invalid();
  return value;
}
function own(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, PropertyDescriptor> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key) || !('value' in descriptors[key]!)) || required.some(key => !descriptors[key])) return invalid();
  return descriptors;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid(); return value;
}
function finite(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(); return value; }
function validRequest(request: unknown): request is RemoteHumanRequest {
  if (!request || typeof request !== 'object' || !Object.isFrozen(request) || Array.isArray(request)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(request))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(request); const allowed = ['id', 'agentId', 'kind', 'schemaId', 'schemaDigest', 'prompt', 'digest', 'status', 'context', 'subjectDigest', 'deadlineAtMs'];
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key) || !('value' in descriptors[key]!))
    || ['id', 'agentId', 'kind', 'schemaId', 'schemaDigest', 'prompt', 'digest', 'status'].some(key => !descriptors[key])) return false;
  const value = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])) as Record<string, unknown>;
  return typeof value['id'] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value['id'])
    && typeof value['agentId'] === 'string' && idPattern.test(value['agentId']) && typeof value['schemaId'] === 'string' && idPattern.test(value['schemaId'])
    && typeof value['schemaDigest'] === 'string' && /^[a-f0-9]{64}$/.test(value['schemaDigest']) && typeof value['digest'] === 'string' && /^[a-f0-9]{64}$/.test(value['digest'])
    && typeof value['prompt'] === 'string' && encoder.encode(value['prompt']).byteLength >= 1 && encoder.encode(value['prompt']).byteLength <= 1_024
    && ['information', 'correction', 'plan_selection'].includes(String(value['kind'])) && ['waiting', 'answered', 'cancelled', 'timed_out'].includes(String(value['status']))
    && (value['subjectDigest'] === undefined || (typeof value['subjectDigest'] === 'string' && /^[a-f0-9]{64}$/.test(value['subjectDigest'])))
    && ((value['kind'] === 'correction') === (value['subjectDigest'] !== undefined))
    && (value['deadlineAtMs'] === undefined || (Number.isSafeInteger(value['deadlineAtMs']) && (value['deadlineAtMs'] as number) >= 0));
}

/** Capture an ergonomic finite field declaration as a deeply immutable, schema-bound form definition. */
export function defineHumanResponseForm(input: HumanResponseFormDefinition): HumanResponseFormDefinition {
  const root = own(input, ['schemaId', 'schemaDigest', 'fields'], ['schemaId', 'schemaDigest', 'fields']);
  const schemaId = root['schemaId']!.value; const schemaDigest = root['schemaDigest']!.value; const supplied = root['fields']!.value;
  if (typeof schemaId !== 'string' || !idPattern.test(schemaId) || typeof schemaDigest !== 'string' || !/^[a-f0-9]{64}$/.test(schemaDigest)
    || !Array.isArray(supplied) || supplied.length < 1 || supplied.length > 32) return invalid();
  const names = new Set<string>(); const fields: HumanResponseField[] = [];
  for (const raw of supplied) {
    const common = own(raw, ['kind', 'name', 'label', 'required', 'minLength', 'maxLength', 'minimum', 'maximum', 'options'], ['kind', 'name', 'label']);
    const kind = common['kind']!.value; const name = common['name']!.value; const label = text(common['label']!.value, 256); const required = common['required']?.value ?? false;
    if (!['text', 'textarea', 'number', 'integer', 'boolean', 'select'].includes(String(kind)) || typeof name !== 'string' || !fieldPattern.test(name)
      || forbidden.has(name) || names.has(name) || typeof required !== 'boolean') return invalid(); names.add(name);
    if (kind === 'text' || kind === 'textarea') {
      if (common['minimum'] || common['maximum'] || common['options']) return invalid();
      const minLength = common['minLength'] ? integer(common['minLength'].value, 0, 16_384) : 0;
      const maxLength = common['maxLength'] ? integer(common['maxLength'].value, 1, 16_384) : 4_096;
      if (minLength > maxLength || (required && maxLength < 1)) return invalid();
      fields.push(Object.freeze({ kind, name, label, required, minLength, maxLength })); continue;
    }
    if (kind === 'number' || kind === 'integer') {
      if (common['minLength'] || common['maxLength'] || common['options']) return invalid();
      const minimum = common['minimum'] ? finite(common['minimum'].value) : -Number.MAX_SAFE_INTEGER;
      const maximum = common['maximum'] ? finite(common['maximum'].value) : Number.MAX_SAFE_INTEGER;
      if (minimum > maximum || (kind === 'integer' && (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)))) return invalid();
      fields.push(Object.freeze({ kind, name, label, required, minimum, maximum })); continue;
    }
    if (kind === 'boolean') {
      if (common['minLength'] || common['maxLength'] || common['minimum'] || common['maximum'] || common['options']) return invalid();
      fields.push(Object.freeze({ kind, name, label, required })); continue;
    }
    if (common['minLength'] || common['maxLength'] || common['minimum'] || common['maximum']) return invalid();
    const options = common['options']?.value;
    if (!Array.isArray(options) || options.length < 1 || options.length > 64) return invalid(); const values = new Set<string>();
    const captured = options.map(option => { const item = own(option, ['value', 'label'], ['value', 'label']); const value = item['value']!.value;
      if (typeof value !== 'string' || !fieldPattern.test(value) || forbidden.has(value) || values.has(value)) return invalid(); values.add(value);
      return Object.freeze({ value, label: text(item['label']!.value, 256) }); });
    fields.push(Object.freeze({ kind: 'select', name, label, required, options: Object.freeze(captured) }));
  }
  const definition = Object.freeze({ schemaId, schemaDigest, fields: Object.freeze(fields) }); definitions.add(definition); return definition;
}

/** Validate a UI draft and bind the typed value to one exact authenticated request/digest. */
export function validateHumanResponse(request: RemoteHumanRequest, definition: HumanResponseFormDefinition, draft: HumanResponseDraft): HumanResponseSubmission {
  if (!validRequest(request) || !definitions.has(definition) || request.schemaId !== definition.schemaId || request.schemaDigest !== definition.schemaDigest
    || request.status !== 'waiting' || !draft || typeof draft !== 'object' || Array.isArray(draft) || ![null, Object.prototype].includes(Object.getPrototypeOf(draft))
    || !Object.isFrozen(draft)) return invalid('INVALID_FORM_VALUE');
  const descriptors = Object.getOwnPropertyDescriptors(draft); const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string' || forbidden.has(key) || !('value' in descriptors[key]!)) || keys.length > definition.fields.length) return invalid('INVALID_FORM_VALUE');
  const fields = new Map(definition.fields.map(field => [field.name, field])); if (keys.some(key => !fields.has(key as string))) return invalid('INVALID_FORM_VALUE');
  const result: Record<string, string | number | boolean> = Object.create(null) as Record<string, string | number | boolean>;
  for (const field of definition.fields) {
    const supplied = descriptors[field.name]?.value;
    if (field.kind === 'boolean') { if (supplied === undefined && !field.required) continue; if (typeof supplied !== 'boolean') return invalid('INVALID_FORM_VALUE'); result[field.name] = supplied; continue; }
    if (supplied === undefined || supplied === '') { if (field.required) return invalid('INVALID_FORM_VALUE'); continue; }
    if (typeof supplied !== 'string' || supplied.includes('\0') || /[\uD800-\uDFFF]/u.test(supplied)) return invalid('INVALID_FORM_VALUE');
    if (field.kind === 'text' || field.kind === 'textarea') {
      const length = [...supplied].length;
      if (length < (field.minLength ?? 0) || length > (field.maxLength ?? 4_096) || encoder.encode(supplied).byteLength > 65_536) return invalid('INVALID_FORM_VALUE');
      result[field.name] = supplied; continue;
    }
    if (field.kind === 'select') { if (!field.options.some(option => option.value === supplied)) return invalid('INVALID_FORM_VALUE'); result[field.name] = supplied; continue; }
    if (field.kind !== 'number' && field.kind !== 'integer') return invalid('INVALID_FORM_VALUE');
    if (supplied.length > 128 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(supplied)) return invalid('INVALID_FORM_VALUE'); const value = Number(supplied);
    if (!Number.isFinite(value) || value < (field.minimum ?? -Number.MAX_SAFE_INTEGER) || value > (field.maximum ?? Number.MAX_SAFE_INTEGER)
      || (field.kind === 'integer' && !Number.isSafeInteger(value))) return invalid('INVALID_FORM_VALUE'); result[field.name] = value;
  }
  const submission = Object.freeze({ id: request.id, digest: request.digest, value: Object.freeze(result) }); submissions.add(submission); return submission;
}

function commandState(state: HumanResponseCommandState): HumanResponseCommandState { return Object.freeze({ ...state }); }
function safeCommandError(error: unknown): ClientError {
  const allowed = new Set(['ABORTED', 'TRANSPORT_FAILED', 'REDIRECT_DENIED', 'HTTP_ERROR', 'INVALID_RESPONSE', 'INVALID_JSON', 'RESPONSE_LIMIT', 'INVALID_REQUEST',
    'FORM_SUBMISSION_CONFLICT']);
  return error instanceof ClientError && allowed.has(error.code) ? error : new ClientError('FORM_SUBMISSION_FAILED');
}

/** Explicit single-flight response command state. It never retries, refreshes or sends work until submit is called. */
export function createHumanResponseController(options: HumanResponseControllerOptions): HumanResponseController {
  if (!options || !options.client || typeof options.client.respondHumanRequest !== 'function' || !validRequest(options.request) || options.request.status !== 'waiting')
    throw new ClientError('INVALID_FORM_CONTROLLER');
  const maxSubscribers = options.maxSubscribers ?? 64;
  if (!Number.isSafeInteger(maxSubscribers) || maxSubscribers < 1 || maxSubscribers > 256) throw new ClientError('INVALID_FORM_CONTROLLER');
  const client = options.client; const request = options.request; const listeners = new Set<() => void>(); let active: AbortController | null = null; let disposed = false;
  let state = commandState({ revision: 0, status: 'idle', requestId: request.id, requestDigest: request.digest, responseStatus: null, errorCode: null });
  const publish = (change: Omit<Partial<HumanResponseCommandState>, 'revision' | 'requestId' | 'requestDigest'>): HumanResponseCommandState => {
    state = commandState({ ...state, ...change, revision: state.revision + 1 });
    for (const listener of [...listeners]) { try { listener(); } catch { /* Presentation listeners cannot break command accounting. */ } }
    return state;
  };
  return Object.freeze<HumanResponseController>({
    getSnapshot: () => state,
    subscribe: listener => {
      if (disposed) throw new ClientError('FORM_DISPOSED');
      if (typeof listener !== 'function') throw new ClientError('INVALID_FORM_CONTROLLER');
      if (listeners.size >= maxSubscribers) throw new ClientError('FORM_SUBSCRIBER_LIMIT');
      listeners.add(listener); let subscribed = true;
      return () => { if (subscribed) { subscribed = false; listeners.delete(listener); } };
    },
    submit: async (submission, settings) => {
      if (disposed) throw new ClientError('FORM_DISPOSED');
      if (active) throw new ClientError('FORM_BUSY');
      if (!submissions.has(submission) || submission.id !== request.id || submission.digest !== request.digest || !settings
        || typeof settings.commandId !== 'string' || !idPattern.test(settings.commandId)) throw new ClientError('INVALID_FORM_SUBMISSION');
      const controller = new AbortController(); const abort = (): void => controller.abort(); active = controller;
      settings.signal?.addEventListener('abort', abort, { once: true }); if (settings.signal?.aborted) abort();
      publish({ status: 'submitting', responseStatus: null, errorCode: null });
      try {
        if (controller.signal.aborted) throw new ClientError('ABORTED');
        const response = await client.respondHumanRequest(request.id, request.digest, submission.value, { commandId: settings.commandId, signal: controller.signal });
        if (disposed || controller.signal.aborted) throw new ClientError('ABORTED');
        if (!validRequest(response) || response.id !== request.id || response.agentId !== request.agentId || response.kind !== request.kind
          || response.schemaId !== request.schemaId || response.schemaDigest !== request.schemaDigest || response.digest !== request.digest || response.status === 'waiting')
          throw new ClientError('INVALID_RESPONSE');
        if (response.status !== 'answered') {
          publish({ status: 'conflict', responseStatus: response.status, errorCode: 'FORM_SUBMISSION_CONFLICT' });
          throw new ClientError('FORM_SUBMISSION_CONFLICT');
        }
        publish({ status: 'succeeded', responseStatus: 'answered', errorCode: null }); return response;
      } catch (error) {
        const safe = safeCommandError(error);
        if (!disposed && state.status !== 'conflict') {
          const conflict = safe.code === 'HTTP_ERROR' && (safe.status === 409 || safe.status === 412);
          publish({ status: conflict ? 'conflict' : 'failed', responseStatus: null, errorCode: conflict ? 'FORM_SUBMISSION_CONFLICT' : safe.code });
        }
        throw safe;
      } finally { settings.signal?.removeEventListener('abort', abort); if (active === controller) active = null; }
    },
    reset: () => {
      if (disposed) throw new ClientError('FORM_DISPOSED'); if (active) throw new ClientError('FORM_BUSY');
      return publish({ status: 'idle', responseStatus: null, errorCode: null });
    },
    dispose: () => {
      if (disposed) return; disposed = true; active?.abort(); publish({ status: 'disposed', responseStatus: null, errorCode: null }); listeners.clear();
    },
  });
}
