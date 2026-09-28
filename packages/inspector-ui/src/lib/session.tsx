import * as React from 'react';
import { ClientError, createClient, type MayuraClient, type RemoteFeature, type RemoteSession } from '@mayura/client';

type Capability = RemoteSession['capabilities'][number];
/** The operator's token lives only in this React state: never in storage, cookies or the URL. */
export interface Session {
  readonly client: MayuraClient;
  /** What the token may do and which optional APIs the server offers it, read once at connect. */
  readonly info: RemoteSession;
  readonly can: (capability: Capability) => boolean;
  readonly offers: (feature: RemoteFeature) => boolean;
  /** Authenticated same-origin JSON read for endpoints the typed client does not wrap (health, tools, migrations). */
  readonly get: <T>(path: string, signal?: AbortSignal) => Promise<T>;
  readonly post: <T>(path: string, body: unknown, headers?: Record<string, string>) => Promise<T>;
  readonly forget: () => void;
}
const SessionContext = React.createContext<Session | null>(null);

export function useSession(): Session {
  const session = React.useContext(SessionContext);
  if (!session) throw new Error('The console session is not connected.');
  return session;
}

/** The server's explanation and code, for example `The access token lacks ... (CAPABILITY_REQUIRED, HTTP 403)`. */
export function errorText(error: unknown): string {
  if (error instanceof ClientError) return `${error.message} (${error.code}${error.status ? `, HTTP ${error.status}` : ''})`;
  return 'The request failed.';
}

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, cache: 'no-store', redirect: 'error', headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => ({})) as { error?: { code?: unknown; message?: unknown } };
  if (!response.ok) {
    const code = typeof body?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(body.error.code) ? body.error.code : 'HTTP_ERROR';
    const message = typeof body?.error?.message === 'string' && /^[\x20-\x7e]{1,1024}$/.test(body.error.message) ? body.error.message : undefined;
    throw new ClientError(code, response.status, message === undefined ? {} : { message });
  }
  return body as T;
}

export function SessionProvider({ token, info, onForget, children }: { token: string; info: RemoteSession; onForget: () => void; children: React.ReactNode }) {
  const session = React.useMemo<Session>(() => ({
    client: createClient({ baseUrl: window.location.origin, token: () => token }),
    info,
    can: capability => info.capabilities.includes(capability),
    offers: feature => info.features.includes(feature),
    get: (path, signal) => request(token, path, signal ? { signal } : {}),
    post: (path, body, headers = {}) => request(token, path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } }),
    forget: onForget,
  }), [token, info, onForget]);
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/** Load data with cancellation on unmount/refresh; `reload` re-runs the loader. A disabled loader loads nothing. */
export function useLoad<T>(loader: (signal: AbortSignal) => Promise<T>, dependencies: React.DependencyList, enabled = true): {
  data: T | undefined; error: string | undefined; loading: boolean; reload: () => void;
} {
  const [state, setState] = React.useState<{ data: T | undefined; error: string | undefined; loading: boolean }>({ data: undefined, error: undefined, loading: enabled });
  const [generation, setGeneration] = React.useState(0);
  React.useEffect(() => {
    if (!enabled) { setState({ data: undefined, error: undefined, loading: false }); return; }
    const controller = new AbortController();
    setState(previous => ({ ...previous, loading: true, error: undefined }));
    loader(controller.signal).then(data => { if (!controller.signal.aborted) setState({ data, error: undefined, loading: false }); },
      error => { if (!controller.signal.aborted) setState(previous => ({ data: previous.data, error: errorText(error), loading: false })); });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, generation, enabled]);
  return { ...state, reload: () => setGeneration(value => value + 1) };
}

export const commandId = (): string => crypto.randomUUID();
