import { freezeJson, jsonValue, MayuraError, type Authorizer, type JsonObject, type JsonValue, type Permissions, type Scope } from '@mayura/core';
import { sha256Hex } from '@mayura/core/host';
import { runCheckpointCommand, runCheckpointResult, type RunCheckpoint, type RunCheckpointReconcile, type RunCheckpointStore } from '@mayura/storage-contracts';
import type { RunRecordView } from './index.js';

export interface ApprovalReconciliationOptions {
  /** Optional host-owned core policy. A server's configured instance takes precedence and must match if both are supplied. */
  readonly authorization?: Authorizer;
  /** Separate trusted service authority; never accepted from a browser token. */
  readonly permissions: Permissions;
  readonly authorize: (work: { readonly scope: Scope; readonly agentId: string; readonly actorId: string;
    readonly operation: 'inspect' | 'close'; readonly signal: AbortSignal }) => Promise<boolean>;
}
export interface ClaimedApprovalRequest {
  readonly scope: Scope; readonly actorId: string; readonly runId: string; readonly signal?: AbortSignal;
}
export interface ReconcileClaimedApprovalRequest extends ClaimedApprovalRequest {
  readonly reviewDigest: string; readonly commandId: string;
  readonly effect: 'not_started' | 'succeeded' | 'failed' | 'unknown';
  /** Identifier of an external investigation/receipt. Do not supply credentials or raw tool output. */
  readonly evidenceRef: string;
  /** Operator attestation that the previous worker and any in-flight external operation have been stopped/fenced. */
  readonly workerStopped: true;
}
export interface ClaimedApprovalView {
  readonly runId: string; readonly agentId: string; readonly checkpointVersion: number;
  readonly holderId: string; readonly leaseExpiresAtMs: number; readonly runLeaseExpiresAtMs: number;
  readonly pending: { readonly callId: string; readonly toolId: string; readonly toolVersion: string; readonly digest: string };
  readonly reviewDigest: string; readonly eligible: boolean;
  readonly blockers: readonly ('checkpoint_live' | 'run_live' | 'run_terminal' | 'recording_pending' | 'already_reconciled')[];
  readonly receipt?: JsonObject;
}
export interface ApprovalReconciliationResult { readonly status: 'closed'; readonly runId: string; readonly receipt: JsonObject }

const identifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const id = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const digest = /^[a-f0-9]{64}$/u;
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}
function object(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fail(code: 'INVALID_INPUT' | 'CONFLICT' | 'NOT_FOUND' | 'PERMISSION_DENIED' | 'CANCELLED' | 'STORAGE_UNAVAILABLE', message: string): never {
  throw new MayuraError(code, message);
}
/** Storage/policy exceptions are untrusted, including MayuraError messages. Expose stable codes and fixed text only. */
function safeFailure(error: unknown): MayuraError {
  const messages = {
    INVALID_INPUT: 'Invalid scoped approval reconciliation command.',
    CONFLICT: 'The claimed approval changed, has a live owner, or has a different reconciliation. Inspect it again.',
    NOT_FOUND: 'No claimed approval in this scope.',
    PERMISSION_DENIED: 'Approval reconciliation is not authorized.',
    CANCELLED: 'Approval reconciliation stopped.',
    LIMIT_EXCEEDED: 'The reconciliation operation exceeds its limit.',
    STORAGE_UNAVAILABLE: 'Approval reconciliation storage is unavailable.',
  } as const;
  const code = error instanceof MayuraError && Object.hasOwn(messages, error.code) ? error.code as keyof typeof messages : 'STORAGE_UNAVAILABLE';
  return new MayuraError(code, messages[code]);
}
/** Host-only terminal controls: no runtime submission, approval, resume or tool execution path exists here. */
export function createApprovalReconciliation(options: ApprovalReconciliationOptions | undefined, hooks: {
  readonly store?: RunCheckpointStore;
  readonly authorization?: Authorizer;
  readonly read: (scope: Scope, runId: string, signal: AbortSignal) => Promise<RunRecordView | null>;
  readonly abandon: (scope: Scope, runId: string, signal: AbortSignal) => Promise<RunRecordView | null>;
  readonly agentExists: (id: string) => boolean;
  readonly hasRecording: (scope: Scope, checkpoint: RunCheckpoint) => Promise<boolean>;
  readonly record: (scope: Scope, checkpoint: RunCheckpoint, receipt: JsonObject) => Promise<void>;
  readonly timeoutMs: number; readonly maxOperations: number;
}) {
  if (options !== undefined && (!options || !Array.isArray(options.permissions?.allow)
    || !options.permissions.allow.includes('conversations:reconcile') || options.permissions.allow.some(grant => grant !== 'conversations:reconcile')
    || typeof options.authorize !== 'function' || typeof hooks.store?.reconcile !== 'function'))
    throw new MayuraError('INVALID_CONFIG', 'Approval reconciliation requires its service grant, authorization policy and checkpoint fencing support.');
  if (hooks.authorization && options?.authorization && hooks.authorization !== options.authorization) throw new MayuraError('INVALID_CONFIG', 'Approval reconciliation must use the server authorizer.');
  const authorization = hooks.authorization ?? options?.authorization;
  let evaluate: Authorizer['authorize'] | undefined;
  try {
    if (authorization !== undefined) {
      if (!authorization || typeof authorization.authorize !== 'function') throw new Error();
      evaluate = authorization.authorize.bind(authorization);
    }
  } catch { throw new MayuraError('INVALID_CONFIG', 'Approval reconciliation requires a core authorizer.'); }
  const core = async (scope: Scope, runId: string, operation: 'inspect' | 'close', signal: AbortSignal, threadId?: string): Promise<void> => {
    if (!evaluate) return;
    const checks = [{ kind: 'run' as const, id: runId, action: operation === 'inspect' ? 'inspect_approval' : 'reconcile_approval' },
      ...(threadId === undefined ? [] : [{ kind: 'thread' as const, id: threadId, action: operation === 'inspect' ? 'inspect_approval' : 'reconcile_approval' }])];
    for (const resource of checks) {
      let allowed = false;
      try { allowed = (await evaluate(scope, resource.action, { kind: resource.kind, id: resource.id, scope, ownerId: scope.principalId }, { signal })).effect === 'allow'; } catch { /* No policy diagnostics. */ }
      if (!allowed || signal.aborted) fail('PERMISSION_DENIED', 'Approval reconciliation is not authorized.');
    }
  };
  const authorize = options?.authorize; const stop = new AbortController(); const tasks = new Set<Promise<unknown>>();
  const check = (signal: AbortSignal): void => { if (signal.aborted || stop.signal.aborted) fail('CANCELLED', 'Approval reconciliation stopped.'); };
  /** Own bounded command data before awaiting policy/storage; the signal stays separate from persisted JSON. */
  const capture = (request: ClaimedApprovalRequest, close: boolean): JsonObject => {
    try {
      if (!request || typeof request !== 'object') throw new Error();
      const data: Record<string, unknown> = {};
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(request))) {
        if (!('value' in descriptor)) throw new Error();
        if (key !== 'signal') data[key] = descriptor.value;
      }
      const raw = jsonValue(data, { maxBytes: 4096 });
      const fields = ['scope', 'actorId', 'runId', ...(close ? ['reviewDigest', 'commandId', 'effect', 'evidenceRef', 'workerStopped'] : [])];
      if (!object(raw) || Object.keys(raw).length !== fields.length || fields.some(key => !Object.hasOwn(raw, key))
        || !object(raw['scope']) || Object.keys(raw['scope']).sort().join(',') !== 'principalId,projectId'
        || ![raw['scope']['principalId'], raw['scope']['projectId'], raw['actorId']].every(value => typeof value === 'string' && identifier.test(value))
        || typeof raw['runId'] !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(raw['runId'])) throw new Error();
      if (close && (typeof raw['reviewDigest'] !== 'string' || !digest.test(raw['reviewDigest'])
        || ![raw['commandId'], raw['evidenceRef']].every(value => typeof value === 'string' && id.test(value))
        || !['not_started', 'succeeded', 'failed', 'unknown'].includes(raw['effect'] as string) || raw['workerStopped'] !== true)) throw new Error();
      return freezeJson(raw);
    } catch { return fail('INVALID_INPUT', 'Invalid scoped approval reconciliation command.'); }
  };
  const load = async (raw: JsonObject, signal: AbortSignal, operation?: 'inspect' | 'close') => {
    const capturedScope = raw['scope'] as unknown as Scope;
    const scope: Scope = Object.freeze({ principalId: capturedScope.principalId, projectId: capturedScope.projectId }); const runId = raw['runId'] as string;
    check(signal); if (operation) await core(scope, runId, operation, signal);
    const checkpoint = await hooks.store!.get({ runId }); check(signal);
    const expectedScope = sha256Hex(`mayura:run-scope:v1\0${scope.principalId}\0${scope.projectId}`);
    if (!checkpoint || checkpoint.scope !== expectedScope || canonical(checkpoint.body['scope'] ?? null) !== canonical(raw['scope']!))
      return fail('NOT_FOUND', 'No claimed approval in this scope.');
    const binding = checkpoint.body['recording']; let threadId: string | undefined;
    if (binding !== undefined) {
      if (!object(binding) || typeof binding['threadId'] !== 'string' || !id.test(binding['threadId'])) return fail('STORAGE_UNAVAILABLE', 'Invalid thread association.');
      threadId = binding['threadId'];
    }
    if (operation) await core(scope, runId, operation, signal, threadId);
    const agent = checkpoint.body['agent']; const pending = checkpoint.body['pending'];
    if (!object(agent) || typeof agent['id'] !== 'string' || !hooks.agentExists(agent['id'])) return fail('NOT_FOUND', 'No claimed approval in this scope.');
    if (operation && await authorize!(Object.freeze({ scope, agentId: agent['id'], actorId: raw['actorId'] as string, operation, signal })) !== true)
      return fail('PERMISSION_DENIED', 'Approval reconciliation is not authorized.');
    check(signal);
    if (checkpoint.status !== 'claimed' || !checkpoint.holderId || !Number.isSafeInteger(checkpoint.leaseExpiresAtMs) || !object(pending)
      || !['callId', 'toolId', 'toolVersion', 'digest'].every(key => typeof pending[key] === 'string') || !digest.test(pending['digest'] as string))
      return fail('CONFLICT', 'The run has no reconcilable claimed approval.');
    const record = await hooks.read(scope, runId, signal); check(signal);
    if (!record || record.agentId !== agent['id']) return fail('NOT_FOUND', 'No claimed approval in this scope.');
    const sealed = checkpoint.body['reconciliation']; let receipt: JsonObject | undefined;
    if (sealed !== undefined) {
      if (!object(sealed) || sealed['format'] !== 1 || !Number.isSafeInteger(sealed['reconciledAtMs'])) return fail('STORAGE_UNAVAILABLE', 'Invalid reconciliation receipt.');
      try {
        runCheckpointCommand('reconcile', { runId, scope: checkpoint.scope, ...Object.fromEntries(['expectedVersion', 'expectedHolderId', 'commandId', 'actorId', 'reviewDigest', 'effect', 'evidenceRef', 'workerStopped'].map(key => [key, sealed[key]])) });
      } catch { return fail('STORAGE_UNAVAILABLE', 'Invalid reconciliation receipt.'); }
      if (checkpoint.version !== (sealed['expectedVersion'] as number) + 1
        || checkpoint.holderId !== `reconcile:${sha256Hex(`${checkpoint.scope}\0${runId}\0${sealed['commandId']}`)}`) return fail('STORAGE_UNAVAILABLE', 'Invalid reconciliation fence.');
      receipt = freezeJson(jsonValue(sealed, { maxBytes: 4096 })) as JsonObject;
    }
    const reviewDigest = sha256Hex(`mayura:claimed-approval-review:v1\0${canonical({ checkpoint: checkpoint as unknown as JsonValue, record: record as unknown as JsonValue })}`);
    const blockers: ClaimedApprovalView['blockers'][number][] = [];
    if (receipt) blockers.push('already_reconciled');
    if (checkpoint.leaseExpiresAtMs! >= Date.now()) blockers.push('checkpoint_live');
    if (record.leaseExpiresAtMs >= Date.now() && ['running', 'waiting'].includes(record.status)) blockers.push('run_live');
    if (!['running', 'waiting', 'outcome_unknown'].includes(record.status)) blockers.push('run_terminal');
    if (!receipt && await hooks.hasRecording(scope, checkpoint)) blockers.push('recording_pending');
    check(signal);
    const view: ClaimedApprovalView = Object.freeze({ runId, agentId: record.agentId, checkpointVersion: checkpoint.version, holderId: checkpoint.holderId,
      leaseExpiresAtMs: checkpoint.leaseExpiresAtMs!, runLeaseExpiresAtMs: record.leaseExpiresAtMs,
      pending: Object.freeze({ callId: pending['callId'] as string, toolId: pending['toolId'] as string, toolVersion: pending['toolVersion'] as string, digest: pending['digest'] as string }),
      reviewDigest, eligible: blockers.length === 0, blockers: Object.freeze(blockers), ...(receipt ? { receipt } : {}) });
    return { scope, checkpoint, record, view, receipt, threadId };
  };
  const perform = async (request: ClaimedApprovalRequest, close: boolean): Promise<ClaimedApprovalView | ApprovalReconciliationResult> => {
    if (!authorize) return fail('PERMISSION_DENIED', 'Approval reconciliation is not enabled.');
    const raw = capture(request, close); const suppliedSignal = request.signal;
    if (suppliedSignal !== undefined && !(suppliedSignal instanceof AbortSignal)) return fail('INVALID_INPUT', 'A reconciliation signal must be an AbortSignal.');
    if (suppliedSignal?.aborted || stop.signal.aborted) return fail('CANCELLED', 'Approval reconciliation stopped.');
    if (tasks.size >= hooks.maxOperations) throw new MayuraError('LIMIT_EXCEEDED', 'Too many reconciliation operations.');
    const control = new AbortController(); const abort = (): void => control.abort();
    suppliedSignal?.addEventListener('abort', abort, { once: true }); stop.signal.addEventListener('abort', abort, { once: true });
    const operation = async () => {
      let current = await load(raw, control.signal, close ? 'close' : 'inspect');
      check(control.signal); if (!close) { await core(current.scope, raw['runId'] as string, 'inspect', control.signal, current.threadId); return current.view; }
      // Authorization may take time; bind the actual mutation to fresh state and the operator's reviewed digest.
      const authorizedAgent = current.record.agentId;
      current = await load(raw, control.signal);
      if (current.record.agentId !== authorizedAgent) return fail('CONFLICT', 'The approval owner changed during authorization.');
      await core(current.scope, raw['runId'] as string, 'close', control.signal, current.threadId);
      if (await authorize!(Object.freeze({ scope: current.scope, agentId: current.record.agentId, actorId: raw['actorId'] as string, operation: 'close', signal: control.signal })) !== true) return fail('PERMISSION_DENIED', 'Approval reconciliation is not authorized.');
      await core(current.scope, raw['runId'] as string, 'close', control.signal, current.threadId);
      check(control.signal);
      let sealed = current.checkpoint;
      if (current.receipt) {
        if (['commandId', 'actorId', 'reviewDigest', 'effect', 'evidenceRef', 'workerStopped'].some(key => current.receipt![key] !== raw[key]))
          return fail('CONFLICT', 'The approval already has a different reconciliation command.');
      } else {
        if (!current.view.eligible || current.view.reviewDigest !== raw['reviewDigest']) return fail('CONFLICT', 'The claimed approval changed or still has a live owner. Inspect it again.');
        const command = runCheckpointCommand('reconcile', { runId: raw['runId'], scope: current.checkpoint.scope,
          expectedVersion: current.checkpoint.version, expectedHolderId: current.checkpoint.holderId,
          ...Object.fromEntries(['commandId', 'actorId', 'reviewDigest', 'effect', 'evidenceRef', 'workerStopped'].map(key => [key, raw[key]])) });
        check(control.signal);
        sealed = runCheckpointResult('reconcile', await hooks.store!.reconcile(command as unknown as RunCheckpointReconcile), command); check(control.signal);
        const { reconciliation: _receipt, ...original } = sealed.body;
        if (canonical(original) !== canonical(current.checkpoint.body)) return fail('STORAGE_UNAVAILABLE', 'The checkpoint changed while storing its reconciliation.');
      }
      const receipt = sealed.body['reconciliation'];
      if (!object(receipt)) return fail('STORAGE_UNAVAILABLE', 'The reconciliation receipt was not stored.');
      // Abandon is a conditional terminal transition, never an owner transfer or a resume. Known outcomes win races.
      const terminal = await hooks.abandon(current.scope, raw['runId'] as string, control.signal); check(control.signal);
      if (!terminal || terminal.status !== 'outcome_unknown') return fail('CONFLICT', 'The run has a live owner or a recorded terminal outcome.');
      await hooks.record(current.scope, sealed, receipt); check(control.signal);
      await core(current.scope, raw['runId'] as string, 'close', control.signal, current.threadId);
      return Object.freeze({ status: 'closed' as const, runId: raw['runId'] as string, receipt });
    };
    const task = Promise.resolve().then(operation); tasks.add(task);
    const cleanup = (): void => { tasks.delete(task); suppliedSignal?.removeEventListener('abort', abort); stop.signal.removeEventListener('abort', abort); };
    void task.then(cleanup, cleanup);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        const cancelled = (): void => reject(new MayuraError('CANCELLED', 'Approval reconciliation stopped.'));
        control.signal.addEventListener('abort', cancelled, { once: true }); timer = setTimeout(abort, hooks.timeoutMs);
        void task.then(resolve, error => reject(safeFailure(error)))
          .finally(() => control.signal.removeEventListener('abort', cancelled));
      });
    } finally { clearTimeout(timer); }
  };
  return Object.freeze({
    inspect: (request: ClaimedApprovalRequest) => perform(request, false) as Promise<ClaimedApprovalView>,
    reconcile: (request: ReconcileClaimedApprovalRequest) => perform(request, true) as Promise<ApprovalReconciliationResult>,
    stop: () => stop.abort(), settled: async (): Promise<void> => { await Promise.allSettled([...tasks]); },
  });
}
