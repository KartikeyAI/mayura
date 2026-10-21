import type { RemoteSession } from '@mayura/client';
import { fromBase64Url, toBase64Url } from '@mayura/core/host';
import { AgUiFailure, boundedJson, fields, identifier, object } from './protocol.js';

/** Opaque continuation binds one approval to its original run and thread; never contains tool arguments. */
export interface InterruptBinding {
  readonly nativeRunId: string; readonly externalRunId: string; readonly threadId: string; readonly turnId: string;
  readonly callId: string; readonly digest: string; readonly expiresAtMs: number; readonly after: number;
}
const prefix = 'mayura-agui1.';
const encoder = new TextEncoder();
/** Host-owned shared secret must survive adapter restarts and be identical on all serving replicas. */
export function interruptCodec(secret: Uint8Array, origin: string, agentId: string) {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) throw new AgUiFailure('INVALID_INTERRUPT_KEY');
  const bytes = Uint8Array.from(secret);
  // Import lazily; no rejected crypto promise is left unobserved during adapter construction.
  let key: Promise<CryptoKey> | undefined;
  const getKey = () => key ??= crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const aad = (session: RemoteSession) => encoder.encode(JSON.stringify(['mayura/ag-ui/1', origin, agentId, session.scope.principalId, session.scope.projectId]));
  return {
    async seal(binding: InterruptBinding, session: RemoteSession): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(session), tagLength: 128 },
        await getKey(), encoder.encode(JSON.stringify(binding)));
      const result = new Uint8Array(iv.length + ciphertext.byteLength); result.set(iv); result.set(new Uint8Array(ciphertext), iv.length);
      return prefix + toBase64Url(result);
    },
    async open(token: string, session: RemoteSession): Promise<InterruptBinding> {
      try {
        if (!token.startsWith(prefix) || token.length > 4096) throw new Error();
        const data = fromBase64Url(token.slice(prefix.length)); if (!data || data.length < 29) throw new Error();
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(data.subarray(0, 12)), additionalData: aad(session), tagLength: 128 },
          await getKey(), Uint8Array.from(data.subarray(12)));
        const raw = object(boundedJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)), 2048));
        fields(raw, ['nativeRunId', 'externalRunId', 'threadId', 'turnId', 'callId', 'digest', 'expiresAtMs', 'after']);
        for (const field of ['nativeRunId', 'externalRunId', 'threadId', 'turnId']) identifier(raw[field]);
        if (typeof raw['callId'] !== 'string' || raw['callId'].length < 1 || raw['callId'].length > 128
          || typeof raw['digest'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['digest'])
          || !Number.isSafeInteger(raw['after']) || (raw['after'] as number) < 0
          || !Number.isSafeInteger(raw['expiresAtMs']) || (raw['expiresAtMs'] as number) <= Date.now()) throw new Error();
        return raw as unknown as InterruptBinding;
      } catch { throw new AgUiFailure('INVALID_INTERRUPT', 409); }
    },
  };
}
