import { MayuraError } from '@mayura/core';

/** An origin a browser may load from: `https://example.com`, `https://*.example.com` or `http://127.0.0.1:8080`. */
interface OriginRule { readonly protocol: 'http:' | 'https:'; readonly host: string; readonly wildcard: boolean; readonly port: string }

const hostPattern = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$|^\[[0-9a-f:.]+\]$/u;
const defaultPort = (protocol: string) => (protocol === 'https:' ? '443' : '80');

function rule(text: unknown): OriginRule {
  const match = typeof text === 'string' ? /^(https?):\/\/([^/:]+|\[[^\]]+\])(?::(\d{1,5}))?\/?$/u.exec(text.toLowerCase()) : null;
  const host = match?.[2];
  if (!match || !host || !hostPattern.test(host) || (match[3] !== undefined && (Number(match[3]) < 1 || Number(match[3]) > 65_535))) {
    throw new MayuraError('INVALID_CONFIG', 'origins lists origins such as https://example.com, https://*.example.com or http://127.0.0.1:8080, or is \'all\'.');
  }
  const protocol = `${match[1]}:` as 'http:' | 'https:';
  return { protocol, host: host.replace(/^\*\./u, ''), wildcard: host.startsWith('*.'), port: match[3] ?? defaultPort(protocol) };
}

/** Which URLs a browser may load: a checked list of origins, or every http(s) URL. */
export interface OriginPolicy {
  readonly all: boolean;
  /** Whether a request to `url` may go out. Local schemes (about:, data:, blob:) never reach the network and pass. */
  allows(url: string): boolean;
}

/**
 * The origins a browser may load, as `createBrowsers` takes them (`['https://example.com', 'https://*.example.com']` or
 * `'all'`), checked. Use it for tools of your own that fetch pages, to keep them to the same list.
 */
export function originPolicy(value: unknown): OriginPolicy {
  if (value === 'all') return Object.freeze({ all: true, allows: (url: string) => /^(?:https?|wss?|about|data|blob):/iu.test(url) });
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) throw new MayuraError('INVALID_CONFIG', 'origins lists 1 to 256 origins, or is \'all\'; nothing is allowed by default.');
  const rules = value.map(rule);
  return Object.freeze({
    all: false,
    allows: (url: string) => {
      if (/^(?:about|data|blob):/iu.test(url)) return true;
      let parsed: URL;
      try { parsed = new URL(url); } catch { return false; }
      // WebSockets follow their page's origin rules.
      const protocol = parsed.protocol === 'wss:' ? 'https:' : parsed.protocol === 'ws:' ? 'http:' : parsed.protocol;
      if (protocol !== 'http:' && protocol !== 'https:') return false;
      const host = parsed.hostname.toLowerCase(); const port = parsed.port || defaultPort(protocol);
      return rules.some(item => item.protocol === protocol && item.port === port
        // *.example.com is its subdomains, not example.com itself.
        && (item.wildcard ? host.endsWith(`.${item.host}`) : host === item.host));
    },
  });
}
