import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowCommandJournal, type WorkflowCommandResult } from '../src/index.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const scope = { principalId: 'operator', projectId: 'project' };
const runId = 'a'.repeat(64);

describe('durable workflow command journal on SQLite', () => {
  let fixture: WorkflowFixture | undefined;
  afterEach(async () => { await fixture?.store.close(); await fixture?.cleanup(); fixture = undefined; });
  const setup = async (clock = { value: 1_000 }) => {
    fixture = await sqliteFixture(); await fixture.store.initialize();
    return { journal: createWorkflowCommandJournal({ store: fixture.store, scope, leaseMs: 5_000, now: () => clock.value }), clock };
  };
  const command = (apply: () => Promise<WorkflowCommandResult>, observe = async () => false, commandId = 'pause-1', request: unknown = { revision: 3 }) =>
    ({ runId, action: 'pause', commandId, request: request as never, observe, apply });

  it('applies a command once and replays its recorded outcome and detail', async () => {
    const { journal } = await setup();
    const apply = vi.fn(async (): Promise<WorkflowCommandResult> => ({ outcome: 'applied', detail: { plan: 'p' } }));
    expect(await journal.run(command(apply))).toEqual({ outcome: 'applied', detail: { plan: 'p' } });
    expect(await journal.run(command(apply))).toEqual({ outcome: 'applied', detail: { plan: 'p' } });
    // The journal survives a new process: a fresh journal over the same store still replays.
    const reopened = createWorkflowCommandJournal({ store: fixture!.store, scope });
    expect(await reopened.run(command(apply))).toEqual({ outcome: 'applied', detail: { plan: 'p' } });
    expect(apply).toHaveBeenCalledOnce();
  });

  it('refuses a reused command id carrying a different request, and records non-applied outcomes too', async () => {
    const { journal } = await setup();
    const apply = vi.fn(async (): Promise<WorkflowCommandResult> => ({ outcome: 'conflict' }));
    expect(await journal.run(command(apply))).toEqual({ outcome: 'conflict' });
    expect(await journal.run(command(apply, undefined, 'pause-1', { revision: 4 }))).toEqual({ outcome: 'conflict' });
    expect(await journal.run(command(apply))).toEqual({ outcome: 'conflict' });
    expect(apply).toHaveBeenCalledOnce();
  });

  it('never applies concurrent duplicates twice', async () => {
    const { journal } = await setup();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const apply = vi.fn(async (): Promise<WorkflowCommandResult> => { await gate; return { outcome: 'applied' }; });
    const first = journal.run(command(apply));
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    // While the first attempt holds its lease, a duplicate is told to re-read instead of applying.
    expect(await journal.run(command(apply))).toEqual({ outcome: 'conflict' });
    release(); expect(await first).toEqual({ outcome: 'applied' });
    expect(await journal.run(command(apply))).toEqual({ outcome: 'applied' });
    expect(apply).toHaveBeenCalledOnce();
  });

  it('takes over an abandoned attempt after its lease and applies only if its effect is not observed', async () => {
    const { journal, clock } = await setup();
    // A process that dies mid-command can neither record an outcome nor release its lease.
    const store = fixture!.store;
    const dying = createWorkflowCommandJournal({ store: { ...store, initialize: () => store.initialize(), create: command => store.create(command), read: (s, id) => store.read(s, id),
      events: (s, id, after) => store.events(s, id, after), close: () => store.close(), update: async () => { throw new Error('process died'); } }, scope, leaseMs: 5_000, now: () => clock.value });
    const effect = vi.fn(async (): Promise<WorkflowCommandResult> => ({ outcome: 'applied' }));
    await expect(dying.run(command(effect))).rejects.toThrow('process died');
    const apply = vi.fn(async (): Promise<WorkflowCommandResult> => ({ outcome: 'applied' }));
    expect(await journal.run(command(apply))).toEqual({ outcome: 'conflict' }); // lease still held
    clock.value += 5_001;
    // The dead attempt's effect is visible: record it as applied without applying again.
    expect(await journal.run(command(apply, async () => true))).toEqual({ outcome: 'applied' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('releases the lease of an attempt that failed, so a retry re-checks and applies at once', async () => {
    const { journal } = await setup();
    await expect(journal.run(command(async () => { throw new Error('transient'); }, undefined, 'resume-1'))).rejects.toThrow('transient');
    const apply = vi.fn(async (): Promise<WorkflowCommandResult> => ({ outcome: 'applied' }));
    expect(await journal.run(command(apply, async () => false, 'resume-1'))).toEqual({ outcome: 'applied' });
    expect(apply).toHaveBeenCalledOnce();
  });

  it('validates its inputs and outcomes', async () => {
    const { journal } = await setup();
    await expect(journal.run({ ...command(async () => ({ outcome: 'applied' })), commandId: '../x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(journal.run(command(async () => ({ outcome: 'maybe' as never }), undefined, 'bad-outcome'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(() => createWorkflowCommandJournal({ store: fixture!.store, scope, leaseMs: 10 })).toThrow();
  });
});
