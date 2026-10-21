import { ClientError, createClient } from 'mayura/client';
import { createChatSession } from './session.js';

/** Called only after an explicit login. The credential lives in this session closure, never browser storage. */
export async function connectNotebook(token, origin = location.origin) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token)) throw new ClientError('INVALID_CREDENTIAL');
  const transport = globalThis.fetch.bind(globalThis);
  const client = createClient({ baseUrl: origin, token: () => token, requestTimeoutMs: 45000,
    fetch: (input, init) => {
      const request = new Request(input, init); const url = new URL(request.url);
      if (url.origin !== origin || !url.pathname.startsWith('/v1/')) throw new ClientError('INVALID_DESTINATION');
      url.pathname = `/api/mayura${url.pathname}`;
      return transport(new Request(url, request));
    } });
  // Verify the credential before creating any thread or restoring a selection.
  await client.session();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  let storage; try { storage = sessionStorage; } catch { /* Optional reload recovery. */ }
  const session = createChatSession({ client, storage, storageKey: `mayura.notebook.${digest}` });
  return { session, client };
}
