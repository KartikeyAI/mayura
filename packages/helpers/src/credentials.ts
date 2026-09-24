import { MayuraError } from '@mayura/core';
import { secretReference, type SecretReference } from './configuration.js';

export interface ResolvedCredential {
  /** Ownership transfers to the broker; the provider must not reuse this buffer. */
  readonly bytes: Uint8Array;
  readonly version: string;
  readonly expiresAtMs?: number;
}
export interface CredentialProviderOptions {
  readonly id: string;
  readonly resolve: (reference: { readonly key: string; readonly version?: string }, signal: AbortSignal) => ResolvedCredential | Promise<ResolvedCredential>;
}
/** Public provider identity. The resolver remains private in this package instance. */
export interface CredentialProvider { readonly id: string }
export interface CredentialBrokerOptions {
  readonly providers: readonly CredentialProvider[];
  readonly maxConcurrent?: number;
  readonly timeoutMs?: number;
  readonly maxSecretBytes?: number;
  readonly now?: () => number;
}
export interface CredentialBrokerSnapshot { readonly providers: readonly string[]; readonly pending: number; readonly maxConcurrent: number }
export interface CredentialBroker {
  use<T>(reference: SecretReference, signal: AbortSignal,
    operation: (credential: Uint8Array, metadata: { readonly version: string; readonly expiresAtMs?: number }) => T | Promise<T>): Promise<T>;
  inspect(): CredentialBrokerSnapshot;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const registrations = new WeakMap<CredentialProvider, CredentialProviderOptions['resolve']>();

/** Register a trusted credential backend without publishing its resolver callback. */
export function defineCredentialProvider(options: CredentialProviderOptions): CredentialProvider {
  if (options === null || typeof options !== 'object') throw new MayuraError('INVALID_CONFIG', 'Credential provider configuration is invalid.');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(descriptors).some(key => !['id', 'resolve'].includes(String(key)))) throw new MayuraError('INVALID_CONFIG', 'Credential provider configuration contains unknown fields.');
  const id = descriptors['id']; const resolve = descriptors['resolve'];
  if (!id || !('value' in id) || typeof id.value !== 'string' || !identifier.test(id.value)
    || !resolve || !('value' in resolve) || typeof resolve.value !== 'function') throw new MayuraError('INVALID_CONFIG', 'Credential provider requires an ID and resolver.');
  const definition = Object.freeze({ id: id.value }); registrations.set(definition, resolve.value as CredentialProviderOptions['resolve']); return definition;
}

function positive(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new MayuraError('INVALID_CONFIG', `${label} is invalid.`); return value;
}

/** Resolve credentials only for the lifetime of one trusted callback; no caching or ambient discovery occurs. */
export function createCredentialBroker(options: CredentialBrokerOptions): CredentialBroker {
  if (!Array.isArray(options.providers) || options.providers.length < 1 || options.providers.length > 32) throw new MayuraError('INVALID_CONFIG', 'Credential broker requires 1–32 providers.');
  const providers = new Map<string, { readonly resolve: CredentialProviderOptions['resolve'] }>();
  for (const provider of options.providers) {
    const resolve = registrations.get(provider);
    if (!resolve || providers.has(provider.id)) throw new MayuraError('INVALID_CONFIG', 'Credential providers must be genuine and uniquely identified.');
    providers.set(provider.id, Object.freeze({ resolve }));
  }
  const maxConcurrent = positive(options.maxConcurrent ?? 16, 1_024, 'Credential concurrency');
  const timeoutMs = positive(options.timeoutMs ?? 10_000, 60_000, 'Credential timeout');
  const maxSecretBytes = positive(options.maxSecretBytes ?? 65_536, 1_048_576, 'Credential byte limit');
  const now = options.now ?? Date.now; let pending = 0;
  const providerIds = Object.freeze([...providers.keys()].sort());

  return Object.freeze<CredentialBroker>({
    async use<T>(input: SecretReference, external: AbortSignal,
      operation: (credential: Uint8Array, metadata: { readonly version: string; readonly expiresAtMs?: number }) => T | Promise<T>): Promise<T> {
      const reference = secretReference(input); const provider = providers.get(reference.provider);
      if (!provider) throw new MayuraError('NOT_FOUND', 'Credential provider is not registered.');
      if (!(external instanceof AbortSignal) || typeof operation !== 'function') throw new MayuraError('INVALID_CONFIG', 'Credential use requires a signal and trusted callback.');
      if (external.aborted) throw new MayuraError('CANCELLED', 'Credential use was cancelled.');
      if (pending >= maxConcurrent) throw new MayuraError('LIMIT_EXCEEDED', 'Credential broker capacity is exhausted.');
      pending++;
      const controller = new AbortController(); const cancel = (): void => { controller.abort(); };
      external.addEventListener('abort', cancel, { once: true }); const timer = setTimeout(cancel, timeoutMs);
      const actual = (async (): Promise<T> => {
        let supplied: ResolvedCredential;
        try { supplied = await provider.resolve(Object.freeze({ key: reference.key, ...(reference.version === undefined ? {} : { version: reference.version }) }), controller.signal); }
        catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Credential provider is unavailable.'); }
        const descriptors: PropertyDescriptorMap = supplied && typeof supplied === 'object' ? Object.getOwnPropertyDescriptors(supplied) : {};
        const byteField = descriptors['bytes']; const versionField = descriptors['version']; const expiryField = descriptors['expiresAtMs'];
        const bytes = byteField && 'value' in byteField ? byteField.value as unknown : undefined;
        const version = versionField && 'value' in versionField ? versionField.value as unknown : undefined;
        const expiry = expiryField && 'value' in expiryField ? expiryField.value as unknown : undefined;
        let current: number | undefined;
        if (expiry !== undefined) {
          try { current = now(); } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Credential clock is unavailable.'); }
          if (!Number.isSafeInteger(current) || current! < 0) throw new MayuraError('STORAGE_UNAVAILABLE', 'Credential clock is unavailable.');
        }
        if (supplied === null || typeof supplied !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(supplied))
          || Reflect.ownKeys(descriptors).some(key => !['bytes', 'version', 'expiresAtMs'].includes(String(key)))
          || !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maxSecretBytes || typeof version !== 'string' || !identifier.test(version)
          || (reference.version !== undefined && version !== reference.version)
          || (expiry !== undefined && (!Number.isSafeInteger(expiry) || (expiry as number) <= current!))) {
          try { if (bytes instanceof Uint8Array) bytes.fill(0); } catch { /* Best-effort cleanup of malformed provider material. */ }
          throw new MayuraError('INTEGRITY_VIOLATION', 'Credential provider returned invalid material.');
        }
        const credential = new Uint8Array(bytes); bytes.fill(0);
        const metadata = Object.freeze({ version, ...(expiry === undefined ? {} : { expiresAtMs: expiry as number }) });
        try {
          if (controller.signal.aborted) throw new MayuraError(external.aborted ? 'CANCELLED' : 'TIMEOUT', 'Credential use was cancelled or timed out.');
          try { return await operation(credential, metadata); }
          catch { throw new MayuraError('TOOL_FAILED', 'Credential consumer failed.'); }
        } finally { credential.fill(0); }
      })().finally(() => { pending--; clearTimeout(timer); external.removeEventListener('abort', cancel); });
      return await new Promise<T>((resolve, reject) => {
        const aborted = (): void => { controller.signal.removeEventListener('abort', aborted); reject(new MayuraError(external.aborted ? 'CANCELLED' : 'TIMEOUT', 'Credential use was cancelled or timed out.')); };
        controller.signal.addEventListener('abort', aborted, { once: true });
        actual.then(value => { controller.signal.removeEventListener('abort', aborted); resolve(value); }, error => { controller.signal.removeEventListener('abort', aborted); reject(error); });
        if (controller.signal.aborted) aborted();
      });
    },
    inspect: () => Object.freeze({ providers: providerIds, pending, maxConcurrent }),
  });
}
