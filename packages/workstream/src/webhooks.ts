import { assertSchema, freezeJson, jsonValue, MayuraError, validate,
  type InferInput, type JsonObject, type JsonValue, type Schema, type Scope } from '@mayura/core';
import { StorageError, type AggregateStore, type StoredEvent, type StoredRecord } from '@mayura/storage-contracts';

export interface WebhookDispatchContext { readonly deliveryId: string; readonly commandId: string; readonly signal: AbortSignal }
export interface WebhookTriggerOptions<I extends Schema> {
  readonly id: string; readonly version: string; readonly secretId: string;
  readonly schemaId: string; readonly schemaDigest: string; readonly input: I;
  readonly dispatch: (input: InferInput<I>, context: WebhookDispatchContext) => JsonValue | Promise<JsonValue>;
}
declare const webhookBrand: unique symbol;
export interface WebhookTriggerDefinition<I extends Schema = Schema> {
  readonly [webhookBrand]: true; readonly id: string; readonly version: string; readonly secretId: string;
  readonly schemaId: string; readonly schemaDigest: string;
  readonly input: Schema<InferInput<I>>;
}
export type AnyWebhookTrigger = WebhookTriggerDefinition;
export type WebhookDeliveryStatus = 'admitted' | 'dispatching' | 'succeeded' | 'outcome_unknown';
export interface WebhookDeliverySnapshot { readonly id: string; readonly version: number; readonly triggerId: string;
  readonly deliveryId: string; readonly status: WebhookDeliveryStatus; readonly output: JsonValue }
export interface WebhookRequest { readonly deliveryId: string; readonly timestampMs: number; readonly body: Uint8Array; readonly signature: string }
export interface WebhookRuntimeOptions {
  readonly store: AggregateStore; readonly scope: Scope;
  readonly resolveSecret: (request: { readonly triggerId: string; readonly secretId: string; readonly signal: AbortSignal }) => Promise<Uint8Array>;
  readonly now?: () => number; readonly maxClockSkewMs?: number; readonly maxBodyBytes?: number;
  readonly callbackTimeoutMs?: number; readonly maxPendingCallbacks?: number;
}
export interface WebhookRuntime {
  receive<I extends Schema>(definition: WebhookTriggerDefinition<I>, request: WebhookRequest): Promise<WebhookDeliverySnapshot>;
  inspect(id: string): Promise<WebhookDeliverySnapshot>;
  recoverAbandoned(id: string): Promise<WebhookDeliverySnapshot>;
  events(id: string, after?: number): Promise<readonly StoredEvent[]>;
  close(): void;
}

interface State { format: 1; definition: string; triggerId: string; deliveryId: string; requestDigest: string;
  status: WebhookDeliveryStatus; output: JsonValue }
const ids = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/; const versions = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/; const hashes = /^[a-f0-9]{64}$/;
const definitions = new WeakMap<object, { readonly dispatch: WebhookTriggerOptions<Schema>['dispatch'] }>();
const encoder = new TextEncoder();
function canonical(value: JsonValue): string { if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`; }
function shared(bytes: Uint8Array): boolean { return typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer; }
async function sha(bytes: Uint8Array): Promise<string> { try { const owned = Uint8Array.from(bytes); const digest = await crypto.subtle.digest('SHA-256', owned.buffer);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Webhook cryptography is unavailable.'); } }
async function textHash(domain: string, value: JsonValue): Promise<string> { return sha(encoder.encode(`${domain}\0${canonical(value)}`)); }
function stable(value: unknown, maximum: number): JsonValue { return freezeJson(jsonValue(value, { maxBytes: maximum })); }
function state(record: StoredRecord): State { try { const value = stable(record.state, 2_097_152) as JsonObject;
    if (Object.keys(value).length !== 7 || value['format'] !== 1 || typeof value['definition'] !== 'string' || !hashes.test(value['definition'])
      || typeof value['triggerId'] !== 'string' || !ids.test(value['triggerId']) || typeof value['deliveryId'] !== 'string' || !ids.test(value['deliveryId'])
      || typeof value['requestDigest'] !== 'string' || !hashes.test(value['requestDigest']) || !['admitted', 'dispatching', 'succeeded', 'outcome_unknown'].includes(String(value['status']))
      || (value['status'] !== 'succeeded' && value['output'] !== null) || !hashes.test(record.id) || !hashes.test(record.scope)
      || record.idempotencyKey !== `webhook:${record.id}` || record.definitionHash !== value['definition']
      || !Number.isSafeInteger(record.version) || record.version < 1) throw new Error(); return value as unknown as State;
  } catch { throw new MayuraError('INTEGRITY_VIOLATION', 'Stored webhook delivery failed integrity validation.'); } }
function snapshot(record: StoredRecord): WebhookDeliverySnapshot { const value = state(record);
  return stable({ id: record.id, version: record.version, triggerId: value.triggerId, deliveryId: value.deliveryId,
    status: value.status, output: value.output }, 2_097_152) as unknown as WebhookDeliverySnapshot; }
function eventPage(value: unknown, after: number): readonly StoredEvent[] { try { const page = stable(value, 1_048_576);
    if (!Array.isArray(page) || page.length > 1_000) throw new Error(); let previous = after;
    for (const item of page) { if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 4
        || typeof item['sequence'] !== 'number' || !Number.isSafeInteger(item['sequence']) || item['sequence'] <= previous
        || !['webhook.admitted', 'webhook.dispatching', 'webhook.succeeded', 'webhook.outcome_unknown'].includes(String(item['type']))
        || typeof item['createdAt'] !== 'string' || item['createdAt'].length < 20 || item['createdAt'].length > 64
        || !item['data'] || typeof item['data'] !== 'object' || Array.isArray(item['data']) || Object.keys(item['data']).length !== 0) throw new Error();
      previous = item['sequence']; }
    return page as unknown as readonly StoredEvent[];
  } catch { throw new MayuraError('INTEGRITY_VIOLATION', 'Stored webhook events failed integrity validation.'); } }
function assertDefinition(definition: AnyWebhookTrigger): WebhookTriggerOptions<Schema>['dispatch'] { const known = definitions.get(definition);
  if (!known) throw new MayuraError('INVALID_CONFIG', 'Use defineWebhookTrigger from this package instance.'); return known.dispatch; }

/** Define a trusted webhook route. Secrets and dispatch callbacks are never persisted. */
export function defineWebhookTrigger<I extends Schema>(options: WebhookTriggerOptions<I>): WebhookTriggerDefinition<I> {
  if (!options || !ids.test(options.id) || typeof options.version !== 'string' || !versions.test(options.version)
    || !ids.test(options.secretId) || !ids.test(options.schemaId) || !hashes.test(options.schemaDigest)
    || typeof options.dispatch !== 'function') throw new MayuraError('INVALID_CONFIG', 'Webhook trigger identity is invalid.');
  assertSchema(options.input); const standard = options.input['~standard'];
  const definition = Object.freeze({ id: options.id, version: options.version, secretId: options.secretId,
    schemaId: options.schemaId, schemaDigest: options.schemaDigest,
    input: Object.freeze({ '~standard': Object.freeze({ version: 1 as const, vendor: standard.vendor, validate: standard.validate.bind(standard) }) }) }) as WebhookTriggerDefinition<I>;
  definitions.set(definition, { dispatch: options.dispatch as WebhookTriggerOptions<Schema>['dispatch'] }); return definition;
}

/** Authenticated, replay-deduplicated webhook ingress over the generic aggregate store. */
export function createWebhookRuntime(options: WebhookRuntimeOptions): WebhookRuntime {
  if (!options || !ids.test(options.scope?.principalId) || !ids.test(options.scope?.projectId) || typeof options.resolveSecret !== 'function') throw new MayuraError('INVALID_CONFIG', 'Webhook scope and secret resolver are required.');
  const maxSkew = options.maxClockSkewMs ?? 300_000; const maxBody = options.maxBodyBytes ?? 1_048_576;
  const timeout = options.callbackTimeoutMs ?? 30_000; const maxPending = options.maxPendingCallbacks ?? 32;
  if (![maxSkew, maxBody, timeout, maxPending].every(Number.isSafeInteger) || maxSkew < 1 || maxSkew > 3_600_000 || maxBody < 1 || maxBody > 1_048_576
    || timeout < 1 || timeout > 300_000 || maxPending < 1 || maxPending > 128) throw new MayuraError('INVALID_CONFIG', 'Webhook runtime limits are invalid.');
  const store = options.store; const clock = options.now ?? Date.now; let closed = false; let pending = 0;
  const scopePromise = textHash('mayura:webhook-scope:v1', options.scope as unknown as JsonValue);
  const active = new Map<string, { readonly digest: string; readonly promise: Promise<WebhookDeliverySnapshot> }>();
  const open = (): void => { if (closed) throw new MayuraError('CANCELLED', 'Webhook runtime is closed.'); };
  const controlled = async <T>(callback: (signal: AbortSignal) => Promise<T>): Promise<T> => { if (pending >= maxPending) throw new MayuraError('LIMIT_EXCEEDED', 'Webhook callback capacity is full.');
    pending += 1; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; let released = false;
    const release = (): void => { if (!released) { released = true; pending -= 1; } }; const operation = Promise.resolve().then(() => callback(controller.signal)); void operation.then(release, release);
    try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new MayuraError('TIMEOUT', 'Webhook callback timed out.')); }, timeout); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); } };
  const storage = async <T>(operation: () => Promise<T>): Promise<T> => { try { return await operation(); }
    catch (error) { if (error instanceof StorageError && error.code === 'CONFLICT') throw error;
      throw new MayuraError('STORAGE_UNAVAILABLE', 'Webhook storage is unavailable; retry the stable delivery identity.'); } };
  const load = async (id: string) => { open(); if (!hashes.test(id)) throw new MayuraError('INVALID_INPUT', 'Webhook delivery ID is invalid.'); const scope = await scopePromise;
    const record = await storage(() => store.read(scope, id)); if (!record) throw new MayuraError('NOT_FOUND', 'Webhook delivery was not found.');
    if (record.id !== id || record.scope !== scope) throw new MayuraError('INTEGRITY_VIOLATION', 'Stored webhook delivery failed integrity validation.'); state(record); return record; };
  const save = (record: StoredRecord, value: State, type: string) => storage(async () => store.update({ scope: record.scope, id: record.id,
    expectedVersion: record.version, state: stable(value, maxBody + 4096) as JsonObject, events: [{ type, data: {} }] }));
  const verify = async (definition: AnyWebhookTrigger, request: WebhookRequest): Promise<{ definitionHash: string; requestDigest: string; input: JsonValue }> => {
    if (!ids.test(request.deliveryId) || !Number.isSafeInteger(request.timestampMs) || request.timestampMs < 0 || !(request.body instanceof Uint8Array)
      || shared(request.body) || request.body.byteLength > maxBody || !/^sha256=[a-f0-9]{64}$/.test(request.signature)) throw new MayuraError('INVALID_INPUT', 'Webhook request is malformed.');
    let observed: unknown; try { observed = clock(); } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Webhook clock is unavailable.'); }
    if (typeof observed !== 'number' || !Number.isSafeInteger(observed) || observed < 0) throw new MayuraError('STORAGE_UNAVAILABLE', 'Webhook clock is invalid.');
    if (Math.abs(observed - request.timestampMs) > maxSkew) throw new MayuraError('PERMISSION_DENIED', 'Webhook timestamp is outside the replay window.');
    const body = new Uint8Array(request.body); const prefix = encoder.encode(`${request.timestampMs}.${request.deliveryId}.`); const signed = new Uint8Array(prefix.length + body.length); signed.set(prefix); signed.set(body, prefix.length);
    let secret: Uint8Array;
    try { secret = await controlled(signal => options.resolveSecret({ triggerId: definition.id, secretId: definition.secretId, signal })); }
    catch (error) { if (error instanceof MayuraError) throw error; throw new MayuraError('PERMISSION_DENIED', 'Webhook secret resolution failed.'); }
    if (!(secret instanceof Uint8Array) || shared(secret) || secret.byteLength < 16 || secret.byteLength > 4096) throw new MayuraError('PERMISSION_DENIED', 'Webhook secret resolution failed.');
    const secretCopy = new Uint8Array(secret); let expected: Uint8Array;
    try { const key = await crypto.subtle.importKey('raw', secretCopy, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed)); }
    catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Webhook cryptography is unavailable.'); }
    finally { secretCopy.fill(0); }
    const supplied = Uint8Array.from(request.signature.slice(7).match(/../g)!, part => Number.parseInt(part, 16)); let mismatch = supplied.length ^ expected.length;
    for (let index = 0; index < Math.max(supplied.length, expected.length); index++) mismatch |= (supplied[index] ?? 0) ^ (expected[index] ?? 0);
    if (mismatch !== 0) throw new MayuraError('PERMISSION_DENIED', 'Webhook signature is invalid.');
    let parsed: unknown; try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { throw new MayuraError('INVALID_INPUT', 'Webhook body must be UTF-8 JSON.'); }
    const input = stable(await controlled(() => validate(definition.input, parsed, 'input', { maxBytes: maxBody })), maxBody);
    const definitionHash = await textHash('mayura:webhook-definition:v1', { id: definition.id, version: definition.version, secretId: definition.secretId,
      schemaId: definition.schemaId, schemaDigest: definition.schemaDigest });
    const requestDigest = await textHash('mayura:webhook-request:v1', { definitionHash, deliveryId: request.deliveryId, bodyDigest: await sha(body) });
    return { definitionHash, requestDigest, input };
  };
  const receive = async <I extends Schema>(definition: WebhookTriggerDefinition<I>, request: WebhookRequest): Promise<WebhookDeliverySnapshot> => {
    open(); const dispatch = assertDefinition(definition); const admitted = await verify(definition, request); const scope = await scopePromise;
    const id = await textHash('mayura:webhook-delivery:v1', { scope, triggerId: definition.id, deliveryId: request.deliveryId });
    const existingActive = active.get(id); if (existingActive) {
      if (existingActive.digest !== admitted.requestDigest) throw new MayuraError('CONFLICT', 'Webhook delivery identity was reused with different content.');
      return existingActive.promise;
    }
    const operation = (async () => { const initial: State = { format: 1, definition: admitted.definitionHash, triggerId: definition.id,
      deliveryId: request.deliveryId, requestDigest: admitted.requestDigest, status: 'admitted', output: null };
      const created = await storage(() => store.create({ scope, id, idempotencyKey: `webhook:${id}`,
        definitionHash: admitted.definitionHash, state: stable(initial, maxBody + 4096) as JsonObject, events: [{ type: 'webhook.admitted', data: {} }] }));
      let record = created.record; const current = state(record);
      if (record.id !== id || record.scope !== scope || record.definitionHash !== admitted.definitionHash || current.requestDigest !== admitted.requestDigest
        || current.triggerId !== definition.id || current.deliveryId !== request.deliveryId) throw new MayuraError('CONFLICT', 'Webhook delivery identity was reused with different content.');
      if (current.status === 'succeeded' || current.status === 'outcome_unknown') return snapshot(record);
      if (current.status === 'dispatching' && !created.created) return snapshot(record);
      record = await save(record, { ...current, status: 'dispatching' }, 'webhook.dispatching');
      const finish = async (status: 'succeeded' | 'outcome_unknown', output: JsonValue): Promise<StoredRecord> => {
        const terminal: State = { ...state(record), status, output };
        try { return await save(record, terminal, `webhook.${status}`); }
        catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error;
          const latest = await storage(() => store.read(scope, id)); if (!latest || latest.id !== id || latest.scope !== scope) throw error;
          const latestState = state(latest); if (latestState.status === 'succeeded' || latestState.status === 'outcome_unknown') return latest; throw error; }
      };
      let output: JsonValue;
      try { output = stable(await controlled(signal => Promise.resolve(dispatch(admitted.input as InferInput<I>, { deliveryId: request.deliveryId, commandId: id, signal }))), maxBody); }
      catch { record = await finish('outcome_unknown', null); return snapshot(record); }
      record = await finish('succeeded', output);
      return snapshot(record); })();
    const activeDelivery = { digest: admitted.requestDigest, promise: operation }; active.set(id, activeDelivery);
    try { return await operation; } finally { if (active.get(id) === activeDelivery) active.delete(id); }
  };
  return Object.freeze<WebhookRuntime>({ receive,
    inspect: async (id: string) => snapshot(await load(id)),
    recoverAbandoned: async (id: string) => { let record = await load(id); const current = state(record); if (current.status !== 'dispatching') return snapshot(record);
      try { record = await save(record, { ...current, status: 'outcome_unknown', output: null }, 'webhook.outcome_unknown'); }
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; record = await load(id);
        const observed = state(record); if (observed.status !== 'succeeded' && observed.status !== 'outcome_unknown') throw error; }
      return snapshot(record); },
    events: (id: string, after = 0) => { open(); if (!hashes.test(id) || !Number.isSafeInteger(after) || after < 0) return Promise.reject(new MayuraError('INVALID_INPUT', 'Webhook event query is invalid.'));
      return scopePromise.then(async scope => eventPage(await storage(() => store.events(scope, id, after)), after)); },
    close: () => { closed = true; },
  });
}
