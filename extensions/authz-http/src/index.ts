import { authorizationRequest, createAuthorizer, jsonValue, MayuraError,
  type AuthorizationDecision, type AuthorizationDenyReason, type AuthorizationPolicy, type AuthorizationRequest,
  type Authorizer, type AuthorizerOptions, type Permissions } from 'mayura';

/** Versioned Mayura policy-decision protocol; this is not an OPA, Cedar, OpenFGA or other vendor wire format. */
export const HTTP_AUTHORIZATION_PROTOCOL = 'mayura.authorization.v1' as const;
/** Exact POST envelope sent to the configured decision service. */
export interface HttpAuthorizationRequest {
  readonly protocol: typeof HTTP_AUTHORIZATION_PROTOCOL;
  readonly requestId: string;
  readonly policyVersion: string;
  readonly request: AuthorizationRequest;
}
/** Exact HTTP 200 envelope required from the decision service. */
export interface HttpAuthorizationResponse {
  readonly protocol: typeof HTTP_AUTHORIZATION_PROTOCOL;
  readonly requestId: string;
  readonly decision: AuthorizationDecision;
}
export interface HttpAuthorizationPolicyOptions {
  /** Exact trusted policy endpoint. HTTPS only, except explicitly enabled literal-loopback development URLs. */
  readonly endpoint: string;
  /** Pinned remote policy revision. Every decision must echo it exactly. */
  readonly version: string;
  /** Explicit authz:http admission. No remote request is made without it. */
  readonly permissions?: Permissions;
  /** Explicit fixed service credentials/headers. Never taken from a browser request or the environment. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly allowInsecureLoopback?: boolean;
  /** Per-check transport deadline, default 1,000 ms; 1–30,000 ms. */
  readonly timeoutMs?: number;
  /** Outstanding transport tasks, default 32; 1–256. Ignored aborts retain capacity until actual settlement. */
  readonly maxConcurrent?: number;
  /** UTF-8 request bytes, default 8,192; 1,024–16,384. */
  readonly maxRequestBytes?: number;
  /** Decoded response bytes, default 2,048; 256–16,384. */
  readonly maxResponseBytes?: number;
}
export interface HttpAuthorizationPolicy extends AuthorizationPolicy {
  /** Abort admitted transport work and refuse future evaluation. No request cache is retained. */
  close(): void;
}
export interface HttpAuthorizerOptions extends HttpAuthorizationPolicyOptions {
  readonly audit?: AuthorizerOptions['audit'];
  /** Core evaluation limits, separate from HTTP transport limits. */
  readonly limits?: AuthorizerOptions['limits'];
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const denyReasons: readonly string[] = ['no_match', 'explicit_deny', 'scope_mismatch', 'permission_denied', 'invalid_request', 'unavailable', 'cancelled', 'limit_exceeded'];
function invalid(): never { throw new MayuraError('INVALID_CONFIG', 'HTTP authorization requires an explicit endpoint, policy version and bounded transport settings.'); }
function bound(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback; if (!Number.isSafeInteger(result) || result < min || result > max) return invalid(); return result;
}
function endpoint(value: string, insecure: boolean): string {
  if (typeof value !== 'string' || value.length > 2048) return invalid();
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !url.hostname
    || (url.protocol !== 'https:' && !(insecure && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))) return invalid();
  return url.href;
}
/** Copy bounded fixed headers. Transport/security headers cannot override the adapter's request isolation. */
function headers(input: HttpAuthorizationPolicyOptions['headers']): Headers {
  const value = jsonValue(input ?? {}, { maxBytes: 8192, maxDepth: 1, maxNodes: 33 });
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 16) return invalid();
  const result = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
  const seen = new Set<string>();
  for (const [key, entry] of Object.entries(value)) {
    const name = key.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(name) || seen.has(name) || /^(?:sec-|proxy-)/.test(name)
      || ['host', 'cookie', 'set-cookie', 'connection', 'content-length', 'content-type', 'accept', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'origin', 'referer', 'user-agent', 'accept-encoding'].includes(name)
      || typeof entry !== 'string' || !entry.length || /[^\x20-\x7e]/.test(entry)) return invalid();
    seen.add(name); result.set(name, entry);
  }
  return result;
}
function frame(text: string, requestId: string, version: string): AuthorizationDecision | null {
  const raw = jsonValue(JSON.parse(text), { maxBytes: 16_384, maxDepth: 3, maxNodes: 24 });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'decision,protocol,requestId'
    || raw['protocol'] !== HTTP_AUTHORIZATION_PROTOCOL || raw['requestId'] !== requestId) return null;
  const decision = raw['decision'];
  if (!decision || typeof decision !== 'object' || Array.isArray(decision) || Object.keys(decision).sort().join(',') !== 'effect,policyVersion,reason,ruleId'
    || decision['policyVersion'] !== version || (decision['ruleId'] !== null && (typeof decision['ruleId'] !== 'string' || !identifier.test(decision['ruleId'])))
    || typeof decision['reason'] !== 'string'
    || (decision['effect'] === 'allow' ? decision['reason'] !== 'allowed' : decision['effect'] !== 'deny' || !denyReasons.includes(decision['reason']))) return null;
  return Object.freeze({ effect: decision['effect'], reason: decision['reason'], policyVersion: version, ruleId: decision['ruleId'] }) as AuthorizationDecision;
}
/**
 * Remote policy through the core contract. Only a correlated, pinned, strictly validated decision may allow. All
 * transport/parse/status failures deny without provider diagnostics. No retries, redirects, cookies or implicit cache.
 */
export function createHttpAuthorizationPolicy(options: HttpAuthorizationPolicyOptions): HttpAuthorizationPolicy {
  let destination: string; let fixedHeaders: Headers; let transport: typeof globalThis.fetch; let version: string;
  let timeoutMs: number; let maxConcurrent: number; let maxRequestBytes: number; let maxResponseBytes: number; let admitted: boolean;
  try {
    if (!options || typeof options.version !== 'string' || !identifier.test(options.version)
      || (options.allowInsecureLoopback !== undefined && typeof options.allowInsecureLoopback !== 'boolean')) return invalid();
    destination = endpoint(options.endpoint, options.allowInsecureLoopback === true); fixedHeaders = headers(options.headers); version = options.version;
    transport = options.fetch ?? globalThis.fetch; if (typeof transport !== 'function') return invalid();
    const grants = options.permissions?.allow ?? [];
    if (!Array.isArray(grants) || grants.length > 4096 || grants.some(grant => typeof grant !== 'string' || !grant.length || grant.length > 256)) return invalid();
    admitted = grants.includes('authz:http');
    timeoutMs = bound(options.timeoutMs, 1000, 1, 30_000); maxConcurrent = bound(options.maxConcurrent, 32, 1, 256);
    maxRequestBytes = bound(options.maxRequestBytes, 8192, 1024, 16_384); maxResponseBytes = bound(options.maxResponseBytes, 2048, 256, 16_384);
  } catch { return invalid(); }
  const active = new Set<AbortController>(); let closed = false;
  const deny = (reason: AuthorizationDenyReason): AuthorizationDecision => Object.freeze({ effect: 'deny', reason, policyVersion: version, ruleId: null });
  const authorize: AuthorizationPolicy['authorize'] = async (raw, context) => {
    let request: AuthorizationRequest;
    try {
      // Exact root shape as well as nested validation: never serialize arbitrary caller fields.
      const snapshot = jsonValue(raw, { maxBytes: 4096, maxDepth: 4, maxNodes: 32 });
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || Object.keys(snapshot).sort().join(',') !== 'action,resource,subject') return deny('invalid_request');
      const data = snapshot as unknown as AuthorizationRequest; request = authorizationRequest(data.subject, data.action, data.resource);
      if (!(context?.signal instanceof AbortSignal)) return deny('invalid_request');
    } catch { return deny('invalid_request'); }
    if (closed || context.signal.aborted) return deny('cancelled');
    if (request.subject.principalId !== request.resource.scope.principalId || request.subject.projectId !== request.resource.scope.projectId) return deny('scope_mismatch');
    if (!admitted) return deny('permission_denied');
    if (active.size >= maxConcurrent) return deny('limit_exceeded');
    const requestId = crypto.randomUUID();
    const envelope: HttpAuthorizationRequest = { protocol: HTTP_AUTHORIZATION_PROTOCOL, requestId, policyVersion: version, request };
    const payload = JSON.stringify(envelope);
    if (new TextEncoder().encode(payload).byteLength > maxRequestBytes) return deny('limit_exceeded');
    const control = new AbortController(); const deadline = Date.now() + timeoutMs; active.add(control);
    return await new Promise<AuthorizationDecision>(resolve => {
      let finished = false; let expired = false; let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (decision: AuthorizationDecision) => {
        if (finished) return; finished = true; clearTimeout(timer);
        context.signal.removeEventListener('abort', relay); control.signal.removeEventListener('abort', aborted); resolve(decision);
      };
      const relay = () => control.abort(); const aborted = () => finish(deny(expired ? 'unavailable' : 'cancelled'));
      control.signal.addEventListener('abort', aborted, { once: true }); context.signal.addEventListener('abort', relay, { once: true });
      timer = setTimeout(() => { expired = true; control.abort(); }, timeoutMs); if (context.signal.aborted) relay();
      // The task is deliberately not raced internally: ignored fetch/read cancellation retains the transport slot.
      const work = async (): Promise<AuthorizationDecision> => {
        if (control.signal.aborted) return deny(expired ? 'unavailable' : 'cancelled');
        let response: Response | undefined; let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let cancellation: Promise<void> | undefined;
        const cancelBody = (): Promise<void> | undefined => {
          if (cancellation) return cancellation;
          try { if (reader) cancellation = reader.cancel().catch(() => {}); else if (response?.body) cancellation = response.body.cancel().catch(() => {}); }
          catch { cancellation = Promise.resolve(); }
          return cancellation;
        };
        const stopBody = () => { void cancelBody(); };
        control.signal.addEventListener('abort', stopBody, { once: true });
        try {
          response = await transport(destination, { method: 'POST', headers: new Headers(fixedHeaders), body: payload,
            signal: control.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
          if (control.signal.aborted || closed) return deny(expired ? 'unavailable' : 'cancelled');
          if (response.status !== 200 || response.redirected || (response.url && response.url !== destination)
            || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) return deny('unavailable');
          const length = response.headers.get('content-length');
          if (length !== null && (!/^[0-9]{1,9}$/.test(length) || Number(length) > maxResponseBytes)) return deny('unavailable');
          reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
          for (;;) {
            if (control.signal.aborted) return deny(expired ? 'unavailable' : 'cancelled');
            const item = await reader.read(); if (item.done) break;
            size += item.value.byteLength; if (size > maxResponseBytes) return deny('unavailable'); if (item.value.byteLength) chunks.push(new Uint8Array(item.value));
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          const decision = frame(new TextDecoder('utf-8', { fatal: true }).decode(bytes), requestId, version);
          if (Date.now() >= deadline && !control.signal.aborted) { expired = true; control.abort(); }
          return control.signal.aborted || closed ? deny(expired ? 'unavailable' : 'cancelled') : decision ?? deny('unavailable');
        } catch { return deny(control.signal.aborted ? expired ? 'unavailable' : 'cancelled' : 'unavailable'); }
        finally { control.signal.removeEventListener('abort', stopBody); await cancelBody(); if (reader) reader.releaseLock(); }
      };
      void Promise.resolve().then(work).then(result => {
        active.delete(control);
        // Cleanup and trusted transport callbacks can consume wall time while timers are unable to run.
        if (Date.now() >= deadline && !control.signal.aborted) { expired = true; control.abort(); }
        finish(control.signal.aborted || closed ? deny(expired ? 'unavailable' : 'cancelled') : result);
      }, () => { active.delete(control); finish(deny('unavailable')); });
    });
  };
  return Object.freeze({ version, authorize, close() { if (closed) return; closed = true; for (const control of active) control.abort(); } });
}
/** Core enforcement and audit own the single decision receipt; closing also aborts the owned remote policy. */
export function createHttpAuthorizer(options: HttpAuthorizerOptions): Authorizer {
  const policy = createHttpAuthorizationPolicy(options);
  try {
    const authorizer = createAuthorizer({ policy,
      ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
      ...(options.audit === undefined ? {} : { audit: options.audit }), ...(options.limits === undefined ? {} : { limits: options.limits }) });
    return Object.freeze({ ...authorizer, close() { authorizer.close(); policy.close(); } });
  } catch (error) { policy.close(); throw error; }
}
