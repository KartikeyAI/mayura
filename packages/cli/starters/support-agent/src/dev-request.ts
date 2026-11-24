import type { RequestOptions } from 'node:http';

/** Parse a request target for the local development front server. */
export function devRequestTarget(value: string | undefined, origin: string): URL | undefined {
  try {
    const target = new URL(value ?? '/', origin);
    if (target.origin === origin && !target.username && !target.password && !target.hash) return target;
  } catch {
    return undefined;
  }
  return undefined;
}

/** Derive the connection from the configured server origin and use only the routed request path and query. */
export function devUpstreamOptions(origin: string, target: Pick<URL, 'pathname' | 'search'>): RequestOptions {
  const { protocol, hostname, port } = new URL(origin);
  return { protocol, hostname, port, path: target.pathname + target.search };
}
