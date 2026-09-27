import { MayuraError, type RunEvent } from '@mayura/core';
import { snapshotRunEventMetadata } from '@mayura/observability';
import type { OtlpSpanAttributes, OtlpTraceParent, OtlpTraceSpan } from './contracts.js';

const stable = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const traceIdPattern = /^(?!0{32}$)[a-f0-9]{32}$/;
const spanIdPattern = /^(?!0{16}$)[a-f0-9]{16}$/;
const mask = (1n << 64n) - 1n;

/** 64-bit FNV-1a with a SplitMix64 finalizer. Ids need spread, not secrecy, and this package stays free of Node builtins. */
function hash64(bytes: Uint8Array, seed: bigint): string {
  let value = 0xcbf29ce484222325n ^ seed;
  for (const byte of bytes) value = ((value ^ BigInt(byte)) * 0x100000001b3n) & mask;
  value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & mask; value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & mask;
  return (value ^ (value >> 31n)).toString(16).padStart(16, '0');
}
/** A deterministic, never-zero id: the same inputs always give the same id, so a re-export deduplicates. */
function derivedId(parts: readonly string[], length: 16 | 32): string {
  const bytes = new TextEncoder().encode(JSON.stringify(['mayura:agent-run-trace:v1', ...parts]));
  const value = length === 16 ? hash64(bytes, 0n) : `${hash64(bytes, 1n)}${hash64(bytes, 2n)}`;
  return /^0+$/.test(value) ? `${value.slice(0, -1)}1` : value;
}
const nanos = (milliseconds: number): string => (BigInt(milliseconds) * 1_000_000n).toString();
const spanStatus = (status: unknown): OtlpTraceSpan['status'] => status === 'succeeded' ? 'ok' : status === 'cancelled' || status === undefined ? 'unset' : 'error';

export interface AgentRunTraceOptions {
  /** Hang the run under this span, for example the workflow step that ran the agent. Absent: a trace of its own. */
  readonly parent?: OtlpTraceParent;
}

/**
 * Project one agent run's metadata events (for example `observer.inspect(runId).recent`) into completed spans: the
 * run, each model call (`model.call`) and each tool call (`tool:<toolId>`). Every event is re-admitted through the
 * observability allowlist first; an event that fails it is skipped, never exported. Only event types, timing, ids,
 * statuses and counters are used. Span ids derive from the trace, the run id and the call identity, so projecting the
 * same events again yields the same spans. A start without its completion (evicted or still running) yields no span.
 */
export function agentRunTraceSpans(events: readonly RunEvent[], options: AgentRunTraceOptions = {}): OtlpTraceSpan[] {
  const parent = options.parent;
  if (parent !== undefined && (typeof parent?.traceId !== 'string' || !traceIdPattern.test(parent.traceId) || typeof parent.spanId !== 'string' || !spanIdPattern.test(parent.spanId))) {
    throw new MayuraError('INVALID_INPUT', 'A trace parent requires exact OTLP trace and span ids.');
  }
  if (!Array.isArray(events)) throw new MayuraError('INVALID_INPUT', 'Agent run events must be an array.');
  const admitted: RunEvent[] = [];
  for (const event of events) { try { admitted.push(snapshotRunEventMetadata(event)); } catch { /* Not admitted metadata: never exported. */ } }
  const runId = admitted[0]?.runId; if (runId === undefined) return [];
  const own = admitted.filter(event => event.runId === runId).sort((a, b) => a.sequence - b.sequence);
  const traceId = parent?.traceId ?? derivedId(['trace', runId], 32); const runSpanId = derivedId([traceId, runId, 'run'], 16);
  const time = (event: RunEvent): number => Date.parse(event.timestamp);
  const child = (key: readonly string[], name: string, start: RunEvent, end: RunEvent, status: OtlpTraceSpan['status'], attributes: OtlpSpanAttributes): OtlpTraceSpan =>
    ({ traceId, spanId: derivedId([traceId, runId, ...key], 16), parentSpanId: runSpanId, name, runId, status,
      startTimeUnixNano: nanos(time(start)), endTimeUnixNano: nanos(Math.max(time(start), time(end))), attributes });
  const spans: OtlpTraceSpan[] = []; let model: RunEvent | undefined; const guarded = new Map<string, RunEvent>(); const tools = new Map<string, RunEvent>();
  for (const event of own) {
    const metadata = event.metadata;
    if (event.type === 'model.started') {
      if (typeof metadata['callId'] === 'string') guarded.set(metadata['callId'], event); else model = event;
    } else if (event.type === 'model.completed') {
      // Managed guardrail calls carry their own call id; primary calls strictly alternate start and completion.
      const start = typeof metadata['callId'] === 'string' ? guarded.get(metadata['callId']) : model;
      if (!start) continue;
      if (typeof metadata['callId'] === 'string') guarded.delete(metadata['callId']); else model = undefined;
      const call = start.metadata['modelCall'];
      spans.push(child(['model', String(start.sequence)], 'model.call', start, event, 'ok', typeof call === 'number' ? { 'mayura.model.call': call } : {}));
    } else if (event.type === 'tool.started') tools.set(String(metadata['callId']), event);
    else if (event.type === 'tool.completed') {
      const callId = String(metadata['callId']); const start = tools.get(callId); if (!start) continue; tools.delete(callId);
      const toolId = String(metadata['toolId']); const name = stable.test(`tool:${toolId}`) ? `tool:${toolId}` : 'tool.call';
      spans.push(child(['tool', callId], name, start, event, spanStatus(metadata['status']), { 'mayura.tool.id': toolId, 'mayura.tool.status': String(metadata['status']),
        ...(typeof metadata['execution'] === 'string' ? { 'mayura.workflow.receipt.execution': metadata['execution'] } : {}) }));
    }
  }
  const started = own.find(event => event.type === 'run.started'); if (!started) return spans;
  const completed = own.find(event => event.type === 'run.completed'); const last = completed ?? own[own.length - 1]!;
  const agentId = started.metadata['agentId']; const status = completed?.metadata['status'];
  const attributes: Record<string, string | number> = {};
  if (typeof agentId === 'string') attributes['mayura.agent.id'] = agentId;
  if (typeof status === 'string') attributes['mayura.run.status'] = status;
  // Exact costs above 2^53 are decimal strings in run events; the span catalog carries safe integers only.
  for (const [key, name] of [['spentMicros', 'mayura.budget.spent_micros'], ['reservedMicros', 'mayura.budget.reserved_micros']] as const) {
    const value = completed?.metadata[key]; if (typeof value === 'number') attributes[name] = value;
  }
  const name = typeof agentId === 'string' && stable.test(`agent:${agentId}`) ? `agent:${agentId}` : 'agent.run';
  return [{ traceId, spanId: runSpanId, ...(parent ? { parentSpanId: parent.spanId } : {}), name, runId, status: spanStatus(status),
    startTimeUnixNano: nanos(time(started)), endTimeUnixNano: nanos(Math.max(time(started), time(last))), attributes }, ...spans];
}
