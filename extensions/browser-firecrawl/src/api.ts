import { MayuraError } from 'mayura';

/** Firecrawl's API address: https, or plain http only on this machine (a local proxy or a test). */
export function firecrawlBase(baseUrl: string | undefined, caller: string): string {
  try {
    const url = new URL(baseUrl ?? 'https://api.firecrawl.dev');
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error();
    return url.origin;
  } catch { throw new MayuraError('INVALID_CONFIG', `${caller}(): baseUrl must be an https URL.`); }
}
