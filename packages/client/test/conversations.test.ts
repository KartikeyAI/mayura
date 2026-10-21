import { describe, expect, it, vi } from 'vitest';
import { ClientError, createClient, type ClientEvent, type RemoteApproval, type RunApprovalCommand, type RemoteSnapshot, type RemoteThread } from '../src/index.js';
import { createThreadCompactionController, createHeadlessRunStore, createHeadlessThreadStore, createHeadlessThreadsStore, createRunActivityProjection, createRunApprovalController } from '../src/headless.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const approval: RemoteApproval = Object.freeze({ callId: 'call 1', toolId: 'refund', toolVersion: '1.0', input: Object.freeze({ amount: 12 }), digest: 'a'.repeat(64), expiresAtMs: Date.now() + 60_000 });
const thread: RemoteThread = Object.freeze({ id: 'chat/one', agentId: 'support', title: 'Refund', metadata: Object.freeze({}), status: 'active', version: 1,
  createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z', entryCount: 0, lastSequence: 0, activeTurnId: null });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fixture(answer: (request: Request) => Response | Promise<Response>) {
  const transport = vi.fn<typeof fetch>(async (url, init) => answer(new Request(url, init)));
  return { client: createClient({ baseUrl: 'https://mayura.test', token: () => 'test', fetch: transport, reconnectDelayMs: 1 }), transport };
}
const wireSnapshot = (status: RemoteSnapshot['status'] = 'waiting') => ({ id, status, budget: { spentMicros: 0, reservedMicros: 0, calls: 0 }, evidence: [], ...(status === 'waiting' ? { approval } : {}) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('conversation client', () => {
  it('uses scoped thread routes, opaque cursors, optimistic versions and body-free lifecycle commands', async () => {
    const requests: Request[] = []; const bodies: unknown[] = [];
    const { client } = fixture(async request => {
      requests.push(request); bodies.push(request.body ? await request.json() : null);
      const url = new URL(request.url);
      if (request.method === 'DELETE') return reply({ removed: 3 });
      if (url.pathname.endsWith('/entries')) return reply({ entries: [{ kind: 'assistant', output: '<script>', sequence: 3, turnId: 'turn1', createdAt: thread.createdAt }] });
      if (url.pathname === '/v1/threads' && request.method === 'GET') return reply({ threads: [thread], cursor: '123:chat/one' });
      return reply({ thread });
    });
    const first = await client.threads({ limit: 1 }); await client.threads({ cursor: first.cursor!, status: 'all' });
    expect(new URL(requests[1]!.url).searchParams.get('cursor')).toBe('123:chat/one');
    expect(await client.createThread({ id: thread.id, agentId: 'support', title: 'Refund' })).toEqual(thread);
    expect(await client.thread(thread.id)).toEqual(thread);
    await client.updateThread(thread.id, { title: null, expectedVersion: 1 }); expect(bodies.at(-1)).toEqual({ title: null, expectedVersion: 1 });
    const entries = await client.threadEntries(thread.id, { before: 4, limit: 2 }); expect(entries[0]).toMatchObject({ sequence: 3, output: '<script>' });
    expect(Object.isFrozen(entries[0])).toBe(true); expect(requests.at(-1)!.url).toContain('chat%2Fone/entries');
    await client.archiveThread(thread.id); await client.restoreThread(thread.id); expect(await client.deleteThread(thread.id)).toEqual({ removed: 3 });
    expect(bodies.slice(-3)).toEqual([null, null, null]); expect(requests.at(-1)!.method).toBe('DELETE');
  });

  it('binds submissions and returns undefined while waiting without validating terminal output', async () => {
    const bodies: unknown[] = []; const { client } = fixture(async request => {
      if (request.method === 'POST') { bodies.push(await request.json()); return reply({ id, profile: 'ephemeral' }, 202); }
      return reply(wireSnapshot());
    });
    const run = await client.submit('support', { message: 'refund' }, { idempotencyKey: 'turn-1', threadId: thread.id });
    expect(bodies[0]).toEqual({ agentId: 'support', input: { message: 'refund' }, threadId: thread.id });
    const schema = { '~standard': { version: 1 as const, validate: vi.fn(() => ({ value: 'unexpected' })) } };
    expect(await run.result(schema)).toBeUndefined(); expect(schema['~standard'].validate).not.toHaveBeenCalled();
    const view = await run.inspect(); expect(view.approval).toEqual(approval); expect(Object.isFrozen(view.approval!.input)).toBe(true);
    await run.approve({ callId: approval.callId, digest: approval.digest, decision: 'rejected', reason: 'Wrong amount' });
    expect(bodies[1]).toEqual({ callId: approval.callId, digest: approval.digest, decision: 'rejected', reason: 'Wrong amount' });
  });

  it('rejects invalid envelopes locally and preserves known permission, conflict and storage errors without retrying', async () => {
    const { client, transport } = fixture(() => reply({ error: { code: 'APPROVAL_CONFLICT', message: 'Already answered.' } }, 409));
    await expect(client.run(id).approve({ callId: 'c1', digest: approval.digest, decision: 'approved', actorId: 'spoof' } as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.threadEntries('x', { after: 1, before: 4 })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(client.createThread({ metadata: { scope: 'spoof' }, scope: 'foreign' } as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(transport).not.toHaveBeenCalled();
    await expect(client.run(id).approve({ callId: 'c1', digest: approval.digest, decision: 'approved' })).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT', status: 409 });
    expect(transport).toHaveBeenCalledTimes(1);
    for (const code of ['THREAD_NOT_FOUND', 'THREAD_CONFLICT', 'CONVERSATION_UNAVAILABLE', 'CAPABILITY_REQUIRED']) {
      const next = fixture(() => reply({ error: { code } }, 403)); await expect(next.client.thread('x')).rejects.toMatchObject({ code }); expect(next.transport).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects foreign identities, corrupt entries and approval payloads on terminal snapshots', async () => {
    for (const body of [{ thread: { ...thread, id: 'foreign' } }, { thread: { ...thread, metadata: [] } }]) {
      await expect(fixture(() => reply(body)).client.thread(thread.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
    for (const entries of [
      [{ kind: 'assistant', output: 1, sequence: 3, turnId: 'turn', createdAt: thread.createdAt }, { kind: 'assistant', output: 2, sequence: 3, turnId: 'turn', createdAt: thread.createdAt }],
      [{ kind: 'approval', callId: 'c1', toolId: 'refund', decision: 'approved', actorId: 'alice', secret: 'withheld', sequence: 2, turnId: 'turn', createdAt: thread.createdAt }],
    ]) await expect(fixture(() => reply({ entries })).client.threadEntries('x')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(fixture(() => reply({ ...wireSnapshot('succeeded'), approval })).client.run(id).inspect()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('cancels thread and approval requests before sending and never retries a failed decision', async () => {
    const { client, transport } = fixture(() => { throw new Error('offline'); }); const control = new AbortController(); control.abort();
    await expect(client.thread('x', { signal: control.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(client.run(id).approve({ callId: 'c1', digest: approval.digest, decision: 'approved' }, { signal: control.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(transport).not.toHaveBeenCalled();
    await expect(client.run(id).approve({ callId: 'c1', digest: approval.digest, decision: 'approved' })).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' }); expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('conversation headless stores', () => {
  it('loads bounded pages and fixes the thread binding on explicit submissions', async () => {
    let submitted: unknown; const { client, transport } = fixture(async request => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/runs') { submitted = await request.json(); return reply({ id, profile: 'ephemeral' }); }
      if (url.pathname.endsWith('/entries')) return reply({ entries: [] });
      if (request.method === 'DELETE') return reply({ removed: 0 });
      if (url.pathname === '/v1/threads') return reply({ threads: [thread], cursor: null });
      return reply({ thread });
    });
    const index = createHeadlessThreadsStore({ client }); const store = createHeadlessThreadStore({ client, threadId: thread.id, maxEntries: 2 });
    expect(transport).not.toHaveBeenCalled(); await index.refresh(); expect(index.getSnapshot().page?.threads).toEqual([thread]);
    await store.refresh(); expect(store.getSnapshot()).toMatchObject({ status: 'ready', thread, entries: [] });
    await expect(store.refresh({ limit: 3 })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await store.submit('support', 1, { idempotencyKey: 'turn-1', threadId: 'spoof' } as never); expect(submitted).toMatchObject({ threadId: thread.id });
    await store.delete(); expect(store.getSnapshot()).toMatchObject({ status: 'deleted', thread: null, entries: [] }); store.dispose(); index.dispose();
  });

  it('fences concurrent work, bounds listeners and aborts in-flight reads on disposal', async () => {
    const pending = deferred<Response>();
    const { client, transport } = fixture(async () => pending.promise);
    const store = createHeadlessThreadsStore({ client, maxSubscribers: 1 }); const listener = vi.fn(); store.subscribe(listener);
    expect(() => store.subscribe(() => {})).toThrowError(expect.objectContaining({ code: 'VIEW_SUBSCRIBER_LIMIT' }));
    const reading = store.refresh(); const rejected = expect(reading).rejects.toMatchObject({ code: 'ABORTED' });
    try {
      await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
      // Observe the signal the client actually supplies, not a dependent signal owned by a temporary Request wrapper.
      const signal = transport.mock.calls[0]![1]!.signal;
      expect(signal).toBeDefined(); await expect(store.refresh()).rejects.toMatchObject({ code: 'VIEW_BUSY' });
      store.dispose(); const disposed = store.getSnapshot(); expect(signal!.aborted).toBe(true);
      pending.resolve(reply({ threads: [], cursor: null }));
      await rejected; expect(store.getSnapshot()).toBe(disposed); expect(disposed.status).toBe('disposed');
      await expect(store.refresh()).rejects.toMatchObject({ code: 'VIEW_DISPOSED' });
    } finally {
      // Assertion failures must still release the fake transport and await the admitted cancellation assertion.
      store.dispose(); pending.resolve(reply({ threads: [], cursor: null })); await rejected;
    }
  });

  it('captures immutable approval identity, prevents duplicates and exposes explicit failure/conflict feedback', async () => {
    const pending = deferred<void>(); const approve = vi.fn(async (_command: RunApprovalCommand) => pending.promise);
    const controller = createRunApprovalController({ run: { approve }, approval });
    expect(approve).not.toHaveBeenCalled(); const sending = controller.submit('approved');
    expect(controller.getSnapshot().status).toBe('submitting'); await expect(controller.submit('rejected')).rejects.toMatchObject({ code: 'VIEW_BUSY' });
    pending.resolve(); await sending; expect(controller.getSnapshot().status).toBe('succeeded');
    await expect(controller.submit('approved')).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' }); expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]?.[0]).toEqual({ callId: approval.callId, digest: approval.digest, decision: 'approved' }); controller.dispose();
    for (const code of ['APPROVAL_CONFLICT', 'CAPABILITY_REQUIRED', 'CONVERSATION_UNAVAILABLE']) {
      const decision = vi.fn(async () => { throw new ClientError(code); }); const failed = createRunApprovalController({ run: { approve: decision }, approval });
      await expect(failed.submit('rejected')).rejects.toMatchObject({ code }); expect(failed.getSnapshot()).toMatchObject({ status: code === 'APPROVAL_CONFLICT' ? 'conflict' : 'failed', errorCode: code }); expect(decision).toHaveBeenCalledTimes(1); failed.dispose();
    }
    const expired = createRunApprovalController({ run: { approve }, approval: { ...approval, expiresAtMs: 1 } });
    await expect(expired.submit('approved')).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' }); expect(approve).toHaveBeenCalledTimes(1); expired.dispose();
  });

  it('refreshes exact pending approval at pause and preserves a live observation through resume', async () => {
    const current = { value: 'waiting' as RemoteSnapshot['status'] }; const requested: ClientEvent['metadata'] = Object.freeze({ callId: approval.callId, toolId: approval.toolId, digest: approval.digest, expiresAtMs: approval.expiresAtMs });
    const types: ClientEvent['type'][] = ['run.started', 'approval.requested', 'run.paused', 'approval.resolved', 'run.resumed', 'run.completed'];
    const run = { id, resumeTool: async () => {}, approve: async () => {}, cancel: async () => {}, result: async () => undefined,
      inspect: async () => Object.freeze({ ...wireSnapshot(current.value), budget: Object.freeze(wireSnapshot().budget), evidence: Object.freeze([]) }),
      events: async function* () {
        for (const [index, type] of types.entries()) {
          if (type === 'run.resumed') current.value = 'running'; if (type === 'run.completed') current.value = 'succeeded';
          yield Object.freeze({ runId: id, sequence: index + 1, timestamp: thread.createdAt, type, metadata: type === 'approval.requested' ? requested : Object.freeze(type === 'approval.resolved' ? { callId: approval.callId, toolId: approval.toolId, decision: 'approved' } : type === 'run.paused' || type === 'run.resumed' ? { callId: approval.callId } : {}) }) as ClientEvent;
        }
      } };
    const store = createHeadlessRunStore({ run }); const statuses: unknown[] = []; store.subscribe(() => statuses.push(store.getSnapshot().snapshot?.status));
    await store.observe(); expect(statuses).toContain('waiting'); expect(statuses).toContain('running'); expect(store.getSnapshot().snapshot?.status).toBe('succeeded');
    const projection = createRunActivityProjection(store.getSnapshot()); expect(projection.items).toHaveLength(1); expect(projection.items[0]?.status).toBe('completed'); store.dispose();
  });
});


it('keeps reconnecting quiet waiting runs and rejects content-bearing approval event metadata', async () => {
  let connections = 0;
  const frame = (type: string, sequence: number, metadata: unknown) => `id: ${sequence}\nevent: ${type}\ndata: ${JSON.stringify({ runId: id, sequence, type, timestamp: thread.createdAt, metadata })}\n\n`;
  const { client } = fixture(request => {
    if (!new URL(request.url).pathname.endsWith('/events')) return reply(wireSnapshot());
    connections += 1; return new Response(connections <= 2 ? '' : frame('run.completed', 1, { status: 'succeeded' }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const events: ClientEvent[] = []; for await (const event of client.run(id).events()) events.push(event);
  expect(connections).toBe(3); expect(events[0]?.type).toBe('run.completed');
  const bad = fixture(() => new Response(frame('approval.requested', 1, { callId: 'c1', toolId: 'refund', digest: approval.digest, expiresAtMs: approval.expiresAtMs, input: 'private input' }), { headers: { 'content-type': 'text/event-stream' } }));
  await expect(async () => { for await (const _ of bad.client.run(id).events({ reconnect: false })) { /* Exhaust validation. */ } }).rejects.toMatchObject({ code: 'INVALID_STREAM' });
});


it('aborts approval controllers without publishing late success or sending a pre-cancelled decision', async () => {
  const pending = deferred<void>(); let signal: AbortSignal | undefined;
  const approve = vi.fn(async (_command: RunApprovalCommand, options?: { readonly signal?: AbortSignal }) => { signal = options?.signal; return pending.promise; });
  const controller = createRunApprovalController({ run: { approve }, approval }); const control = new AbortController(); control.abort();
  await expect(controller.submit('approved', { signal: control.signal })).rejects.toMatchObject({ code: 'ABORTED' }); expect(approve).not.toHaveBeenCalled();
  const sending = controller.submit('rejected'); const rejected = expect(sending).rejects.toMatchObject({ code: 'ABORTED' });
  controller.dispose(); const disposed = controller.getSnapshot(); expect(signal?.aborted).toBe(true); pending.resolve(); await rejected;
  expect(controller.getSnapshot()).toBe(disposed); expect(disposed.status).toBe('disposed');
});

it('rejects approval accessors and cyclic input before retaining or submitting untrusted data', () => {
  const approve = vi.fn(async () => {}); const getter = vi.fn(() => 'private');
  expect(() => createRunApprovalController({ run: { approve }, approval: { ...approval, get digest() { return getter(); } } })).toThrowError(expect.objectContaining({ code: 'INVALID_VIEW_CONFIG' }));
  expect(getter).not.toHaveBeenCalled();
  const input: Record<string, unknown> = {}; input['self'] = input;
  expect(() => createRunApprovalController({ run: { approve }, approval: { ...approval, input: input as never } })).toThrowError(expect.objectContaining({ code: 'INVALID_VIEW_CONFIG' })); expect(approve).not.toHaveBeenCalled();
});

describe('generated thread summary receipts', () => {
  const compaction = { format: 1, commandId: 'compact-1', requestDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64), sourceEntries: 3, sourceTurns: 1,
    agentId: 'summarizer', agentVersion: '1', modelRunId: id, costMicros: 3 };
  const summary = { kind: 'summary', sequence: 5, turnId: 'compact-worker', createdAt: thread.createdAt, content: 'Untrusted earlier context', covers: { from: 1, to: 3 }, compaction };
  it('preserves validated summary and operation provenance for browser/headless consumers', async () => {
    const { client } = fixture(() => reply({ entries: [{ kind: 'run', runId: 'compact-worker', sequence: 4, turnId: 'compact-worker', createdAt: thread.createdAt,
      status: 'running', compaction: { format: 1, commandId: 'compact-1' } }, summary] }));
    const entries = await client.threadEntries(thread.id); expect(entries[1]).toMatchObject(summary); expect(Object.isFrozen(entries[1])).toBe(true);
  });
  it('rejects forged ranges, malformed hashes and impossible provenance counters', async () => {
    for (const malformed of [{ ...summary, covers: { from: 1, to: 5 } }, { ...summary, compaction: { ...compaction, sourceTurns: 0 } },
      { ...summary, compaction: { ...compaction, sourceDigest: 'wrong' } }]) {
      const { client } = fixture(() => reply({ entries: [malformed] })); await expect(client.threadEntries(thread.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });
});

const compactionReceipt = () => ({ commandId: 'compact/one', runId: id, costMicros: 0, reused: false,
  entry: { kind: 'summary' as const, sequence: 5, turnId: 'executor', createdAt: thread.createdAt, content: 'Untrusted context', covers: { from: 1, to: 3 },
    compaction: { format: 1 as const, commandId: 'compact/one', requestDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64), sourceEntries: 3, sourceTurns: 1, agentId: 'summary', agentVersion: '1', modelRunId: id, costMicros: 0 } } });
const compactionView = () => ({ commandId: 'compact/one', status: 'committed' as const, through: 3, maxCostMicros: 0, costMicros: 0, entrySequence: 5 });
describe('compaction commands and headless feedback', () => {
  it('encodes command ids, validates receipts and never retries conflicts', async () => {
    const requests: Request[] = []; const bodies: unknown[] = [];
    const { client, transport } = fixture(async request => {
      requests.push(request); bodies.push(request.body ? await request.json() : null);
      if (request.url.endsWith('/cancel')) return reply({ status: 'committed' });
      if (request.method === 'GET') return reply({ compaction: compactionView() });
      return reply({ result: compactionReceipt() });
    });
    const command = { commandId: 'compact/one', through: 3 };
    expect(await client.compactThread('chat/one', command)).toEqual(compactionReceipt());
    expect(await client.threadCompaction('chat/one', command.commandId)).toEqual(compactionView());
    expect(await client.cancelThreadCompaction('chat/one', command.commandId)).toEqual({ status: 'committed' });
    expect(bodies).toEqual([command, null, null]); expect(requests[1]!.url).toContain('chat%2Fone/compactions/compact%2Fone');
    expect(Object.isFrozen((await client.compactThread('chat/one', command)).entry)).toBe(true);
    const count = transport.mock.calls.length;
    await expect(client.compactThread('chat', { ...command, maxCostMicros: 999 } as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(transport).toHaveBeenCalledTimes(count);
    for (const code of ['THREAD_COMPACTION_LIMIT', 'THREAD_COMPACTION_CANCELLED', 'THREAD_COMPACTION_NOT_FOUND', 'THREAD_CONFLICT']) {
      const other = fixture(() => reply({ error: { code } }, 409)); await expect(other.client.compactThread('chat', command)).rejects.toMatchObject({ code }); expect(other.transport).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects mismatched, malformed and private receipt fields', async () => {
    for (const result of [{ ...compactionReceipt(), commandId: 'foreign' }, { ...compactionReceipt(), costMicros: 1 },
      { ...compactionReceipt(), entry: { ...compactionReceipt().entry, covers: { from: 1, to: 2 } } }, { ...compactionReceipt(), executorId: 'secret' }]) {
      const { client } = fixture(() => reply({ result })); await expect(client.compactThread('chat', { commandId: 'compact/one', through: 3 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
    for (const compaction of [{ ...compactionView(), content: 'private' }, { ...compactionView(), entrySequence: null },
      { ...compactionView(), status: 'pending' }, { ...compactionView(), commandId: 'foreign' }]) {
      const { client } = fixture(() => reply({ compaction })); await expect(client.threadCompaction('chat', 'compact/one')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });
  it('cancels concurrently with submission and ignores late view publication', async () => {
    const late = deferred<ReturnType<typeof compactionReceipt>>();
    const client = { compactThread: vi.fn(() => late.promise), threadCompaction: vi.fn(async () => compactionView()), cancelThreadCompaction: vi.fn(async () => ({ status: 'cancelled' as const })) };
    const command = { commandId: 'compact/one', through: 3 }; const controller = createThreadCompactionController({ client, threadId: 'chat', command, maxSubscribers: 1 });
    command.commandId = 'mutated';
    expect(controller.getSnapshot()).toMatchObject({ threadId: 'chat', command: { commandId: 'compact/one', through: 3 } });
    expect(Object.isFrozen(controller.getSnapshot().command)).toBe(true);
    const unsubscribe = controller.subscribe(() => {}); expect(() => controller.subscribe(() => {})).toThrow(); unsubscribe();
    const work = controller.compact(); expect(controller.getSnapshot().status).toBe('submitting');
    await expect(controller.compact()).rejects.toMatchObject({ code: 'VIEW_BUSY' });
    await controller.cancel(); late.resolve(compactionReceipt()); await work;
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', result: null, cancellation: { status: 'cancelled' } });
    expect(client.compactThread.mock.calls[0]).toEqual(['chat', { commandId: 'compact/one', through: 3 }, expect.objectContaining({ signal: expect.any(AbortSignal) })]);
    controller.dispose(); await expect(controller.refresh()).rejects.toMatchObject({ code: 'VIEW_DISPOSED' });
  });
  it('propagates caller cancellation, preserves unknown outcomes and stops feedback on disposal', async () => {
    const pending = deferred<ReturnType<typeof compactionReceipt>>();
    const client = { compactThread: vi.fn((_id: string, _input: unknown, options?: { signal?: AbortSignal }) => { options?.signal?.addEventListener('abort', () => pending.resolve(compactionReceipt())); return pending.promise; }),
      threadCompaction: vi.fn(async () => compactionView()), cancelThreadCompaction: vi.fn(async () => ({ status: 'missing' as const })) };
    const view = createThreadCompactionController({ client, threadId: 'chat', command: { commandId: 'compact/one', through: 3 } });
    const abort = new AbortController(); const work = view.compact({ signal: abort.signal }); abort.abort();
    await expect(work).rejects.toMatchObject({ code: 'ABORTED' }); expect(client.cancelThreadCompaction).not.toHaveBeenCalled();
    const frozen = view.getSnapshot(); expect(Object.isFrozen(frozen)).toBe(true); view.dispose(); expect(view.getSnapshot().status).toBe('disposed');
  });
});

it('preserves authorization denials and accepts sealed thread continuation tokens without retrying', async () => {
  const denied = fixture(() => reply({ error: { code: 'AUTHORIZATION_DENIED', message: 'The operation is not authorized.' } }, 403));
  await expect(denied.client.thread('chat')).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED', status: 403 }); expect(denied.transport).toHaveBeenCalledTimes(1);
  const cursor = `authz1.${'a'.repeat(100)}`; const requests: Request[] = [];
  const pages = fixture(request => { requests.push(request); return reply({ threads: [], cursor }); });
  const first = await pages.client.threads(); await pages.client.threads({ cursor: first.cursor! }); expect(new URL(requests[1]!.url).searchParams.get('cursor')).toBe(cursor);
});
