import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecoveryController, type ConversationRecoveryOptions } from '../src/conversation-recovery.js';

const controllers: ReturnType<typeof createRecoveryController>[] = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.stop()); vi.useRealTimers(); });
const options = (): ConversationRecoveryOptions => ({ permissions: { allow: ['conversations:recover'] }, authorize: async () => true });
const row = { runId: 'run-1', expiresAtMs: 1 };
function fixture(overrides: Partial<Parameters<typeof createRecoveryController>[1]> = {}, settings: ConversationRecoveryOptions | undefined = options()) {
  const hooks = { scan: vi.fn(async () => [row]), process: vi.fn(async (id: string) => ({ id, status: 'recovered' as const })), timeoutMs: 500, ...overrides };
  const controller = createRecoveryController(settings, hooks); controllers.push(controller); return { controller, hooks };
}

describe('bounded host conversation recovery', () => {
  it('validates cursors, page sizes and adapter replies before processing', async () => {
    const { controller, hooks } = fixture();
    await expect(controller.recover({ limit: 101 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(hooks.scan).not.toHaveBeenCalled();
    const report = await controller.recover({ limit: 1 }); expect(report.next).toEqual(row);
    const forged = fixture({ scan: async () => [row, row] });
    await expect(forged.controller.recover({ limit: 1 })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(forged.hooks.process).not.toHaveBeenCalled();
  });

  it('retains the non-overlap slot until an aborted adapter settles and never processes its late result', async () => {
    let release!: (rows: typeof row[]) => void;
    const { controller, hooks } = fixture({ scan: () => new Promise(resolve => { release = resolve; }) });
    const signal = new AbortController(); const pending = controller.recover({ signal: signal.signal }); await Promise.resolve();
    signal.abort(); await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(controller.recover()).rejects.toMatchObject({ code: 'CONFLICT' });
    release([row]); await Promise.resolve(); await Promise.resolve();
    expect(hooks.process).not.toHaveBeenCalled();
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    await expect(controller.recover({ signal: alreadyAborted.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('bounds storage waits, sanitizes failures and continues past per-item failures', async () => {
    vi.useFakeTimers();
    const stalled = fixture({ scan: () => new Promise(() => {}) });
    const pending = stalled.controller.recover(); const assertion = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(501); await assertion;
    const broken = fixture({ process: async () => { throw new Error('PRIVATE_CREDENTIALS'); } });
    expect(await broken.controller.recover()).toEqual({ outcomes: [{ id: 'run-1', status: 'retry', code: 'STORAGE_UNAVAILABLE' }], next: null });
  });

  it('advances scheduled pages and restarts the sweep, stopping permanently on close', async () => {
    vi.useFakeTimers(); let pages = 0;
    const { controller, hooks } = fixture({ scan: vi.fn(async () => ++pages === 1 ? [row] : []) }, { ...options(), intervalMs: 100, pageSize: 1 });
    await vi.advanceTimersByTimeAsync(300);
    expect(hooks.scan).toHaveBeenNthCalledWith(1, undefined, 1);
    expect(hooks.scan).toHaveBeenNthCalledWith(2, row, 1);
    expect(hooks.scan).toHaveBeenNthCalledWith(3, undefined, 1);
    controller.stop(); await vi.advanceTimersByTimeAsync(500); expect(hooks.scan).toHaveBeenCalledTimes(3);
    await expect(controller.recover()).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
