import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgUiFrontendExecutor } from '../src/index.js';
const origin = 'https://agents.example.test'; const token = 'a'.repeat(43); const claimId = 'b'.repeat(43);
afterEach(() => vi.useRealTimers());
function fixture() {
  const expiresAtMs = Date.now() + 60_000;
  const call = { toolCallId: 'wire-c1', toolCallName: 'ui.select', metadata: { mayura: { frontend: { token, expiresAtMs, claimPath: '/ag-ui/frontend-tools/claim' } } } };
  const handler = vi.fn(async () => ({ selected: 7 }));
  const transport = vi.fn(async (_target: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ name: 'ui.select', toolCallId: 'wire-c1', input: { item: 7 }, claimId, expiresAtMs }), { headers: { 'content-type': 'application/json' } }));
  const create = () => createAgUiFrontendExecutor({ publicOrigin: origin, token: () => 'local', permissions: { allow: ['ag-ui:frontend-execute', 'frontend:ui.select'] }, handlers: { 'ui.select': handler }, fetch: transport });
  return { create, call, handler, transport };
}
describe('one-shot browser frontend executor', () => {
  it('claims before execution and returns JSON result plus scoped continuation without submitting another run', async () => {
    const f = fixture(); const result = await f.create().execute(f.call);
    expect(f.transport).toHaveBeenCalledTimes(1); expect(f.transport.mock.calls[0]?.[0]?.toString()).toBe(`${origin}/ag-ui/frontend-tools/claim`);
    expect(f.handler).toHaveBeenCalledWith({ item: 7 }, expect.objectContaining({ executionId: expect.stringMatching(/^[a-f0-9]{64}$/), signal: expect.any(AbortSignal) }));
    expect(result.message).toMatchObject({ role: 'tool', content: '{"selected":7}', toolCallId: 'wire-c1' }); expect(result.forwardedProps).toEqual({ mayuraFrontend: { token, claimId } });
  });
  it('does not retry a lost claim reply, a consumed token, or a mismatched server call', async () => {
    const f = fixture(); f.transport.mockRejectedValueOnce(new Error('PRIVATE_TRANSPORT')); const executor = f.create();
    await expect(executor.execute(f.call)).rejects.toMatchObject({ code: 'FRONTEND_EXECUTION_UNCERTAIN' });
    await expect(executor.execute(f.call)).rejects.toMatchObject({ code: 'FRONTEND_EXECUTOR_LIMIT' }); expect(f.handler).not.toHaveBeenCalled(); expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it('normalizes handler exceptions without publishing stack traces or secrets', async () => {
    const f = fixture(); f.handler.mockRejectedValueOnce(new Error('PRIVATE_BROWSER_SECRET'));
    const result = await f.create().execute(f.call); expect(result.message).toMatchObject({ content: 'null', error: 'FRONTEND_TOOL_FAILED' }); expect(JSON.stringify(result)).not.toContain('PRIVATE_BROWSER_SECRET');
  });
  it('holds capacity after cancellation until an uncooperative handler really settles', async () => {
    const f = fixture(); let entered!: () => void; const ready = new Promise<void>(yes => { entered = yes; });
    f.handler.mockImplementationOnce(() => { entered(); return new Promise<{ selected: number }>(() => {}); });
    const controller = new AbortController(); const pending = f.create().execute(f.call, { signal: controller.signal }); await ready; controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'FRONTEND_EXECUTION_UNCERTAIN' }); expect(f.handler).toHaveBeenCalledTimes(1);
  });
});
