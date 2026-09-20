import { freezeJson, jsonValue, MayuraError, type JsonObject, type JsonValue, type RunEvent } from '@mayura/core';

const statuses = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
function object(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value;
}
function keys(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error();
}
export function stableId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) throw new MayuraError('INVALID_INPUT', 'A bounded stable run identifier is required.');
  return value;
}
export function integer(value: unknown, positive = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new Error();
  return value;
}
function cost(value: unknown): void {
  if (typeof value === 'number') { integer(value); return; }
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,63}$/.test(value) || BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)) throw new Error();
}
function status(value: unknown): void { if (typeof value !== 'string' || !statuses.has(value)) throw new Error(); }

/** Strict metadata allowlists are the export boundary; rejected input is never retained. */
export function eventSnapshot(value: unknown, expectedRunId: string): RunEvent {
  try {
    const event = object(jsonValue(value, { maxBytes: 4_096, maxDepth: 4, maxNodes: 128 }));
    keys(event, ['runId', 'sequence', 'timestamp', 'type', 'metadata']);
    if (stableId(event['runId']) !== expectedRunId) throw new Error();
    const sequence = integer(event['sequence'], true); const timestamp = event['timestamp'];
    if (typeof timestamp !== 'string' || timestamp.length > 32 || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) throw new Error();
    const metadata = object(event['metadata']);
    switch (event['type']) {
      case 'run.started':
        keys(metadata, ['profile'], ['rootId', 'parentId', 'agentId']);
        if (metadata['profile'] !== 'ephemeral') throw new Error();
        for (const key of ['rootId', 'parentId', 'agentId']) if (Object.hasOwn(metadata, key)) stableId(metadata[key]);
        if (metadata['parentId'] === expectedRunId || (metadata['parentId'] !== undefined && (metadata['rootId'] === undefined || metadata['rootId'] === expectedRunId))
          || (metadata['rootId'] !== undefined && metadata['rootId'] !== expectedRunId && metadata['parentId'] === undefined)) throw new Error();
        break;
      case 'model.started':
        keys(metadata, ['step', 'modelCall']); integer(metadata['step']); integer(metadata['modelCall'], true); break;
      case 'model.completed':
        keys(metadata, ['step', 'response']); integer(metadata['step']);
        if (metadata['response'] !== 'final' && metadata['response'] !== 'tool_calls') throw new Error(); break;
      case 'tool.started':
        keys(metadata, ['callId', 'toolId']); stableId(metadata['callId']); stableId(metadata['toolId']); break;
      case 'tool.completed': {
        keys(metadata, ['callId', 'toolId', 'status'], ['execution', 'disclosure']);
        stableId(metadata['callId']); stableId(metadata['toolId']); status(metadata['status']);
        const execution = metadata['execution']; const disclosure = metadata['disclosure'];
        if ((execution === undefined) !== (disclosure === undefined)) throw new Error();
        if (execution !== undefined) {
          if (!['not_started', 'succeeded', 'failed', 'unknown'].includes(execution as string) || !['released', 'withheld'].includes(disclosure as string)) throw new Error();
          if ((disclosure === 'released' && (execution !== 'succeeded' || metadata['status'] !== 'succeeded'))
            || (metadata['status'] === 'succeeded' && (execution !== 'succeeded' || disclosure !== 'released'))) throw new Error();
        }
        break;
      }
      case 'run.completed':
        keys(metadata, ['status', 'spentMicros', 'reservedMicros', 'calls']);
        status(metadata['status']); cost(metadata['spentMicros']); integer(metadata['reservedMicros']); integer(metadata['calls']); break;
      case 'events.gap':
        keys(metadata, ['from', 'to']);
        if (integer(metadata['from'], true) > integer(metadata['to'], true) || metadata['to'] !== sequence) throw new Error(); break;
      default: throw new Error();
    }
    return freezeJson(event) as unknown as RunEvent;
  } catch { throw new MayuraError('INVALID_INPUT', 'The source supplied an invalid metadata event.'); }
}
