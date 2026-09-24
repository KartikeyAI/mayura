import { describe, expect, it, vi } from 'vitest';
import { composeExternalEffectVerifiers, defineExternalEffectVerifier, type ExternalEffectReconciliationRequest } from '../src/index.js';

const request = Object.freeze({ runId: 'run', definitionHash: 'a'.repeat(64), nodeId: 'write', jobId: 'job', fence: 1,
  callId: 'run/step:write', toolId: 'payments.capture', toolVersion: '1', maximumCostMicros: 10,
  scope: Object.freeze({ principalId: 'alice', projectId: 'project' }) }) satisfies ExternalEffectReconciliationRequest;

describe('external-effect verifier composition', () => {
  it('routes an exact tool version and binds the configured authority', async () => {
    const verify = vi.fn(async (_request: ExternalEffectReconciliationRequest, credential: unknown) => {
      expect(credential).toBe('SECRET-provider-credential');
      return { attestationId: 'payment/pi_123', execution: 'succeeded' as const, knownCostMicros: 4 };
    });
    const definition = defineExternalEffectVerifier({ authorityId: 'payments.example', toolId: 'payments.capture', toolVersion: '1', verify });
    expect(Object.isFrozen(definition)).toBe(true);
    const router = composeExternalEffectVerifiers([definition]);
    await expect(router(request, 'SECRET-provider-credential')).resolves.toEqual({ authorityId: 'payments.example',
      attestationId: 'payment/pi_123', execution: 'succeeded', knownCostMicros: 4 });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('rejects missing, duplicate and forged routes before credential dispatch', async () => {
    const first = defineExternalEffectVerifier({ authorityId: 'payments.a', toolId: 'payments.capture', toolVersion: '1',
      verify: async () => ({ attestationId: 'a', execution: 'failed', knownCostMicros: 0 }) });
    const duplicate = defineExternalEffectVerifier({ authorityId: 'payments.b', toolId: 'payments.capture', toolVersion: '1',
      verify: async () => ({ attestationId: 'b', execution: 'failed', knownCostMicros: 0 }) });
    expect(() => composeExternalEffectVerifiers([first, duplicate])).toThrow();
    expect(() => composeExternalEffectVerifiers([{ authorityId: 'forged', toolId: 'payments.capture', toolVersion: '1' }])).toThrow();
    const router = composeExternalEffectVerifiers([first]);
    await expect(router({ ...request, toolVersion: '2' }, 'SECRET-never-forwarded')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it.each([
    { attestationId: 'event', execution: 'not_started', knownCostMicros: 1 },
    { attestationId: 'event', execution: 'succeeded', knownCostMicros: 11 },
    { attestationId: 'event', execution: 'unknown', knownCostMicros: 0 },
    { attestationId: 'event', execution: 'failed', knownCostMicros: 0, extra: true },
  ])('fails closed on malformed provider attestation %#', async result => {
    const verifier = defineExternalEffectVerifier({ authorityId: 'payments.example', toolId: 'payments.capture', toolVersion: '1',
      verify: async () => result as never });
    await expect(composeExternalEffectVerifiers([verifier])(request, null)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('rejects accessor-bearing configuration and result objects without invoking getters', async () => {
    const configurationGetter = vi.fn();
    const hostileConfiguration = Object.defineProperty({ authorityId: 'payments.example', toolId: 'payments.capture', toolVersion: '1' },
      'verify', { enumerable: true, get: configurationGetter });
    expect(() => defineExternalEffectVerifier(hostileConfiguration as never)).toThrow(); expect(configurationGetter).not.toHaveBeenCalled();
    const resultGetter = vi.fn();
    const verifier = defineExternalEffectVerifier({ authorityId: 'payments.example', toolId: 'payments.capture', toolVersion: '1',
      verify: async () => Object.defineProperty({ attestationId: 'event', execution: 'failed' }, 'knownCostMicros',
        { enumerable: true, get: resultGetter }) as never });
    await expect(composeExternalEffectVerifiers([verifier])(request, null)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(resultGetter).not.toHaveBeenCalled();

    const requestGetter = vi.fn(); const provider = vi.fn();
    const safeVerifier = defineExternalEffectVerifier({ authorityId: 'payments.safe', toolId: 'payments.capture', toolVersion: '1', verify: provider });
    const hostileRequest = Object.defineProperty({ ...request }, 'toolId', { enumerable: true, get: requestGetter });
    await expect(composeExternalEffectVerifiers([safeVerifier])(hostileRequest as never, 'SECRET-never-forwarded'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(requestGetter).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
  });
});
