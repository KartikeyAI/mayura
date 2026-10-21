import { threadAuthorization, type ThreadAuthorization } from './authorization.js';
import { freezeJson, jsonValue, MayuraError, ModelInvocationError, type Authorizer, type JsonObject, type JsonValue, type Scope } from '@mayura/core';
import { sha256Hex } from '@mayura/core/host';
import { assertAgent, createRuntime, defineAgent, type AgentDefinition } from '@mayura/runtime';
import type { ThreadCompactionRecord, ThreadStore } from '@mayura/storage-contracts';
import type { ThreadEntry } from './index.js';
import { generatedSummary, newestSummary, readThreadWindow, summaryMessage, turnMessages, wholeTurns } from './history.js';

export interface ThreadCompactionOptions {
  /** Host-owned policy for thread compaction and the summarizer. Must match the service policy when configured. */
  readonly authorization?: Authorizer;
  /** Stable id for this exact request. A pending/failed command never starts another paid model call. */
  readonly commandId: string;
  /** Inclusive sequence of a complete conversation turn. Original entries are retained. */
  readonly through: number;
  /** A dedicated no-tools/no-hooks/no-guards agent. Input: { messages, covers }; output: { summary: string }. */
  readonly agent: AgentDefinition;
  /** Required per-command ceiling; zero is valid for a free/scripted model. */
  readonly maxCostMicros: number;
  readonly maxDurationMs?: number;
  readonly maxSourceEntries?: number;
  readonly maxSourceBytes?: number;
  readonly maxSummaryBytes?: number;
  /** Use a known prior compaction receipt without scanning backwards to discover it. */
  readonly previousSummarySequence?: number;
  readonly signal?: AbortSignal;
}
export interface ThreadCompactionResult {
  readonly commandId: string; readonly entry: ThreadEntry & { readonly kind: 'summary' };
  readonly runId: string; readonly costMicros: number | string; readonly reused: boolean;
}
export interface ThreadCompactionCancellation { readonly status: 'cancelled' | 'committed' | 'missing' }
interface Context {
  readonly store: ThreadStore; readonly key: string; readonly scope: Scope;
  readonly auth: ThreadAuthorization; readonly authorization?: Authorizer;
  readonly active: Map<string, AbortController>;
  need(grant: string): void;
  call<T>(operation: () => Promise<T>): Promise<T>;
}
const pattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function id(value: unknown): string { if (typeof value !== 'string' || !pattern.test(value)) throw new MayuraError('INVALID_INPUT', 'Compaction requires bounded thread and command identifiers.'); return value; }
function bound(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < min || actual > max) throw new MayuraError('INVALID_INPUT', `Compaction ${name} must be ${min} to ${max}.`);
  return actual;
}
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}
const entryView = (entry: { readonly data: JsonObject; readonly kind: string; readonly sequence: number; readonly runId: string; readonly createdAtMs: number }): ThreadEntry =>
  Object.freeze({ ...entry.data, kind: entry.kind, sequence: entry.sequence, turnId: entry.runId, createdAt: new Date(entry.createdAtMs).toISOString() }) as unknown as ThreadEntry;
function grants(context: Context): void { context.need('thread:read'); context.need('thread:write'); context.need('thread:compact'); }
function available(context: Context): void {
  if (typeof context.store.compaction !== 'function') throw new MayuraError('INVALID_CONFIG', 'Thread compaction requires an adapter with compaction journal support.');
}
/** Return the actual committed entry, including its storage sequence, rather than constructing a guessed receipt. */
async function result(context: Context, threadId: string, saved: ThreadCompactionRecord, reused: boolean): Promise<ThreadCompactionResult> {
  if (saved.status !== 'committed' || saved.entrySequence === null || saved.modelRunId === null || saved.costMicros === null) throw new MayuraError('STORAGE_UNAVAILABLE', 'The compaction has no committed summary.');
  const page = await context.call(() => context.store.entries({ scope: context.key, id: threadId, after: saved.entrySequence! - 1, limit: 1 }));
  const entry = page[0] ? generatedSummary(entryView(page[0])) : undefined;
  if (!entry || entry.sequence !== saved.entrySequence || entry.content !== saved.content || entry.compaction.commandId !== saved.commandId
    || entry.compaction.sourceDigest !== saved.sourceDigest || entry.compaction.requestDigest !== saved.requestDigest)
    throw new MayuraError('STORAGE_UNAVAILABLE', 'The committed compaction entry is unavailable or changed.');
  return Object.freeze({ commandId: saved.commandId, entry, runId: saved.modelRunId, costMicros: saved.costMicros, reused });
}
/**
 * Run exactly one budgeted summarizer after a durable reservation, stage its released output, then atomically publish.
 * Original conversation remains append-only. A staged/committed retry never dispatches a model; pending commands fail closed.
 */
export async function compactThread(context: Context, suppliedId: string, options: ThreadCompactionOptions): Promise<ThreadCompactionResult> {
  grants(context); available(context); const threadId = id(suppliedId); const commandId = id(options?.commandId);
  const agent = options?.agent; assertAgent(agent);
  if (context.authorization && options.authorization && context.authorization !== options.authorization) throw new MayuraError('INVALID_CONFIG', 'Compaction must use the scoped thread service authorizer.');
  const authorization = context.authorization ?? options.authorization;
  if (authorization !== undefined && (!authorization || typeof authorization.authorize !== 'function')) throw new MayuraError('INVALID_CONFIG', 'Compaction authorization requires a core authorizer.');
  context.need(`model:${agent.model.id}`);
  if (agent.handoffs?.length || agent.tools.length || agent.hooks.length || agent.guards.input.length || agent.guards.output.length || agent.stream || agent.media)
    throw new MayuraError('INVALID_CONFIG', 'Use a dedicated summarizer agent without tools, hooks, guards, media or streaming.');
  const through = bound(options.through, 0, 1, 999_999_997, 'through');
  const maxCostMicros = bound(options.maxCostMicros, -1, 0, Number.MAX_SAFE_INTEGER, 'maxCostMicros');
  const maxDurationMs = bound(options.maxDurationMs, 60_000, 100, 300_000, 'maxDurationMs');
  const maxSourceEntries = bound(options.maxSourceEntries, 2_000, 1, 10_000, 'maxSourceEntries');
  const maxSourceBytes = bound(options.maxSourceBytes, 524_288, 1024, 2_097_152, 'maxSourceBytes');
  const maxSummaryBytes = bound(options.maxSummaryBytes, 16_384, 256, 65_536, 'maxSummaryBytes');
  const previousSummarySequence = options.previousSummarySequence === undefined ? undefined : bound(options.previousSummarySequence, 0, 1, 999_999_999, 'previousSummarySequence');
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new MayuraError('INVALID_INPUT', 'Compaction signal must be an AbortSignal.');
  const control = new AbortController(); const abort = () => control.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const check = (): void => { if (control.signal.aborted) throw new MayuraError('CANCELLED', 'Thread compaction was cancelled.'); };
  const localAuth = threadAuthorization(authorization, context.scope, signal);
  const authorize = async (action: string): Promise<void> => {
    await context.auth.require(threadId, action, control.signal);
    if (!context.authorization && authorization) await localAuth.require(threadId, action, control.signal);
  };
  const admission = async (): Promise<void> => { check(); await authorize('read'); await authorize('compact'); };
  const requestDigest = sha256Hex(`mayura:thread-compaction-request:v1\0${canonical(jsonValue({ through, maxCostMicros, maxDurationMs, maxSourceEntries, maxSourceBytes, maxSummaryBytes,
    previousSummarySequence: previousSummarySequence ?? null, agent: { id: agent.id, version: agent.version, instructions: agent.instructions, modelId: agent.model.id,
      input: agent.inputJsonSchema ?? null, output: agent.outputJsonSchema ?? null } }))}`);
  const base = { scope: context.key, id: threadId, commandId }; const activeKey = `${threadId}\0${commandId}`;
  const read = () => context.call(() => context.store.compaction({ ...base, action: 'read' }));
  const commit = async (saved: ThreadCompactionRecord, reused: boolean) => {
    await admission(); const committed = saved.status === 'committed' ? saved : await context.call(() => context.store.compaction({ ...base, action: 'commit' }));
    if (!committed) throw new MayuraError('STORAGE_UNAVAILABLE', 'The compaction journal is unavailable.');
    check(); const released = await result(context, threadId, committed, reused);
    await admission(); return released;
  };
  let executorId: string | undefined; let runtime: ReturnType<typeof createRuntime> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await admission(); const existing = await read(); check();
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new MayuraError('CONFLICT', 'The compaction command has a different request.');
      if (existing.status === 'ready' || existing.status === 'committed') return await commit(existing, true);
      throw new MayuraError('CONFLICT', existing.status === 'pending' ? 'This compaction is pending. Cancel it explicitly before choosing a new command.' : 'This compaction command failed. A new model call requires a new command id.');
    }
    const record = await context.call(() => context.store.get({ scope: context.key, id: threadId })); check();
    if (!record || record.status === 'deleted' || record.status === 'deleting') throw new MayuraError('NOT_FOUND', 'No such thread in this scope.');
    if (record.status !== 'active' || through > record.lastSequence) throw new MayuraError('CONFLICT', 'Compaction requires an active thread and an existing complete prefix.');
    let previous: ReturnType<typeof newestSummary>;
    if (previousSummarySequence !== undefined) {
      const page = await context.call(() => context.store.entries({ scope: context.key, id: threadId, after: previousSummarySequence - 1, limit: 1 })); check();
      previous = page[0] ? generatedSummary(entryView(page[0])) : undefined;
      if (!previous || previous.sequence !== previousSummarySequence) throw new MayuraError('INVALID_INPUT', 'The prior summary sequence is not a generated summary.');
    } else {
      const window = await readThreadWindow(async paging => { await admission(); const page = await context.call(() => context.store.entries({ scope: context.key, id: threadId, ...paging })); check(); return page.map(entryView); }, record.lastSequence, 10_000, 8_388_608);
      previous = newestSummary(window.entries);
    }
    if (previous && previous.covers.to >= through) throw new MayuraError('CONFLICT', 'This prefix is already covered by a summary.');
    const sources: ThreadEntry[] = []; let after = previous?.covers.to ?? 0; let sourceBytes = previous ? bytes(previous) : 2;
    while (after < through) {
      await admission(); const page = await context.call(() => context.store.entries({ scope: context.key, id: threadId, after, limit: Math.min(500, maxSourceEntries - sources.length + 1) })); check();
      if (!page.length) throw new MayuraError('CONFLICT', 'The compaction source is incomplete.');
      for (const raw of page) {
        if (raw.sequence > through) break;
        const entry = entryView(raw); sourceBytes += bytes(entry) + 1;
        if (sources.length >= maxSourceEntries || sourceBytes > maxSourceBytes) throw new MayuraError('LIMIT_EXCEEDED', 'The compaction source exceeds its declared scan/byte bounds. Compact a smaller complete prefix.');
        sources.push(entry); after = entry.sequence;
      }
      if (after >= through) break;
      if (page[0]!.sequence > through) throw new MayuraError('CONFLICT', 'Compaction must end at an existing sequence.');
    }
    const last = sources[sources.length - 1];
    if (!last || last.sequence !== through || last.kind !== 'run' || last.status === 'running' || last.compaction)
      throw new MayuraError('INVALID_INPUT', 'Compaction must end at a complete conversation turn.');
    const turns = wholeTurns(sources).map(entries => {
      const messages = turnMessages(entries); const terminal = entries.findLast(entry => entry.kind === 'run');
      if (!messages && terminal?.kind === 'run' && terminal.status === 'succeeded' && !terminal.compaction)
        throw new MayuraError('LIMIT_EXCEEDED', 'A successful source turn cannot be represented whole; compaction will not hide its missing data.');
      return messages;
    }).filter((turn): turn is NonNullable<typeof turn> => turn !== undefined);
    if (!turns.length) throw new MayuraError('INVALID_INPUT', 'The compaction prefix has no new complete successful turns.');
    const messages = [...(previous ? [summaryMessage(previous)] : []), ...turns.flat()];
    const input = freezeJson(jsonValue({ messages, covers: { from: 1, to: through } }, { maxBytes: maxSourceBytes, maxNodes: 200_000 }));
    const sourceDigest = sha256Hex(`mayura:thread-compaction-source:v1\0${canonical(jsonValue({ previous: previous ?? null, entries: sources }, { maxBytes: maxSourceBytes + 1024, maxNodes: 200_000 }))}`);
    executorId = crypto.randomUUID();
    await admission();
    const reserved = await context.call(() => context.store.compaction({ ...base, action: 'reserve', requestDigest, sourceDigest, through,
      expectedSequence: record.lastSequence, sourceEntries: sources.length, sourceTurns: (previous?.compaction.sourceTurns ?? 0) + turns.length, maxCostMicros,
      executorId: executorId!, agentId: agent.id, agentVersion: agent.version, leaseMs: maxDurationMs + 10_000 })); check();
    if (!reserved || reserved.executorId !== executorId) { executorId = undefined; throw new MayuraError('CONFLICT', 'Another executor reserved this compaction.'); }
    context.active.set(activeKey, control);
    timeout = setTimeout(abort, maxDurationMs);
    runtime = createRuntime({ profile: 'ephemeral', scope: context.scope, ...(authorization === undefined ? {} : { authorization }), permissions: { allow: [`model:${agent.model.id}`] }, limits: {
      maxCostMicros, maxDurationMs, maxSteps: 1, maxModelCalls: 1, maxToolCalls: 0, maxConcurrentRuns: 1,
      maxInputBytes: maxSourceBytes, maxContextBytes: maxSourceBytes + 65_536, maxOutputBytes: maxSummaryBytes + 1024 } });
    let dispatchDenied = false;
    // The trusted local adapter checks the thread at the actual provider boundary, after runtime policy waits.
    // Only admission is gated here: successful paid output must still reach private staging before publication checks.
    const summarizer = authorization === undefined ? agent : defineAgent({
      id: agent.id, version: agent.version, instructions: agent.instructions, input: agent.input, output: agent.output, tools: [],
      ...(agent.outputJsonSchema === undefined ? {} : { outputJsonSchema: agent.outputJsonSchema }),
      model: { ...agent.model, generate: async request => {
        try { await admission(); }
        catch { dispatchDenied = true; throw new ModelInvocationError(0); }
        return agent.model.generate(request);
      } },
    });
    await admission(); const run = runtime.submit(summarizer, { input }); const cancel = () => run.cancel();
    control.signal.addEventListener('abort', cancel, { once: true });
    if (control.signal.aborted) cancel();
    let outcome; try { outcome = await run.result(); } finally { control.signal.removeEventListener('abort', cancel); }
    check();
    if (dispatchDenied) throw new MayuraError('PERMISSION_DENIED', 'Thread compaction dispatch is not authorized.');
    if (outcome.status !== 'succeeded') throw new MayuraError(outcome.error.code, 'The compaction model did not release a successful summary.');
    const output = jsonValue(outcome.output, { maxBytes: maxSummaryBytes + 1024 });
    if (!output || typeof output !== 'object' || Array.isArray(output) || Object.keys(output).join(',') !== 'summary' || typeof output['summary'] !== 'string'
      || !output['summary'].trim() || bytes(output['summary']) > maxSummaryBytes) throw new MayuraError('INVALID_OUTPUT', 'Compaction output must be exactly one bounded, non-empty summary string.');
    check();
    // Preserve the paid result privately before checking publication authority; retrying ready state never calls the model.
    const staged = await context.call(() => context.store.compaction({ ...base, action: 'stage', executorId: executorId!, content: output['summary'] as string,
      modelRunId: run.id, costMicros: runtime!.inspect(run).budget.spentMicros })); check();
    if (!staged) throw new MayuraError('STORAGE_UNAVAILABLE', 'The compaction summary could not be staged.');
    return await commit(staged, false);
  } catch (error) {
    if (executorId) {
      // Preserve a released/staged result after lost replies, cancellation or a blocked publish. Never regenerate it.
      const saved = await read().catch(() => undefined);
      if (saved?.status === 'pending' && saved.executorId === executorId) await context.call(() => context.store.compaction({ ...base, action: 'fail', executorId: executorId!,
        code: control.signal.aborted ? 'CANCELLED' : error instanceof MayuraError ? error.code : 'STORAGE_UNAVAILABLE' })).catch(() => undefined);
    }
    throw error instanceof MayuraError ? error : new MayuraError('STORAGE_UNAVAILABLE', 'Thread compaction failed. Retry the same command to inspect its durable state.');
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', abort);
    if (context.active.get(activeKey) === control) context.active.delete(activeKey);
    if (runtime) await runtime.close();
    if (executorId) await context.call(() => context.store.release({ scope: context.key, id: threadId, runId: executorId!, holderId: executorId! })).catch(() => undefined);
  }
}
/** Explicitly terminate a pending/ready command. A late model reply is fenced by the journal status. */
export async function cancelThreadCompaction(context: Context, suppliedId: string, suppliedCommandId: string): Promise<ThreadCompactionCancellation> {
  grants(context); available(context); const threadId = id(suppliedId); const commandId = id(suppliedCommandId);
  await context.auth.require(threadId, 'cancel_compaction'); await context.auth.require(threadId, 'read');
  const base = { scope: context.key, id: threadId, commandId };
  const saved = await context.call(() => context.store.compaction({ ...base, action: 'read' }));
  if (!saved) { await context.auth.require(threadId, 'read'); return Object.freeze({ status: 'missing' }); }
  if (saved.status === 'committed') { await context.auth.require(threadId, 'read'); return Object.freeze({ status: 'committed' }); }
  await context.auth.require(threadId, 'cancel_compaction');
  const result = await context.call(() => context.store.compaction({ ...base, action: 'fail', executorId: saved.executorId, code: 'CANCELLED' }));
  context.active.get(`${threadId}\0${commandId}`)?.abort();
  await context.auth.require(threadId, 'read');
  return Object.freeze({ status: result?.status === 'committed' ? 'committed' : 'cancelled' });
}
