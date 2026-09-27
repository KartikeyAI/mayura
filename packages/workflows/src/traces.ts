import { MayuraError, type ErrorCode, type JsonObject, type JsonValue, type Scope } from '@mayura/core';
import { StorageError, type AggregateStore, type StoredEvent, type StoredRecord } from '@mayura/storage-contracts';
import { digest } from './definition.js';
import type { WorkflowDrainOptions, WorkflowDrainReport } from './drain.js';
import type { WorkflowWorkerUnit } from './worker.js';

/**
 * Metadata-only traces of durable workflow runs. A settled run's durable event log (plus its settled snapshot) is
 * projected into one root span and one span per step. The projection is pure: it reads only event types, node ids,
 * store timestamps, statuses, receipt execution states, fixed failure codes and budget integers, never inputs,
 * outputs, prompts, request/response digests, human identities or error text. Trace and span ids derive from the run
 * id and node id, so projecting the same run again (after a restart, or twice) yields identical ids.
 */

/** Span attributes this projection emits; a subset of `@mayura/exporter-otlp`'s closed catalog. */
export type WorkflowTraceAttributeName =
  | 'mayura.workflow.definition.id' | 'mayura.workflow.definition.version' | 'mayura.workflow.definition.digest'
  | 'mayura.workflow.status' | 'mayura.workflow.events'
  | 'mayura.workflow.node.id' | 'mayura.workflow.node.kind' | 'mayura.workflow.step.status' | 'mayura.workflow.step.code'
  | 'mayura.workflow.receipt.execution' | 'mayura.workflow.child.run.id' | 'mayura.tool.id' | 'mayura.tool.version'
  | 'mayura.budget.spent_micros' | 'mayura.budget.reserved_micros' | 'mayura.budget.max_micros' | 'mayura.budget.step_cost_micros';
export type WorkflowTraceAttributes = Readonly<Partial<Record<WorkflowTraceAttributeName, string | number>>>;
/** Structurally an `OtlpTraceSpan`: pass these straight to an OTLP trace exporter's `sink`. */
export interface WorkflowTraceSpan {
  readonly traceId: string; readonly spanId: string; readonly parentSpanId?: string; readonly name: string;
  readonly startTimeUnixNano: string; readonly endTimeUnixNano: string; readonly status: 'unset' | 'ok' | 'error';
  readonly runId?: string; readonly attributes?: WorkflowTraceAttributes;
}
export interface WorkflowTraceContext { readonly traceId: string; readonly spanId: string }
/** What the projection reads from a definition: identity and node ids, kinds and tool identities. Every format's definition qualifies. */
export interface WorkflowTraceDefinition {
  readonly id: string; readonly version: string; readonly digest: string;
  readonly nodes: readonly { readonly id: string; readonly kind: string; readonly tool?: { readonly id: string; readonly version: string; readonly costMicros?: number } }[];
}
/** What the projection reads from a settled snapshot. Every runtime's `inspect()` result qualifies. */
export interface WorkflowTraceSnapshot {
  readonly status: string;
  readonly steps: Readonly<Record<string, { readonly kind: string; readonly status: string }>>;
  readonly budget?: unknown;
}
export interface WorkflowTraceInput {
  readonly runId: string;
  readonly snapshot: WorkflowTraceSnapshot;
  /** The run's complete durable log from sequence 1, as `runtime.events(id, after)` pages it. */
  readonly events: readonly StoredEvent[];
  readonly definition?: WorkflowTraceDefinition;
}

const runPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const nodePattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const stable = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const settled = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
/** Normalized (`lifecycle.` prefix removed) event types after which a step changes no more. */
const stepEnds = new Set(['step.completed', 'step.failed', 'step.blocked', 'step.skipped', 'step.bypassed', 'step.output_blocked', 'human.responded',
  'human.timed_out', 'human.invalid', 'timer.fired', 'timer.invalid', 'workflow.wait_resolved', 'workflow.child_joined']);
const failures = new Set(['step.failed', 'step.blocked', 'step.output_blocked']);

function derived(domain: string, value: JsonObject, length: 16 | 32): string {
  const hex = digest(domain, value).slice(0, length);
  return /^0+$/.test(hex) ? `${hex.slice(0, -1)}1` : hex;
}
const nanos = (milliseconds: number): string => (BigInt(milliseconds) * 1_000_000n).toString();
const spanStatus = (status: string): WorkflowTraceSpan['status'] =>
  status === 'succeeded' ? 'ok' : ['failed', 'blocked', 'outcome_unknown', 'unknown', 'timed_out'].includes(status) ? 'error' : 'unset';
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const field = (value: unknown, key: string): unknown => value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;

/** The root span of a run (no node), or the span of one of its steps. Parent your own spans under these. */
export function workflowTraceContext(runId: string, nodeId?: string): WorkflowTraceContext {
  if (typeof runId !== 'string' || !runPattern.test(runId) || (nodeId !== undefined && (typeof nodeId !== 'string' || !nodePattern.test(nodeId)))) {
    throw new MayuraError('INVALID_INPUT', 'A workflow trace context requires a bounded run id and node id.');
  }
  return Object.freeze({ traceId: derived('mayura:workflow-trace:v1', { runId }, 32), spanId: derived('mayura:workflow-span:v1', { runId, nodeId: nodeId ?? null }, 16) });
}

/**
 * The span of the step a tool is executing in, from its execution context: every format calls a step's tool with
 * `callId` `<runId>/step:<nodeId>`. Spans produced inside the tool (for example an agent run's, via
 * `agentRunTraceSpans(events, { parent })`) then nest under that step in the run's trace.
 */
export function workflowStepTraceContext(context: { readonly runId: string; readonly callId: string }): WorkflowTraceContext {
  const prefix = `${context?.runId}/step:`;
  if (typeof context?.callId !== 'string' || !context.callId.startsWith(prefix)) throw new MayuraError('INVALID_INPUT', 'The execution context is not a workflow step call.');
  return workflowTraceContext(context.runId, context.callId.slice(prefix.length));
}

/**
 * Project a settled run into spans: the root (`workflow:<definitionId>`) spans the whole log, and each step
 * (`<kind>:<nodeId>`) spans its first to its last settling event (or the run's end, for a step that never settled on
 * its own, such as one skipped by cancellation). Times are the store's event timestamps.
 */
export function workflowTraceSpans(input: WorkflowTraceInput): WorkflowTraceSpan[] {
  const { runId, snapshot, definition } = input; const events = input.events;
  if (!Array.isArray(events) || events.length === 0 || !snapshot || typeof snapshot.status !== 'string' || !snapshot.steps || typeof snapshot.steps !== 'object') {
    throw new MayuraError('INVALID_INPUT', 'A workflow trace requires the settled snapshot and the complete event log.');
  }
  const root = workflowTraceContext(runId);
  const times = events.map((event, index) => {
    const time = Date.parse(event?.createdAt);
    if (event?.sequence !== index + 1 || typeof event.type !== 'string' || !event.data || typeof event.data !== 'object' || !Number.isSafeInteger(time) || time < 0) {
      throw new MayuraError('INVALID_INPUT', 'A workflow trace requires the complete, ordered event log from sequence 1.');
    }
    return time;
  });
  // Store clocks can step backwards across processes; clamp so no span ends before it starts or before the run.
  const runStart = times[0]!; const runEnd = Math.max(...times);
  const nodes = new Map((definition?.nodes ?? []).map(node => [node.id, node]));
  const seen = new Map<string, { first: number; end?: number; code?: string; child?: string }>();
  events.forEach((event, index) => {
    const nodeId = event.data['nodeId']; if (typeof nodeId !== 'string' || !Object.hasOwn(snapshot.steps, nodeId)) return;
    const type = event.type.startsWith('lifecycle.') ? event.type.slice('lifecycle.'.length) : event.type;
    const entry = seen.get(nodeId) ?? { first: Math.max(runStart, times[index]!) }; seen.set(nodeId, entry);
    if (stepEnds.has(type)) entry.end = Math.max(entry.first, times[index]!);
    // Fixed upper-case codes only (BUDGET_EXCEEDED, PERMISSION_DENIED, OUTPUT_LIMIT, ...); never a message.
    const code = event.data['code'] ?? event.data['reason'];
    if (failures.has(type) && typeof code === 'string' && codePattern.test(code)) entry.code = code;
    const child = event.data['childId'];
    if (type === 'workflow.child_admitted' && typeof child === 'string' && stable.test(child)) entry.child = child;
  });
  const order = [...nodes.keys(), ...Object.keys(snapshot.steps).filter(id => !nodes.has(id)).sort()].filter(id => Object.hasOwn(snapshot.steps, id));
  const steps = order.map((nodeId): WorkflowTraceSpan => {
    const step = snapshot.steps[nodeId]!; const node = nodes.get(nodeId); const entry = seen.get(nodeId);
    const kind = typeof step.kind === 'string' && stable.test(step.kind) ? step.kind : 'step';
    const status = typeof step.status === 'string' && stable.test(step.status) ? step.status : 'unknown';
    const start = entry?.first ?? runEnd; const end = Math.max(start, entry?.end ?? runEnd);
    const attributes: Record<string, string | number> = { 'mayura.workflow.node.id': nodeId, 'mayura.workflow.node.kind': kind, 'mayura.workflow.step.status': status };
    if (entry?.code) attributes['mayura.workflow.step.code'] = entry.code;
    const execution = field(field(step, 'receipt'), 'execution');
    if (typeof execution === 'string' && stable.test(execution)) attributes['mayura.workflow.receipt.execution'] = execution;
    const child = entry?.child ?? field(field(step, 'child'), 'runId');
    if (typeof child === 'string' && stable.test(child)) attributes['mayura.workflow.child.run.id'] = child;
    if (node?.tool && typeof node.tool.id === 'string' && stable.test(node.tool.id)) attributes['mayura.tool.id'] = node.tool.id;
    if (node?.tool && typeof node.tool.version === 'string' && stable.test(node.tool.version)) attributes['mayura.tool.version'] = node.tool.version;
    if (node?.tool && integer(node.tool.costMicros)) attributes['mayura.budget.step_cost_micros'] = node.tool.costMicros;
    return Object.freeze({ traceId: root.traceId, spanId: workflowTraceContext(runId, nodeId).spanId, parentSpanId: root.spanId,
      name: stable.test(`${kind}:${nodeId}`) ? `${kind}:${nodeId}` : 'workflow.step', runId, status: spanStatus(status),
      startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(end), attributes: Object.freeze(attributes) });
  });
  const attributes: Record<string, string | number> = { 'mayura.workflow.status': stable.test(snapshot.status) ? snapshot.status : 'unknown', 'mayura.workflow.events': events.length };
  if (definition && stable.test(definition.id)) attributes['mayura.workflow.definition.id'] = definition.id;
  if (definition && stable.test(definition.version)) attributes['mayura.workflow.definition.version'] = definition.version;
  if (definition && /^[a-f0-9]{64}$/.test(definition.digest)) attributes['mayura.workflow.definition.digest'] = definition.digest;
  for (const [key, name] of [['spentMicros', 'mayura.budget.spent_micros'], ['reservedMicros', 'mayura.budget.reserved_micros'], ['maxCostMicros', 'mayura.budget.max_micros']] as const) {
    const value = field(snapshot.budget, key); if (integer(value)) attributes[name] = value;
  }
  const name = definition && stable.test(`workflow:${definition.id}`) ? `workflow:${definition.id}` : 'workflow.run';
  return [Object.freeze({ traceId: root.traceId, spanId: root.spanId, name, runId, status: spanStatus(snapshot.status),
    startTimeUnixNano: nanos(runStart), endTimeUnixNano: nanos(runEnd), attributes: Object.freeze(attributes) }), ...steps];
}

// ---- Durable export --------------------------------------------------------------------------------------------------

/** Any workflow runtime of the same format: `inspect` for the settled snapshot and `events` for its durable log. */
export interface WorkflowTraceSource {
  inspect(id: string): Promise<WorkflowTraceSnapshot>;
  events(id: string, after?: number): Promise<readonly StoredEvent[]>;
}
/** An OTLP trace exporter's `sink` qualifies. It is called one batch at a time. */
export type WorkflowTraceSink = (spans: readonly WorkflowTraceSpan[], context: { readonly signal: AbortSignal }) => Promise<void>;
export interface WorkflowTraceExportOptions {
  readonly source: WorkflowTraceSource;
  /** Holds the export's durable outbox and per-run markers. May be the store the workflows use. */
  readonly store: AggregateStore;
  readonly scope: Scope;
  /** Separates independent exports of the same runs, for example two collectors. */
  readonly exportId: string;
  /** Every definition version whose runs may be exported; runs of another digest export without definition attributes. */
  readonly definitions: readonly WorkflowTraceDefinition[];
  readonly sink: WorkflowTraceSink;
  /** Spans per sink call (default 128, at most 256: the OTLP exporter's batch bound). */
  readonly maxBatchSize?: number;
  /** Runs the durable outbox may hold (default 4096, at most 16384). `track` refuses beyond it. */
  readonly maxPending?: number;
  /** Events one run's log may hold for export (default 100000). */
  readonly maxEvents?: number;
}
export interface WorkflowTraceExportResult {
  readonly runId: string;
  /** `exported`: sent and marked. `unchanged`: already exported at this log position. `unsettled`: not terminal yet. */
  readonly status: 'exported' | 'unchanged' | 'unsettled';
  readonly spans: number;
  /** The last event sequence the export covers (0 when unsettled). */
  readonly sequence: number;
}
export interface WorkflowTraceFlushReport {
  readonly examined: number; readonly exported: number; readonly unchanged: number; readonly unsettled: number;
  /** Runs dropped from the outbox because the source no longer knows them. */
  readonly missing: number;
  readonly failed: number; readonly lastError: ErrorCode | null;
}
export interface WorkflowTraceUnitOptions {
  readonly intervalMs?: number;
  /** Runs examined per flush (default 32). */
  readonly limit?: number;
  /** Optional discovery of active runs (any fleet or version target), tracked on every cycle as a safety net for runs never passed to `track`. */
  readonly targets?: readonly { discover(cursor: JsonValue | null, limit: number): Promise<{ readonly runIds: readonly string[]; readonly nextCursor: JsonValue | null }> }[];
}
export interface WorkflowTraceExport {
  /** Durably remember a run (idempotent) so the unit or `flush` exports it once it settles, across restarts. */
  track(runId: string): Promise<void>;
  /** Export one run now if it has settled and its log grew since the last export. Safe to repeat: ids are deterministic. */
  exportRun(runId: string, options?: { readonly signal?: AbortSignal }): Promise<WorkflowTraceExportResult>;
  /** Export settled runs from the outbox (round robin, at most `limit`) and forget them once exported. */
  flush(options?: { readonly signal?: AbortSignal; readonly limit?: number }): Promise<WorkflowTraceFlushReport>;
  /** Run ids still waiting in the durable outbox. */
  pending(): Promise<readonly string[]>;
  /** A worker unit that discovers (optionally), then flushes, every `intervalMs` (default 1 s) while it runs. */
  unit(options?: WorkflowTraceUnitOptions): WorkflowWorkerUnit;
}

const exportPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
function bounded(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new MayuraError('INVALID_CONFIG', `${name} is outside its bound.`);
  return result;
}
const sleep = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise(resolve => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(done, milliseconds); function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});

/**
 * Restart-safe export of settled workflow runs. Durable state is an outbox of tracked run ids and, per run, the log
 * position last exported. A crash before the marker is written re-exports the run later with identical ids (a
 * collector deduplicates); a crash after it only leaves the run in the outbox, where the next flush finds it unchanged
 * and drops it. Nothing here can change, block or fail a workflow run.
 */
export function createWorkflowTraceExport(options: WorkflowTraceExportOptions): WorkflowTraceExport {
  const { source, store, sink } = options;
  if (!source || typeof source.inspect !== 'function' || typeof source.events !== 'function' || !store || typeof store.read !== 'function'
    || typeof store.create !== 'function' || typeof store.update !== 'function' || typeof sink !== 'function' || typeof options.exportId !== 'string'
    || !exportPattern.test(options.exportId) || typeof options.scope?.principalId !== 'string' || typeof options.scope?.projectId !== 'string' || !Array.isArray(options.definitions)) {
    throw new MayuraError('INVALID_CONFIG', 'A workflow trace export requires a source, a store, a scope, a bounded export id, definitions and a sink.');
  }
  const maxBatchSize = bounded(options.maxBatchSize, 128, 256, 'maxBatchSize'); const maxPending = bounded(options.maxPending, 4_096, 16_384, 'maxPending');
  const maxEvents = bounded(options.maxEvents, 100_000, 10_000_000, 'maxEvents'); const exportId = options.exportId;
  const definitions = new Map(options.definitions.map(definition => {
    if (typeof definition?.digest !== 'string' || !Array.isArray(definition.nodes)) throw new MayuraError('INVALID_CONFIG', 'Trace definitions must be workflow definitions with a digest.');
    return [definition.digest, definition] as const;
  }));
  const scope = digest('mayura:scope:v1', { principalId: options.scope.principalId, projectId: options.scope.projectId });
  const formatHash = digest('mayura:workflow-trace-export-format:v1', {});
  const outboxId = digest('mayura:workflow-trace-outbox:v1', { exportId });
  const markerId = (runId: string): string => digest('mayura:workflow-trace-export:v1', { exportId, runId });
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) { if (error instanceof MayuraError || (error instanceof StorageError && error.code === 'CONFLICT')) throw error;
      throw new MayuraError('STORAGE_UNAVAILABLE', 'Workflow trace export storage is unavailable.'); }
  };
  const corrupt = (): never => { throw new MayuraError('STORAGE_UNAVAILABLE', 'Stored workflow trace export state failed integrity validation.'); };
  const outboxOf = (record: StoredRecord | undefined): string[] => {
    if (!record) return []; const state = record.state; const pending = state['pending'];
    if (record.scope !== scope || record.id !== outboxId || state['format'] !== 1 || state['exportId'] !== exportId || !Array.isArray(pending) || pending.length > 16_384
      || pending.some((id, index) => typeof id !== 'string' || !runPattern.test(id) || (index > 0 && id <= (pending[index - 1] as string)))) return corrupt();
    return pending as string[];
  };
  const markerOf = (record: StoredRecord | undefined, runId: string): number => {
    if (!record) return 0; const state = record.state;
    if (record.scope !== scope || record.id !== markerId(runId) || state['format'] !== 1 || state['exportId'] !== exportId || state['runId'] !== runId
      || !Number.isSafeInteger(state['sequence']) || (state['sequence'] as number) < 0) return corrupt();
    return state['sequence'] as number;
  };
  /** Compare-and-set write of one export record; `next` returns undefined when nothing needs to change. */
  const change = async (id: string, type: string, next: (record: StoredRecord | undefined) => JsonObject | undefined): Promise<void> => {
    for (let attempt = 0; attempt < 32; attempt++) {
      const record = await guarded(() => store.read(scope, id)); const state = next(record); if (state === undefined) return;
      try {
        if (record) { await guarded(() => store.update({ scope, id, expectedVersion: record.version, state, events: [{ type, data: {} }] })); return; }
        if ((await guarded(() => store.create({ scope, id, idempotencyKey: id, definitionHash: formatHash, state, events: [{ type, data: {} }] }))).created) return;
      } catch (error) { if (!(error instanceof StorageError && error.code === 'CONFLICT')) throw error; }
    }
    throw new MayuraError('CONFLICT', 'Workflow trace export contention exceeded its bounded retry limit.');
  };
  const add = (runIds: readonly string[]): Promise<void> => change(outboxId, 'workflow-trace.tracked', record => {
    const pending = outboxOf(record); const merged = [...new Set([...pending, ...runIds])].sort();
    if (merged.length === pending.length) return undefined;
    if (merged.length > maxPending) throw new MayuraError('LIMIT_EXCEEDED', 'The workflow trace outbox is full.');
    return { format: 1, exportId, pending: merged };
  });
  const remove = (runIds: readonly string[]): Promise<void> => change(outboxId, 'workflow-trace.exported', record => {
    const pending = outboxOf(record); const drop = new Set(runIds); const kept = pending.filter(id => !drop.has(id));
    return kept.length === pending.length ? undefined : { format: 1, exportId, pending: kept };
  });
  const validRun = (runId: unknown): string => {
    if (typeof runId !== 'string' || !runPattern.test(runId)) throw new MayuraError('INVALID_INPUT', 'A bounded workflow run id is required.');
    return runId;
  };
  // The OTLP exporter is single-flight: one run's batches go out together, and runs queue behind each other.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => { const result = tail.then(operation, operation); tail = result.catch(() => undefined); return result; };

  const exportRun = async (rawId: string, runOptions: { readonly signal?: AbortSignal } = {}): Promise<WorkflowTraceExportResult> => {
    const runId = validRun(rawId); const signal = runOptions.signal ?? new AbortController().signal;
    const snapshot = await source.inspect(runId);
    if (!settled.has(snapshot?.status)) return Object.freeze({ runId, status: 'unsettled', spans: 0, sequence: 0 });
    const events: StoredEvent[] = [];
    for (;;) {
      const page = await source.events(runId, events.length);
      if (!Array.isArray(page)) throw new MayuraError('STORAGE_UNAVAILABLE', 'The workflow event source returned an invalid page.');
      if (page.length === 0) break;
      events.push(...page);
      if (events.length > maxEvents) throw new MayuraError('LIMIT_EXCEEDED', 'The workflow run log exceeds the trace export bound.');
    }
    const sequence = events.length;
    if (markerOf(await guarded(() => store.read(scope, markerId(runId))), runId) >= sequence) return Object.freeze({ runId, status: 'unchanged', spans: 0, sequence });
    const pinned = (await guarded(() => store.read(scope, runId)))?.definitionHash;
    const definition = pinned === undefined ? undefined : definitions.get(pinned);
    const spans = workflowTraceSpans({ runId, snapshot, events, ...(definition ? { definition } : {}) });
    await exclusive(async () => {
      for (let index = 0; index < spans.length; index += maxBatchSize) {
        if (signal.aborted) throw new MayuraError('CANCELLED', 'Workflow trace export was cancelled.');
        await sink(Object.freeze(spans.slice(index, index + maxBatchSize)), { signal });
      }
    });
    // Mark only after every batch was accepted; a later, longer log (a late receipt, a reconciliation) exports again.
    await change(markerId(runId), 'workflow-trace.marked', record => markerOf(record, runId) >= sequence ? undefined : { format: 1, exportId, runId, sequence });
    return Object.freeze({ runId, status: 'exported', spans: spans.length, sequence });
  };

  let cursor = '';
  const flush = async (flushOptions: { readonly signal?: AbortSignal; readonly limit?: number } = {}): Promise<WorkflowTraceFlushReport> => {
    const limit = bounded(flushOptions.limit, 32, 1_024, 'limit');
    const pending = outboxOf(await guarded(() => store.read(scope, outboxId)));
    // Round robin from where the last flush stopped, so long-running runs cannot starve the rest.
    const start = pending.findIndex(id => id > cursor); const ordered = start < 0 ? pending : [...pending.slice(start), ...pending.slice(0, start)];
    const counts = { examined: 0, exported: 0, unchanged: 0, unsettled: 0, missing: 0, failed: 0 }; let lastError: ErrorCode | null = null; const done: string[] = [];
    for (const runId of ordered.slice(0, limit)) {
      if (flushOptions.signal?.aborted) break;
      counts.examined++; cursor = runId;
      try {
        const result = await exportRun(runId, flushOptions.signal ? { signal: flushOptions.signal } : {});
        counts[result.status]++; if (result.status !== 'unsettled') done.push(runId);
      } catch (error) {
        const code: ErrorCode = error instanceof MayuraError ? error.code : 'TOOL_FAILED';
        if (code === 'NOT_FOUND') { counts.missing++; done.push(runId); } else { counts.failed++; lastError = code; }
      }
    }
    if (done.length > 0) await remove(done);
    return Object.freeze({ ...counts, lastError });
  };

  return Object.freeze<WorkflowTraceExport>({
    track: async runId => add([validRun(runId)]),
    exportRun, flush,
    pending: async () => Object.freeze([...outboxOf(await guarded(() => store.read(scope, outboxId)))]),
    unit(unitOptions = {}) {
      const intervalMs = bounded(unitOptions.intervalMs, 1_000, 3_600_000, 'intervalMs'); const limit = bounded(unitOptions.limit, 32, 1_024, 'limit');
      const targets = [...(unitOptions.targets ?? [])];
      if (targets.length > 32 || targets.some(target => typeof target?.discover !== 'function')) throw new MayuraError('INVALID_CONFIG', 'Trace discovery takes up to 32 targets with discover().');
      let controller: AbortController | undefined; let loop: Promise<void> | undefined;
      const discover = async (signal: AbortSignal): Promise<void> => {
        for (const target of targets) {
          let next: JsonValue | null = null; let pages = 0;
          do {
            const page = await target.discover(next, 32); const ids = page.runIds.filter(id => typeof id === 'string' && runPattern.test(id));
            if (ids.length > 0) await add(ids);
            next = page.nextCursor; pages++;
          } while (next !== null && pages < 64 && !signal.aborted);
        }
      };
      const stop = async (): Promise<void> => { controller?.abort(); await loop; controller = undefined; loop = undefined; };
      return Object.freeze<WorkflowWorkerUnit>({
        start() {
          if (loop) return; controller = new AbortController(); const signal = controller.signal;
          loop = (async () => {
            while (!signal.aborted) {
              // Telemetry is best effort: a failed cycle is retried on the next one and never stops the worker.
              try { await discover(signal); } catch { /* Discovery resumes next cycle. */ }
              try { await flush({ signal, limit }); } catch { /* The outbox keeps every unexported run. */ }
              await sleep(intervalMs, signal);
            }
          })();
        },
        stop,
        async drain(_options?: WorkflowDrainOptions): Promise<WorkflowDrainReport> { await stop(); return Object.freeze({ drained: true, interrupted: 0 }); },
      });
    },
  });
}
