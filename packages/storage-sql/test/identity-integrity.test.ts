import { describe, expect, it, vi } from 'vitest';
import { createCommand, identifier, submissionDigest } from '../src/validation.js';
import { schedulerFacade } from '../src/scheduler-validation.js';

const malformed = ['\ud800', '\udfff', 'a\ud800b', '\udc00\ud800', '\ud800\ud800', '\udc00\udc00', '\ud83d\ude80\ud800', '\ud800\ud83d\ude80'];

describe('SQL identity UTF-16 integrity', () => {
  it.each(malformed)('rejects an unpaired surrogate before lossy UTF-8 encoding (%#)', value => {
    expect(() => identifier(value, 'Identity')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('preserves valid pairs at the byte boundary and does not normalize identities', () => {
    for (const value of ['\ud83d\ude80'.repeat(64), '\ud800\udc00', '\udbff\udfff', '\ufffd', 'é', 'e\u0301', ' identity ']) {
      expect(identifier(value, 'Identity')).toBe(value);
    }
    expect(() => identifier('\ud83d\ude80'.repeat(64) + 'x', 'Identity')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => identifier('é'.repeat(129), 'Identity')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('leaves JSON payload surrogate escapes and canonical identity distinctions unchanged', () => {
    const command = { scope: 'scope', id: 'id', idempotencyKey: 'key', definitionHash: 'hash',
      state: { text: '\ud800', '\udfff': '\udc00' }, events: [{ type: 'event', data: { text: '\udfff' } }] };
    expect(createCommand(command)).toEqual(command);
    expect(submissionDigest(createCommand(command))).not.toBe(submissionDigest(createCommand({ ...command, state: { text: '\ufffd' } })));
    expect(submissionDigest(createCommand({ ...command, id: 'é' }))).not.toBe(submissionDigest(createCommand({ ...command, id: 'e\u0301' })));
  });

  it('rejects all aggregate identity fields and event types without echoing the malformed value', () => {
    const command = { scope: 'scope', id: 'id', idempotencyKey: 'key', definitionHash: 'hash', state: {}, events: [] };
    const value = 'DO_NOT_ECHO_\ud800';
    for (const field of ['scope', 'id', 'idempotencyKey', 'definitionHash']) {
      expect(() => createCommand({ ...command, [field]: value })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
      expect(() => createCommand({ ...command, [field]: value })).not.toThrow('DO_NOT_ECHO_');
    }
    expect(() => createCommand({ ...command, events: [{ type: value, data: {} }] })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('rejects malformed scheduler identities before invoking its database or worker transport', async () => {
    const request = vi.fn(async () => undefined);
    const scheduler = schedulerFacade(request);
    await expect(scheduler.read({ scope: 'scope', jobId: '\ud800' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(scheduler.claim({ scope: 'scope', workerId: '\udfff', limit: 1, leaseMs: 1_000 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(scheduler.reserve({ scope: 'scope', jobId: 'job', reservationKey: 'key', runId: 'run', nodeId: 'node', invocationId: 'invoke',
      definitionHash: 'a'.repeat(64), candidateHash: 'b'.repeat(64), intent: { toolId: 'tool', callId: 'call' }, resourceKeys: ['resource-\ud800'], delayMs: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(request).not.toHaveBeenCalled();
  });
});
