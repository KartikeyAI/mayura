import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from 'mayura/client';
import { createChatSession } from './session.js';
import { ChatApp } from './app.js';
import './style.css';

const target = document.getElementById('root');
try {
  const response = await fetch('/config.json', { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('Configuration unavailable');
  const config = await response.json();
  // Local demo only: a fixed-scope token from this loopback page. Real applications use verified identity-provider tokens.
  const client = createClient({ baseUrl: config.apiOrigin, token: () => config.token, requestTimeoutMs: 10_000 });
  let storage; try { storage = window.localStorage; } catch { /* Optional reload recovery. */ }
  const session = createChatSession({ client, storage }); const root = createRoot(target);
  root.render(createElement(ChatApp, { session }));
  // Explicit application startup policy. Reusable hooks/components themselves perform no I/O on mount.
  void session.open().catch(() => {});
  window.addEventListener('pagehide', event => { if (!event.persisted) { root.unmount(); session.dispose(); } });
  window.addEventListener('pageshow', event => { if (event.persisted) void session.reconnect().catch(() => {}); });
} catch {
  target.textContent = 'The chat could not start. Reload the page after checking that the local example server is running.';
}
