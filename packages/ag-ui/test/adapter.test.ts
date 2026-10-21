import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteThreadEntry } from '@mayura/client';
import { createAgUiAdapter, type AgUiAdapter, type AgUiAdapterOptions, type AgUiStateContext, type AgUiEvent } from '../src/index.js';

// Offline wire fixture deliberately implements the scoped native HTTP boundary, not an AG-UI-specific runtime.
const origin = 'https://agents.example.test'; const nativeId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222'; const secret = new Uint8Array(32).fill(7);
const adapters: AgUiAdapter[] = [];
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.close(); vi.useRealTimers(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const error = (status: number) => json({ error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', message: 'Unavailable' } }, status);
const input = (overrides: Record<string, unknown> = {}) => ({ threadId: 'thread-1', runId: 'ui-run-1', messages: [{ id: 'user-1', role: 'user', content: 'Refund order 7' }], ...overrides });
const request = (body: unknown, token = 'alice', headers: Record<string, string> = {}, signal?: AbortSignal) => new Request(`${origin}/ag-ui`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
});
async function read(response: Response): Promise<AgUiEvent[]> {
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  return (await response.text()).split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.replace(/^data: /, '')) as AgUiEvent);
}
function fixture(mode: 'approval' | 'success' | 'blocked' | 'gap' | 'silent' = 'approval') {
  let status = mode === 'success' ? 'succeeded' : ['blocked', 'gap', 'silent'].includes(mode) ? 'running' : 'waiting';
  let exists = false; let denied = false; let terminal = false; let gap = mode === 'gap';
  const approval = { callId: 'c1', toolId: 'refund', toolVersion: '1', input: { order: 7 }, digest: 'a'.repeat(64), expiresAtMs: Date.now() + 60_000 };
  const entries: RemoteThreadEntry[] = [];
  const calls: { method: string; path: string; body: any; headers: Headers }[] = [];
  const entry = (data: object) => entries.push({ sequence: entries.length + 1, turnId, createdAt: new Date().toISOString(), ...data } as RemoteThreadEntry);
  const finish = (result: string = 'succeeded') => {
    if (terminal) return; terminal = true; status = result;
    entry({ kind: 'user', content: { message: 'Refund order 7' } });
    if (mode === 'approval') {
      entry({ kind: 'tool_calls', calls: [{ id: 'c1', toolId: 'refund', input: { order: 7 } }] });
      if (result === 'succeeded') entry({ kind: 'tool_result', callId: 'c1', toolId: 'refund', result: { refunded: true } });
    }
    if (result === 'succeeded') entry({ kind: 'assistant', output: 'Refunded' });
    entry({ kind: 'run', runId: nativeId, status: result });
  };
  const thread = () => ({ id: 'thread-1', agentId: 'support', title: null, metadata: {}, status: 'active', version: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), entryCount: entries.length, lastSequence: entries.length, activeTurnId: terminal ? null : turnId });
  const sse = (sequence: number, type: string, metadata: object) => `id: ${sequence}\nevent: ${type}\ndata: ${JSON.stringify({ runId: nativeId, sequence, timestamp: new Date().toISOString(), type, metadata })}\n\n`;
  const serve = vi.fn(async (req: Request): Promise<Response> => {
    const url = new URL(req.url); const path = url.pathname; const body = req.body ? await req.json() : undefined;
    calls.push({ method: req.method, path, body, headers: req.headers });
    if (path === '/v1/session') return json({ session: { scope: { principalId: req.headers.get('authorization') === 'Bearer bob' ? 'bob' : 'alice', projectId: 'shop' },
      agentIds: ['support'], capabilities: ['runs:read', 'runs:submit', 'runs:approve', 'threads:read', 'threads:write'],
      expiresAtMs: Date.now() + 60_000, features: ['threads', 'runRecords', 'runApprovals'] } });
    if (denied) return error(403);
    if (path === '/v1/threads' && req.method === 'POST') { exists = true; return json({ thread: thread() }, 201); }
    if (path === '/v1/threads/thread-1') return exists ? json({ thread: thread() }) : error(404);
    if (path === '/v1/threads/thread-1/entries') return json({ entries: entries.filter(item => item.sequence > Number(url.searchParams.get('after') ?? 0)).slice(0, Number(url.searchParams.get('limit') ?? 100)) });
    if (path === '/v1/runs' && req.method === 'POST') {
      if (!entries.length) entry({ kind: 'run', runId: nativeId, status: 'running', recording: true });
      if (mode === 'success') finish(); return json({ id: nativeId, profile: 'ephemeral' }, 202);
    }
    if (path === `/v1/runs/${nativeId}/approvals`) {
      if (status !== 'waiting') return error(409);
      finish((body as any).decision === 'approved' ? 'succeeded' : 'blocked');
      return json({ id: nativeId, profile: 'ephemeral' });
    }
    if (path === `/v1/runs/${nativeId}`) return json({ id: nativeId, status, budget: { spentMicros: 12, reservedMicros: 0, calls: 1 }, evidence: [],
      ...(status === 'waiting' ? { approval } : {}),
      ...(terminal ? { outcome: status === 'succeeded' ? { status, output: 'Refunded' } : { status, error: { code: 'PERMISSION_DENIED' } } } : {}) });
    if (path === `/v1/runs/${nativeId}/events`) {
      if (mode === 'silent') return new Response(new ReadableStream({ start(controller) { req.signal.addEventListener('abort', () => controller.close(), { once: true }); } }), { headers: { 'content-type': 'text/event-stream' } });
      if (gap) return new Response(sse(3, 'events.gap', { from: 1, to: 3 }), { headers: { 'content-type': 'text/event-stream' } });
      if (mode === 'blocked') {
        let index = 0;
        const frames = [sse(1, 'output.delta', { step: 0, modelCall: 0, index: 0, text: 'PRIVATE_PROVISIONAL' }), sse(2, 'output.withheld', { step: 0, modelCall: 0 }), sse(3, 'run.completed', { status: 'blocked' })];
        return new Response(new ReadableStream({ pull(controller) { if (index === 2) finish('blocked'); const frame = frames[index++];
          if (frame) controller.enqueue(new TextEncoder().encode(frame)); else controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(sse(1, 'approval.requested', { callId: approval.callId, toolId: approval.toolId, digest: approval.digest, expiresAtMs: approval.expiresAtMs }), { headers: { 'content-type': 'text/event-stream' } });
    }
    return error(404);
  });
  const options: AgUiAdapterOptions = { server: { fetch: serve }, publicOrigin: origin, agentId: 'support', interruptKey: secret,
    permissions: { allow: ['ag-ui:serve'] }, input: message => ({ message: message.content }) };
  const create = (changes: Partial<AgUiAdapterOptions> = {}) => { const adapter = createAgUiAdapter({ ...options, ...changes }); adapters.push(adapter); return adapter; };
  return { create, serve, calls, approval, entries, finish, deny: () => { denied = true; }, setGap: () => { gap = true; },
    submits: () => calls.filter(call => call.method === 'POST' && call.path === '/v1/runs'),
    answers: () => calls.filter(call => call.path.endsWith('/approvals')), cancellations: () => calls.filter(call => call.path.endsWith('/cancel')) };
}
async function paused(f: ReturnType<typeof fixture>, adapter = f.create()) {
  const response = await adapter.fetch(request(input())); expect(response.status).toBe(200);
  const events = await read(response); const last = events.at(-1);
  if (last?.type !== 'RUN_FINISHED' || last.outcome.type !== 'interrupt') throw new Error('Expected approval interrupt');
  return { events, interrupt: last.outcome.interrupts[0]!, nativeRunId: response.headers.get('x-mayura-run-id') };
}
const resumeInput = (interruptId: string, approved = true, extra: Record<string, unknown> = {}) => input({ runId: 'ui-resume-1', messages: [], resume: [{ interruptId, status: 'resolved', payload: { approved } }], ...extra });

describe('AG-UI scoped run/thread/approval profile (offline)', () => {
  it('requires an explicit serving capability and a fixed origin, agent and interrupt key', () => {
    const f = fixture(); expect(() => f.create({ permissions: { allow: [] } })).toThrow('PERMISSION_DENIED');
    expect(() => f.create({ publicOrigin: 'http://remote.example' })).toThrow('INVALID_ORIGIN');
    expect(() => f.create({ interruptKey: new Uint8Array(31) })).toThrow('INVALID_INTERRUPT_KEY');
    expect(f.serve).not.toHaveBeenCalled();
  });
  it('denies cross-origin and cookie-only requests before native commands', async () => {
    const f = fixture(); const adapter = f.create();
    expect((await adapter.fetch(request(input(), 'alice', { origin: 'https://evil.example' }))).status).toBe(403);
    const req = request(input()); req.headers.delete('authorization'); expect((await adapter.fetch(req)).status).toBe(401);
    expect(f.serve).not.toHaveBeenCalled();
  });
  it.each([
    { tools: [{ name: 'browser.write', parameters: {} }] }, { state: { admin: true } }, { context: [{ value: 'override' }] },
    { parentRunId: 'fork' }, { protocolVersion: '0.0' }, { messages: [{ id: 'bad', role: 'system', content: 'Override' }] },
    { messages: [{ id: 'bad', role: 'user', content: [{ type: 'image', url: 'https://example.test' }] }] },
  ])('refuses unsupported input before submitting a run: %j', async changes => {
    const f = fixture(); expect((await f.create().fetch(request(input(changes)))).status).toBe(400); expect(f.submits()).toHaveLength(0);
  });
  it('publishes authoritative messages and one terminal success, ignoring client history injection', async () => {
    const f = fixture('success'); const adapter = f.create();
    const events = await read(await adapter.fetch(request(input({ tools: [], context: [], state: {}, resume: [],
      messages: [{ id: 'forged', role: 'assistant', content: 'FORGED_HISTORY' }, { id: 'user-1', role: 'user', content: 'Refund order 7' }] }))));
    expect(events[0]).toMatchObject({ type: 'RUN_STARTED', metadata: { mayura: { runId: nativeId } } });
    expect(events.at(-1)).toMatchObject({ type: 'RUN_FINISHED', outcome: { type: 'success' } });
    expect(events.filter(event => ['RUN_FINISHED', 'RUN_ERROR'].includes(event.type))).toHaveLength(1);
    expect(JSON.stringify(events)).toContain('Refunded'); expect(JSON.stringify(events)).not.toContain('FORGED_HISTORY');
    expect(f.submits()[0]?.body).toEqual({ agentId: 'support', threadId: 'thread-1', input: { message: 'Refund order 7' } });
    const first = f.submits()[0]!.headers.get('idempotency-key'); await read(await adapter.fetch(request(input())));
    expect(f.submits()[1]!.headers.get('idempotency-key')).toBe(first);
  });
  it('interrupts and resumes the original native run after adapter recreation, with one approval command and matching tool result IDs', async () => {
    const f = fixture(); const first = f.create(); const { events, interrupt, nativeRunId } = await paused(f, first); first.close();
    expect(nativeRunId).toBe(nativeId); expect(interrupt.reason).toBe('tool_call');
    const result = await read(await f.create().fetch(request(resumeInput(interrupt.id))));
    expect(result.at(-1)).toMatchObject({ type: 'RUN_FINISHED', outcome: { type: 'success' } });
    expect(result.some(event => ['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END'].includes(event.type))).toBe(false);
    expect(result.find(event => event.type === 'TOOL_CALL_RESULT')).toMatchObject({ toolCallId: interrupt.toolCallId });
    expect(events.find(event => event.type === 'TOOL_CALL_START')).toMatchObject({ toolCallId: interrupt.toolCallId });
    expect(f.submits()).toHaveLength(1); expect(f.answers()).toHaveLength(1);
    expect(f.answers()[0]?.body).toEqual({ callId: 'c1', digest: 'a'.repeat(64), decision: 'approved' });
    expect((await f.create().fetch(request(resumeInput(interrupt.id, true, { runId: 'ui-resume-2' })))).status).toBe(409);
    expect(f.answers()).toHaveLength(1);
  });
  it.each(['owner', 'thread', 'agent', 'key', 'tampered', 'same-run', 'expired', 'changed-digest'] as const)('refuses %s resume without claiming', async change => {
    const f = fixture(); const { interrupt } = await paused(f); let token = 'alice'; let id = interrupt.id; let extra = {}; let options: Partial<AgUiAdapterOptions> = {};
    if (change === 'owner') token = 'bob';
    if (change === 'thread') extra = { threadId: 'other-thread' };
    if (change === 'agent') options = { agentId: 'other-agent' };
    if (change === 'key') options = { interruptKey: new Uint8Array(32).fill(8) };
    if (change === 'tampered') id = `${id.slice(0, -8)}AAAAAAAA`;
    if (change === 'same-run') extra = { runId: 'ui-run-1' };
    if (change === 'expired') { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 120_000); }
    if (change === 'changed-digest') f.approval.digest = 'b'.repeat(64);
    expect((await f.create(options).fetch(request(resumeInput(id, true, extra), token))).status).toBe(change === 'agent' ? 403 : 409);
    expect(f.answers()).toHaveLength(0);
  });
  it('rejects tool argument edits and actor impersonation before claiming', async () => {
    const f = fixture(); const { interrupt } = await paused(f);
    const body = resumeInput(interrupt.id); ((body as unknown as { resume: any[] }).resume)[0].payload = { approved: true, input: { order: 999 }, actorId: 'admin' };
    expect((await f.create().fetch(request(body))).status).toBe(400); expect(f.answers()).toHaveLength(0);
  });
  it('maps a cancelled interrupt to native rejection without cancelling or resubmitting the run', async () => {
    const f = fixture(); const { interrupt } = await paused(f);
    const result = await read(await f.create().fetch(request(input({ runId: 'rejection', messages: [], resume: [{ interruptId: interrupt.id, status: 'cancelled' }] }))));
    expect(result.at(-1)).toMatchObject({ type: 'RUN_ERROR', code: 'RUN_BLOCKED' });
    expect(f.answers()[0]?.body.decision).toBe('rejected'); expect(f.submits()).toHaveLength(1); expect(f.cancellations()).toHaveLength(0);
  });
  it('does not retry an uncertain approval write or expose private exceptions', async () => {
    const f = fixture(); const { interrupt } = await paused(f); const base = f.serve;
    const write = vi.fn(async (req: Request) => { if (req.url.endsWith('/approvals')) throw new Error('PRIVATE_CREDENTIAL'); return base(req); });
    const response = await f.create({ server: { fetch: write } }).fetch(request(resumeInput(interrupt.id)));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('PRIVATE_CREDENTIAL');
    expect(write.mock.calls.filter(([req]) => req.url.endsWith('/approvals'))).toHaveLength(1);
  });
  it('stops disclosure after authorization revocation between frames', async () => {
    const f = fixture('success'); const response = await f.create().fetch(request(input())); const reader = response.body!.getReader();
    const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toContain('RUN_STARTED'); f.deny();
    const second = await reader.read(); const data = new TextDecoder().decode(second.value);
    expect(data).toContain('RUN_ERROR'); expect(data).not.toContain('Refunded'); expect((await reader.read()).done).toBe(true);
  });
  it('fails visibly on event gaps and never reconnects silently', async () => {
    const f = fixture('gap'); const events = await read(await f.create().fetch(request(input())));
    expect(events.at(-1)).toMatchObject({ type: 'RUN_ERROR', code: 'EVENT_GAP' });
    expect(f.calls.filter(call => call.path.endsWith('/events'))).toHaveLength(1);
  });
  it('does not leak provisional deltas when the final output is withheld', async () => {
    const f = fixture('blocked'); const events = await read(await f.create().fetch(request(input())));
    expect(events.at(-1)).toMatchObject({ type: 'RUN_ERROR', code: 'RUN_BLOCKED' });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_PROVISIONAL'); expect(events.some(event => event.type === 'TEXT_MESSAGE_CONTENT')).toBe(false);
  });
  it('cancelling an observer frees capacity without cancelling native execution', async () => {
    const f = fixture('silent'); const adapter = f.create({ limits: { maxConcurrentStreams: 1 } });
    const response = await adapter.fetch(request(input()));
    expect((await adapter.fetch(request(input({ runId: 'second' })))).status).toBe(429);
    await response.body!.cancel();
    const next = await adapter.fetch(request(input({ runId: 'second' }))); expect(next.status).toBe(200); await next.body!.cancel();
    expect(f.cancellations()).toHaveLength(0);
  });
  it('keeps a quiet connection alive without reconnecting or starting another generator read', async () => {
    vi.useFakeTimers(); const f = fixture('silent'); const adapter = f.create();
    const response = await adapter.fetch(request(input())); const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('RUN_STARTED');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('MESSAGES_SNAPSHOT');
    const next = reader.read(); await vi.advanceTimersByTimeAsync(15_001);
    expect(new TextDecoder().decode((await next).value)).toBe(': keep-alive\n\n');
    expect(f.calls.filter(call => call.path.endsWith('/events'))).toHaveLength(1);
    await reader.cancel(); expect(f.cancellations()).toHaveLength(0);
  });
  it('reserves a single terminal error frame when outgoing capacity is exhausted', async () => {
    const f = fixture('success'); const result = await read(await f.create({ limits: { maxEvents: 2 } }).fetch(request(input())));
    expect(result.map(event => event.type)).toEqual(['RUN_STARTED', 'RUN_ERROR']);
    expect(result.at(-1)).toMatchObject({ code: 'STREAM_OUTPUT_LIMIT' }); expect(f.cancellations()).toHaveLength(0);
  });
  it('bounds unread stream lifetime and frees capacity', async () => {
    vi.useFakeTimers(); const f = fixture('silent'); const adapter = f.create({ limits: { maxConcurrentStreams: 1, durationMs: 100 } });
    const first = await adapter.fetch(request(input())); await vi.advanceTimersByTimeAsync(101);
    expect(await first.text()).toContain('DURATION_LIMIT');
    const next = await adapter.fetch(request(input({ runId: 'next' }))); expect(next.status).toBe(200); await next.body!.cancel();
    expect(f.cancellations()).toHaveLength(0);
  });
  it('requires the independent state serving permission before invoking a source', () => {
    const f = fixture(); const read = vi.fn(() => ({ revision: 0, state: {} }));
    expect(() => f.create({ state: { read } })).toThrow('PERMISSION_DENIED'); expect(read).not.toHaveBeenCalled();
  });
  it('sends an authoritative snapshot then bounded deltas while ignoring browser state as input', async () => {
    const f = fixture('success'); let reads = 0;
    const source = vi.fn((ctx: AgUiStateContext) => ({ revision: reads++ === 0 ? 0 : 1, state: { owner: ctx.scope.principalId, status: reads === 1 ? 'opening' : 'settled' } }));
    const adapter = f.create({ permissions: { allow: ['ag-ui:serve', 'ag-ui:state'] }, state: { read: source } });
    const events = await read(await adapter.fetch(request(input({ state: { admin: true } }))));
    expect(events[0]?.type).toBe('RUN_STARTED');
    expect(events[1]).toMatchObject({ type: 'STATE_SNAPSHOT', snapshot: { owner: 'alice', status: 'opening' }, metadata: { mayura: { stateRevision: 0 } } });
    expect(events.find(event => event.type === 'STATE_DELTA')).toMatchObject({ delta: [{ op: 'replace', path: '/status', value: 'settled' }] });
    expect(f.submits()[0]?.body.input).toEqual({ message: 'Refund order 7' }); expect(JSON.stringify(events)).not.toContain('admin');
    expect(source.mock.calls[0]?.[0]).not.toHaveProperty('state');
    expect(events.at(-1)).toMatchObject({ type: 'RUN_FINISHED', outcome: { type: 'success' } });
  });
  it('resynchronizes a resumed approval segment with a snapshot before applying later deltas', async () => {
    const f = fixture(); const adapter = f.create({ permissions: { allow: ['ag-ui:serve', 'ag-ui:state'] },
      state: { read: () => ({ revision: f.answers().length, state: { approved: f.answers().length > 0 } }) } });
    const { interrupt } = await paused(f, adapter);
    const events = await read(await adapter.fetch(request(resumeInput(interrupt.id, true, { state: null }))));
    expect(events[1]).toMatchObject({ type: 'STATE_SNAPSHOT', snapshot: { approved: false } });
    expect(events.find(event => event.type === 'STATE_DELTA')).toMatchObject({ delta: [{ op: 'replace', path: '/approved', value: true }] });
    expect(f.answers()).toHaveLength(1); expect(f.submits()).toHaveLength(1);
  });
  it('fails before paid submission if initial state cannot be read', async () => {
    const f = fixture('success'); const adapter = f.create({ permissions: { allow: ['ag-ui:serve', 'ag-ui:state'] },
      state: { read: () => { throw new Error('PRIVATE_STATE_CREDENTIAL'); } } });
    const response = await adapter.fetch(request(input())); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('PRIVATE_STATE_CREDENTIAL'); expect(f.submits()).toHaveLength(0);
  });
  it('fails before claiming an approval if state disclosure is denied', async () => {
    const f = fixture(); const { interrupt } = await paused(f);
    const adapter = f.create({ permissions: { allow: ['ag-ui:serve', 'ag-ui:state'] }, state: {
      read: () => { throw new Error('STATE_READ_SHOULD_NOT_RUN'); },
      authorization: { require: async () => { throw new Error('PRIVATE_POLICY'); } } as any,
    } });
    expect((await adapter.fetch(request(resumeInput(interrupt.id)))).status).toBe(403); expect(f.answers()).toHaveLength(0);
  });
  it('rechecks state policy immediately before snapshot disclosure', async () => {
    const f = fixture('success'); let allowed = true;
    const adapter = f.create({ permissions: { allow: ['ag-ui:serve', 'ag-ui:state'] }, state: {
      read: () => ({ revision: 0, state: { private: 'STATE_SECRET' } }),
      authorization: { require: async () => { if (!allowed) throw new Error('denied'); } } as any,
    } });
    const response = await adapter.fetch(request(input())); const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('RUN_STARTED'); allowed = false;
    const frame = new TextDecoder().decode((await reader.read()).value);
    expect(frame).toContain('STATE_ACCESS_DENIED'); expect(frame).not.toContain('STATE_SECRET');
  });
  it('observes state changes during a quiet run without native reconnection or write replay', async () => {
    vi.useFakeTimers(); const f = fixture('silent'); let revision = 0;
    const adapter = f.create({ permissions: { allow: ['ag-ui:serve', 'ag-ui:state'] }, state: { read: () => ({ revision, state: { progress: revision } }) } });
    const response = await adapter.fetch(request(input())); const reader = response.body!.getReader();
    for (let index = 0; index < 3; index++) await reader.read(); // RUN_STARTED, STATE_SNAPSHOT, MESSAGES_SNAPSHOT.
    revision = 1; const next = reader.read(); await vi.advanceTimersByTimeAsync(15_001);
    expect(new TextDecoder().decode((await next).value)).toContain('STATE_DELTA');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(': keep-alive\n\n');
    expect(f.calls.filter(call => call.path.endsWith('/events'))).toHaveLength(1);
    await reader.cancel(); expect(f.cancellations()).toHaveLength(0); expect(f.submits()).toHaveLength(1);
  });
  it('refuses incomplete/oversized histories and bounds requests before paid submission', async () => {
    const f = fixture('success'); const adapter = f.create({ limits: { maxRequestBytes: 256 } });
    expect((await adapter.fetch(request(input({ messages: [{ id: 'huge', role: 'user', content: 'x'.repeat(300) }] })))).status).toBe(413);
    expect(f.submits()).toHaveLength(0);
    await read(await f.create().fetch(request(input())));
    const limited = await f.create({ limits: { maxThreadEntries: 1 } }).fetch(request(input({ runId: 'next' })));
    expect(limited.status).toBe(413); expect(f.submits()).toHaveLength(1);
  });
});


it('requires separate guarded-stream/media grants and emits only native batch releases under opt-in',async () => {
  const fixtureState=fixture('blocked');
  expect(() => fixtureState.create({ streaming:'guarded' })).toThrow('PERMISSION_DENIED');
  expect(() => fixtureState.create({ media:true })).toThrow('PERMISSION_DENIED');
  const adapter=fixtureState.create({ streaming:'guarded',permissions:{ allow:['ag-ui:serve','ag-ui:stream'] } });
  const frames=await read(await adapter.fetch(request(input())));
  expect(frames.filter(frame => frame.type === 'TEXT_MESSAGE_CONTENT')).toHaveLength(1);
  expect(frames.some(frame => frame.type === 'CUSTOM' && frame.name === 'mayura.output.withheld')).toBe(true);
  expect(frames.filter(frame => frame.type === 'TEXT_MESSAGE_END')).toHaveLength(1);
  expect(frames.at(-1)?.type).toBe('RUN_ERROR');
  expect(fixtureState.submits()).toHaveLength(1);
});
