import type { Authorizer, Scope } from '@mayura/core';
import type { ClientJson } from '@mayura/client';
import { utf8ByteLength } from '@mayura/core/host';
import { AgUiFailure, boundedJson, fields, object, type AgUiEvent, type AgUiState, type AgUiStatePatchOperation } from './protocol.js';

/** Verified native identity and a fixed thread. No token, browser state or provisional model output is supplied. */
export interface AgUiStateContext {
  readonly scope: Scope; readonly agentId: string; readonly threadId: string; readonly runId: string; readonly signal: AbortSignal;
}
export interface AgUiStateVersion {
  /** Monotonically increasing safe integer for this scoped thread. Increment for every visible state change. */
  readonly revision: number;
  readonly state: AgUiState;
}
export interface AgUiStateSource {
  /** Read-only host boundary. Return only data this verified scope may disclose; honor signal and do not run tools. */
  read(context: AgUiStateContext): AgUiStateVersion | Promise<AgUiStateVersion>;
  /** Optional additional thread/read_state policy, with the existing core authorization audit contract. Host-owned. */
  readonly authorization?: Authorizer;
}
export interface StateLimits {
  readonly maxStateBytes: number; readonly maxStatePatchBytes: number; readonly maxStatePatchOperations: number;
  readonly maxStateReads: number; readonly maxConcurrentStateReads: number; readonly stateReadTimeoutMs: number;
}
export interface StateStream {
  initial(): AgUiEvent;
  refresh(): Promise<AgUiEvent | undefined>;
  authorize(): Promise<void>;
}
const isObject = (value: ClientJson): value is { readonly [key: string]: ClientJson } => value !== null && typeof value === 'object' && !Array.isArray(value);
/** JSON equality ignores object key order, while arrays retain their ordering and null remains a real state. */
function equal(left: ClientJson, right: ClientJson): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => equal(item, right[index]!));
  if (!isObject(left) || !isObject(right)) return false;
  const keys = Object.keys(left); return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key]!, right[key]!));
}
/** Generate an applicable patch from two copied snapshots. Exceeding any patch bound requests a full resync. */
function difference(previous: AgUiState, next: AgUiState, limits: StateLimits): readonly AgUiStatePatchOperation[] | undefined {
  if (limits.maxStatePatchBytes < 2) return undefined;
  const operations: AgUiStatePatchOperation[] = []; let bytes = 2; let overflow = false;
  const append = (operation: AgUiStatePatchOperation) => {
    bytes += utf8ByteLength(JSON.stringify(operation)) + (operations.length ? 1 : 0);
    if (bytes > limits.maxStatePatchBytes || operations.length >= limits.maxStatePatchOperations) { overflow = true; return; }
    operations.push(Object.freeze(operation));
  };
  const visit = (left: AgUiState, right: AgUiState, path: string): void => {
    if (overflow || equal(left, right)) return;
    if (isObject(left) && isObject(right)) {
      const pointer = (key: string) => `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      for (const key of Object.keys(left).sort()) {
        if (!Object.hasOwn(right, key)) append({ op: 'remove', path: pointer(key) });
        if (overflow) return;
      }
      for (const key of Object.keys(right).sort()) {
        if (!Object.hasOwn(left, key)) append({ op: 'add', path: pointer(key), value: right[key]! });
        else visit(left[key]!, right[key]!, pointer(key));
        if (overflow) return;
      }
    } else append({ op: 'replace', path, value: right });
  };
  visit(previous, next, ''); return overflow ? undefined : Object.freeze(operations);
}
function version(raw: unknown, limits: StateLimits): AgUiStateVersion {
  try {
    const value = object(boundedJson(raw, limits.maxStateBytes + 1024)); fields(value, ['revision', 'state']);
    if (!Number.isSafeInteger(value['revision']) || (value['revision'] as number) < 0) throw new Error();
    const state = boundedJson(value['state'], limits.maxStateBytes);
    return Object.freeze({ revision: value['revision'] as number, state });
  } catch { throw new AgUiFailure('INVALID_STATE', 503); }
}
/**
 * One adapter-wide pool, with a stream-local cursor. Timed-out callbacks continue occupying a slot until they
 * actually settle, so a provider that ignores cancellation cannot create unbounded orphaned reads.
 */
export function stateReader(source: AgUiStateSource, limits: StateLimits) {
  if (!source || typeof source.read !== 'function' || (source.authorization && typeof source.authorization.require !== 'function')) throw new AgUiFailure('INVALID_STATE_SOURCE');
  const read = source.read.bind(source); const authorization = source.authorization; let active = 0;
  return async (input: AgUiStateContext, checkThread: () => Promise<void>): Promise<StateStream> => {
    const scope = Object.freeze({ principalId: input.scope.principalId, projectId: input.scope.projectId });
    const context = Object.freeze({ ...input, scope }); let reads = 0;
    const authorize = async (): Promise<void> => {
      if (context.signal.aborted) throw new AgUiFailure('ABORTED', 408);
      await checkThread();
      if (authorization) {
        try { await authorization.require(scope, 'read_state', { kind: 'thread', id: context.threadId, scope, ownerId: scope.principalId }, { signal: context.signal }); }
        catch { throw new AgUiFailure('STATE_ACCESS_DENIED', 403); }
      }
      if (context.signal.aborted) throw new AgUiFailure('ABORTED', 408);
    };
    const current = async (): Promise<AgUiStateVersion> => {
      await authorize();
      if (++reads > limits.maxStateReads) throw new AgUiFailure('STATE_READ_LIMIT', 429);
      if (active >= limits.maxConcurrentStateReads) throw new AgUiFailure('STATE_READ_BUSY', 429);
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; let abort: () => void = () => {};
      active++;
      const work = Promise.resolve().then(async () => {
        if (controller.signal.aborted) throw new AgUiFailure('ABORTED', 408);
        try { return await read(Object.freeze({ ...context, signal: controller.signal })); }
        catch { throw new AgUiFailure('STATE_SOURCE_UNAVAILABLE', 503); }
      }).then(raw => version(raw, limits));
      void work.then(() => { active--; }, () => { active--; });
      try {
        const result = await Promise.race([work, new Promise<never>((_, reject) => {
          abort = () => { controller.abort(); reject(new AgUiFailure('ABORTED', 408)); };
          context.signal.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => { controller.abort(); reject(new AgUiFailure('STATE_READ_TIMEOUT', 503)); }, limits.stateReadTimeoutMs);
          if (context.signal.aborted) abort();
        })]);
        await authorize(); return result;
      } catch (error) {
        if (error instanceof AgUiFailure) throw error;
        throw new AgUiFailure('STATE_SOURCE_UNAVAILABLE', 503);
      } finally { clearTimeout(timer); context.signal.removeEventListener('abort', abort); controller.abort(); }
    };
    let previous = await current();
    return {
      authorize,
      initial: () => ({ type: 'STATE_SNAPSHOT', snapshot: previous.state, metadata: { mayura: { stateRevision: previous.revision } } }),
      async refresh(): Promise<AgUiEvent | undefined> {
        const next = await current();
        if (next.revision < previous.revision || (next.revision === previous.revision && !equal(previous.state, next.state))) throw new AgUiFailure('STATE_REVISION_CONFLICT', 409);
        if (next.revision === previous.revision) return undefined;
        const delta = difference(previous.state, next.state, limits);
        const metadata = { mayura: { previousStateRevision: previous.revision, stateRevision: next.revision } };
        previous = next;
        return delta === undefined ? { type: 'STATE_SNAPSHOT', snapshot: next.state, metadata }
          : { type: 'STATE_DELTA', delta, metadata };
      },
    };
  };
}
