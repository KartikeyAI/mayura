import type { CompletionRow } from '../execution-completions.js';
import type { ExecutionStreamRow, ExecutionWaitEventRow, ExecutionWaitRow, ExecutionWaitTargetRow, ExecutionWaitTransaction } from '../execution-wait-persistence.js';
import { compareKeys, key } from './keys.js';
import { at, json, sort } from './layout.js';
import { executionWaiter } from './scheduled-rows.js';
import type { DocumentSession } from './session.js';

/** A stream: `s` the stream, `w`+wait each wait, `t`+wait its targets, `e`+sequence the journal. */
const stream = (scope: string, streamId: string) => key('stream', scope, streamId);
const place = { stream: key('s'), wait: (waitId: string) => key('w', waitId), targets: (waitId: string) => key('t', waitId), event: (sequence: number) => key('e', sequence) };
const kinds = { wait: key('w'), event: key('e') };

/** Execution wait rows as documents in one optimistic transaction. */
export function documentExecutionWaitRows(session: DocumentSession): ExecutionWaitTransaction {
  const targets = async (scope: string, streamId: string, waitId: string) =>
    json<{ rows: ExecutionWaitTargetRow[] }>(await session.get(stream(scope, streamId), place.targets(waitId)))?.rows ?? [];
  const setStream = async (scope: string, streamId: string, change: Partial<ExecutionStreamRow>) => {
    const row = json<ExecutionStreamRow>(await session.get(stream(scope, streamId), place.stream));
    if (row) await session.put(stream(scope, streamId), place.stream, JSON.stringify({ ...row, ...change }));
  };
  return {
    clock: () => session.clock(),
    lockStreamIdentity: async (scope, streamId) => { await session.hold(at.lock('stream', scope, streamId), sort.lock); },
    streamExists: async (scope, streamId) => await session.get(stream(scope, streamId), place.stream) !== undefined,
    stream: async (scope, streamId) => json<ExecutionStreamRow>(await session.get(stream(scope, streamId), place.stream, true)),
    insertStream: async row => { session.insert(stream(row.scope, row.stream_id), place.stream, JSON.stringify({ ...row, format: 1, wait_count: 0, event_sequence: 0 })); },
    setWaitCount: (scope, streamId, count) => setStream(scope, streamId, { wait_count: count }),
    setEventSequence: (scope, streamId, sequence) => setStream(scope, streamId, { event_sequence: sequence }),
    waits: async (scope, streamId) => (await session.query(stream(scope, streamId), { prefix: kinds.wait, limit: 129 })).map(item => json<ExecutionWaitRow>(item.body)!),
    events: async (scope, streamId) => (await session.query(stream(scope, streamId), { prefix: kinds.event, limit: 258 })).map(item => json<ExecutionWaitEventRow>(item.body)!),
    appendEvent: async (scope, streamId, event) => { session.insert(stream(scope, streamId), place.event(Number(event.sequence)), JSON.stringify(event)); },
    wait: async (scope, streamId, waitId) => json<ExecutionWaitRow>(await session.get(stream(scope, streamId), place.wait(waitId))),
    insertWait: async row => { session.insert(stream(row.scope, row.stream_id), place.wait(row.wait_id), JSON.stringify({ ...row, version: 1 })); },
    updateWait: async (scope, streamId, waitId, version, status, data) => {
      const row = json<ExecutionWaitRow>(await session.get(stream(scope, streamId), place.wait(waitId))); if (!row) return;
      await session.put(stream(scope, streamId), place.wait(waitId), JSON.stringify({ ...row, version, status, data }));
    },
    targets: async (scope, streamId, waitId) => (await targets(scope, streamId, waitId)).sort((a, b) => a.ordinal - b.ordinal).slice(0, 33),
    insertTarget: async row => {
      const rows = await targets(row.scope, row.stream_id, row.wait_id);
      await session.put(stream(row.scope, row.stream_id), place.targets(row.wait_id), JSON.stringify({ rows: [...rows, row] }));
      // Where a run is a target, a migration must see it.
      await session.put(at.run(row.scope, row.run_id), executionWaiter(row.stream_id, row.wait_id), JSON.stringify({ stream_id: row.stream_id, wait_id: row.wait_id }));
    },
    readyWaits: async (scope, streamId, limit) => {
      const waiting = (await session.query(stream(scope, streamId), { prefix: kinds.wait })).map(item => json<ExecutionWaitRow>(item.body)!)
        .filter(row => row.status === 'waiting').sort((a, b) => Number(a.registration_sequence) - Number(b.registration_sequence) || compareKeys(a.wait_id, b.wait_id));
      const ready: string[] = [];
      for (const wait of waiting) {
        if (ready.length >= limit) break;
        const edges = await targets(scope, streamId, wait.wait_id); if (!edges.length) continue;
        const facts = await session.getMany(edges.map(edge => ({ partition: at.run(scope, edge.run_id), sort: sort.completion })));
        if (facts.every((text, index) => { const fact = json<CompletionRow>(text); const edge = edges[index]!;
          return fact !== undefined && fact.definition_hash === edge.definition_hash && fact.policy_hash === edge.policy_hash; })) ready.push(wait.wait_id);
      }
      return ready;
    },
    completion: async (scope, runId) => json<CompletionRow>(await session.get(at.run(scope, runId), sort.completion)),
    insertCompletion: async row => { session.insert(at.run(row.scope, row.run_id), sort.completion, JSON.stringify(row)); },
  };
}
