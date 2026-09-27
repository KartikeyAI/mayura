import * as React from 'react';
import { ClientError, createClient, type MayuraClient } from '@mayura/client';

/** The operator's token lives only in this React state: never in storage, cookies or the URL. */
export interface Session {
  readonly client: MayuraClient;
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

export function errorText(error: unknown): string {
  if (error instanceof ClientError) return error.status ? `${error.code} (HTTP ${error.status})` : error.code;
  if (error instanceof Error && /^[A-Z_]+( \(HTTP \d+\))?$/.test(error.message)) return error.message;
  return 'The request failed.';
}

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, cache: 'no-store', redirect: 'error', headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => ({})) as { error?: { code?: string } };
  if (!response.ok) throw new Error(`${body?.error?.code ?? 'HTTP_ERROR'} (HTTP ${response.status})`);
  return body as T;
}

export function SessionProvider({ token, onForget, children }: { token: string; onForget: () => void; children: React.ReactNode }) {
  const session = React.useMemo<Session>(() => ({
    client: createClient({ baseUrl: window.location.origin, token: () => token }),
    get: (path, signal) => request(token, path, signal ? { signal } : {}),
    post: (path, body, headers = {}) => request(token, path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } }),
    forget: onForget,
  }), [token, onForget]);
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/** Load data with cancellation on unmount/refresh; `reload` re-runs the loader. */
export function useLoad<T>(loader: (signal: AbortSignal) => Promise<T>, dependencies: React.DependencyList): {
  data: T | undefined; error: string | undefined; loading: boolean; reload: () => void;
} {
  const [state, setState] = React.useState<{ data: T | undefined; error: string | undefined; loading: boolean }>({ data: undefined, error: undefined, loading: true });
  const [generation, setGeneration] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    setState(previous => ({ ...previous, loading: true, error: undefined }));
    loader(controller.signal).then(data => { if (!controller.signal.aborted) setState({ data, error: undefined, loading: false }); },
      error => { if (!controller.signal.aborted) setState(previous => ({ data: previous.data, error: errorText(error), loading: false })); });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, generation]);
  return { ...state, reload: () => setGeneration(value => value + 1) };
}

export const commandId = (): string => crypto.randomUUID();
