import { useRef, useState, type ReactNode, type FormEvent } from 'react';
import { useMayuraRun } from 'mayura/client-react';
import type { HeadlessRunStore } from 'mayura/client/headless';
import './ui.css';
/** Explicit send, one in-flight command, no mount-time spend or automatic retry. Plain text only. */
export function Chat({ store, onSend, history }: { readonly history?: ReactNode; readonly store: HeadlessRunStore; readonly onSend: (text: string) => Promise<void> }) {
  const state = useMayuraRun(store); const [draft, setDraft] = useState(''); const [pending, setPending] = useState(false); const [error, setError] = useState(''); const busy = useRef(false);
  async function send(event: FormEvent) { event.preventDefault(); const text = draft.trim(); if (busy.current || !text || text.length > 16000) return;
    busy.current = true; setPending(true); setError('');
    try { await onSend(text); setDraft(''); } catch { setError('Send was not confirmed. Inspect the conversation before sending again.'); }
    finally { busy.current = false; setPending(false); }
  }
  return <section className="mayura-ui" aria-label="Chat"><h2>Conversation</h2><p role="status">{state.snapshot?.status ?? state.connection}</p>
    <div role="log" aria-label="Messages">{history ?? <p>Send a message to start the conversation.</p>}{state.streamedOutput ? <><p>{state.streamedOutput.text}</p><small>{state.streamedOutput.withheld ? 'Further text withheld. Inspect the final result.' : 'Streaming preview; the final response is authoritative.'}</small></> : null}</div>
    <form onSubmit={send}><label>Message<textarea value={draft} maxLength={16000} disabled={pending} onChange={event => setDraft(event.target.value)} /></label>
      <button disabled={pending || !draft.trim()}>{pending ? 'Sending…' : 'Send message'}</button></form>{error ? <p role="alert">{error}</p> : null}</section>;
}
