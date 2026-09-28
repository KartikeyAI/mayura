import { MayuraError } from './errors.js';

// Where a provider adapter sends requests, when it is not the provider's own API: a gateway or proxy such as Cloudflare
// AI Gateway. Choosing one is an explicit data-egress decision in code; nothing here is read from the environment.

/**
 * Check a provider endpoint given in place of the default: an https URL ending in `path` (such as `/responses`), with no
 * credentials, query or fragment in it. Returns the normalized URL. `where` names the adapter in the error.
 */
export function providerEndpoint(value: unknown, path: string, where: string): string {
  let url: URL;
  try { url = new URL(typeof value === 'string' ? value : ''); } catch { throw new MayuraError('INVALID_CONFIG', `${where}: endpoint must be an absolute https:// URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith(path) || url.href.length > 2_048) {
    throw new MayuraError('INVALID_CONFIG', `${where}: endpoint must be an https:// URL ending in ${path}, without credentials, query or fragment.`);
  }
  return url.href;
}

/**
 * Check extra request headers, such as a gateway's credential (`cf-aig-authorization`): at most 8, each a bounded
 * value without line breaks. They cannot replace the headers the adapter owns (`owned`, in any case), cookies or
 * transport headers. Treated as credentials by the caller: never logged or reported.
 */
export function providerHeaders(value: unknown, owned: readonly string[], where: string): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  const reserved = new Set([...owned.map(name => name.toLowerCase()), 'content-type', 'content-length', 'host', 'cookie', 'transfer-encoding', 'connection']);
  const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : undefined;
  if (!entries || entries.length > 8 || entries.some(([name, text]) => !/^[A-Za-z0-9-]{1,64}$/u.test(name) || reserved.has(name.toLowerCase())
    || typeof text !== 'string' || !text || /[\r\n]/u.test(text) || text.length > 8_192)) {
    throw new MayuraError('INVALID_CONFIG', `${where}: headers must be at most 8 extra header values; they cannot replace ${owned.join(', ')}, Content-Type, Host or cookies.`);
  }
  return Object.freeze(Object.fromEntries(entries as [string, string][]));
}
