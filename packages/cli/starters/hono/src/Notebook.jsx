"use client";
import { createElement as h, useEffect, useRef, useState } from 'react';
import { createHeadlessThreadsStore } from 'mayura/client/headless';
import { connectNotebook } from './connect.js';
import { ChatApp } from './ChatApp.jsx';

/** Inert on render. Login is explicit; unmount disposes observers, never cancelling remote writes implicitly. */
export default function Notebook() {
  const [token, setToken] = useState(''); const [active, setActive] = useState(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const current = useRef(null); const mounted = useRef(true); const connecting = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; current.current?.session.dispose(); current.current?.threads.dispose(); }; }, []);
  async function login(event) {
    event.preventDefault(); if (connecting.current) return; connecting.current = true; setBusy(true); setError('');
    try {
      const next = await connectNotebook(token); if (!mounted.current) { next.session.dispose(); return; }
      const threads = createHeadlessThreadsStore({ client: next.client }); current.current = { ...next, threads }; setToken(''); setActive(current.current);
      await Promise.all([next.session.open(), threads.refresh()]);
    } catch { if (mounted.current) setError('Connection needs attention. Check your session or inspect the conversation before retrying.'); }
    finally { connecting.current = false; if (mounted.current) setBusy(false); }
  }
  function logout() { current.current?.session.dispose(); current.current?.threads.dispose(); current.current = null; setActive(null); }
  return h('main', null, active ? h('div', null, h('button', { type: 'button', onClick: logout }, 'Disconnect'), h(ChatApp, { session: active.session, threads: active.threads })) :
    h('section', null, h('p', { className: 'eyebrow' }, 'MAYURA / NOTEBOOK'), h('h1', null, 'Your words. Your decision.'), h('p', null, 'Connect with your private session token. Every note waits for your approval.'),
      h('form', { onSubmit: login }, h('label', null, 'Session token', h('input', { type: 'password', value: token, autoComplete: 'off', maxLength: 64, required: true, onChange: event => setToken(event.target.value) })), h('button', { disabled: busy, type: 'submit' }, busy ? 'Connecting…' : 'Connect'))), error ? h('p', { role: 'alert' }, error) : null);
}
