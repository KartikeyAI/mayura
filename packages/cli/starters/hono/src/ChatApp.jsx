import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react';
import { useMayuraRun, useMayuraRunApprovalCommand } from 'mayura/client-react';
import { ThreadHistory as MayuraThreadHistory } from './components/mayura/thread-history';
import { Approval as MayuraRunApprovalControl } from './components/mayura/approval';
import { ThreadList } from './components/mayura/thread-list';

const ignore = promise => { void promise.catch(() => {}); };
function ApprovalPanel({ controller, session }) {
  const state = useMayuraRunApprovalCommand(controller); const [nowMs, setNowMs] = useState(Date.now);
  // This is application policy, not a side effect of the reusable approval component.
  useEffect(() => { const timer = setInterval(() => setNowMs(Date.now()), 1_000); return () => clearInterval(timer); }, []);
  return h('aside', { 'aria-label': 'Review note before saving' },
    h('h2', null, 'Review before saving'), h(MayuraRunApprovalControl, { controller, nowMs, subject: 'this note' }),
    ['failed', 'conflict'].includes(state.status) ? h('button', { type: 'button', onClick: () => ignore(session.reconnect()) }, 'Refresh approval') : null);
}
function ActiveRun({ store, controller, session, canCancel }) {
  const state = useMayuraRun(store);
  return h('section', { 'aria-label': 'Current turn' },
    h('p', { role: 'status' }, `Run ${state.snapshot?.status ?? state.connection}`),
    state.snapshot?.status === 'waiting' && controller ? h(ApprovalPanel, { controller, session }) : null,
    canCancel ? h('button', { type: 'button', onClick: () => ignore(session.cancel()) }, 'Cancel current run') : null);
}
/** The app owns transport/session lifecycle; the library's history and approval components remain inert on mount. */
export function ChatApp({ session, threads }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [message, setMessage] = useState(() => session.getSnapshot().runId || session.getSnapshot().hasPending ? '' : 'Remember to send the release notes.');
  const canSend = state.phase === 'ready' && !state.busy && !state.hasPending && !state.runId;
  const send = async event => {
    event.preventDefault(); if (!canSend || !message.trim()) return;
    try { await session.send(message); setMessage(''); } catch { /* Session feedback retains the draft and exact retry key. */ }
  };
  return h('div', { className: 'chat' },
    h('header', null, h('p', { className: 'eyebrow' }, 'MAYURA / NOTEBOOK'), h('h1', null, 'A note, with your approval.'),
      h('p', null, 'Send a message. Review the proposed note write. Approve it, reject it, or cancel the run.'),
      h('p', { className: 'demo-note' }, 'Deterministic demo adapter · no model API key · no external effects')),
    h(ThreadList, { store: threads, onSelect: threadId => { if (canSend) ignore(session.selectThread(threadId)); } }),
    h('nav', { 'aria-label': 'Conversation actions' },
      h('button', { type: 'button', onClick: () => ignore(threads.refresh()) }, 'Refresh conversations'),
      h('button', { type: 'button', disabled: !canSend, onClick: () => ignore(session.newThread()) }, 'New chat'),
      h('button', { type: 'button', disabled: state.busy || ['opening', 'submitting', 'idle'].includes(state.phase), onClick: () => ignore(session.reconnect()) }, 'Reconnect / refresh')),
    state.errorCode ? h('p', { role: 'alert' }, `Chat needs attention (${state.errorCode}). Reconnect to inspect the run; decisions are never retried automatically.`) : null,
    ['THREAD_NOT_FOUND', 'RUN_NOT_FOUND'].includes(state.errorCode) ? h('button', { type: 'button', onClick: () => ignore(session.forgetMissing()) }, 'Forget missing chat') : null,
    state.hasPending ? h('section', { 'aria-label': 'Unconfirmed submission' },
      h('p', null, 'This send has not been confirmed. Retry uses the same message and idempotency key.'),
      h('button', { type: 'button', disabled: state.busy || state.phase === 'submitting', onClick: () => ignore(session.retrySubmission()) }, 'Retry last send')) : null,
    state.threadStore ? h(MayuraThreadHistory, { store: state.threadStore,
      onLoadEarlier: page => ignore(session.refreshHistory(page)), onLoadLater: page => ignore(session.refreshHistory(page)) })
      : h('p', { role: 'status' }, 'Opening your conversation…'),
    state.message ? h('section', { 'aria-label': 'Current message' }, h('h2', null, 'You'), h('p', { className: 'message' }, state.message)) : null,
    state.runStore ? h(ActiveRun, { store: state.runStore, controller: state.approval, session, canCancel: Boolean(state.runId) && !state.busy }) : null,
    h('form', { onSubmit: send, 'aria-label': 'Send a message' },
      h('label', { htmlFor: 'chat-message' }, 'Message'),
      h('textarea', { id: 'chat-message', value: message, maxLength: 2_000, rows: 3, disabled: !canSend,
        onChange: event => setMessage(event.target.value), placeholder: 'Write a note to save…' }),
      h('button', { type: 'submit', disabled: !canSend || !message.trim() }, 'Send message')),
    h('footer', null, 'Reload this page while a run is waiting to recover its approval. Notes and approvals use the configured database. Run the background worker to process indexing and recovery.'));
}
