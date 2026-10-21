import { ClientError } from 'mayura/client';
import { createHeadlessRunStore, createHeadlessThreadStore, createRunApprovalController } from 'mayura/client/headless';

const key = 'mayura.thread-chat.v1';
const id = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const reply = { '~standard': { version: 1, validate: value => value && typeof value.reply === 'string' ? { value } : { issues: [{ message: 'Expected a reply.' }] } } };
const terminal = status => ['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(status);

/** App-owned wiring: only ids and the bounded in-flight message/retry key are saved locally, never credentials. */
export function createChatSession({ client, storage }) {
  let selected = {};
  try {
    const raw = storage?.getItem(key);
    if (raw && raw.length <= 16_384) {
      const value = JSON.parse(raw);
      if (value && typeof value.threadId === 'string' && id.test(value.threadId)
        && (value.runId === undefined || /^[a-f0-9-]{36}$/.test(value.runId))
        && (value.message === undefined || (typeof value.message === 'string' && value.message.length <= 2_000))
        && (value.pending === undefined || (typeof value.pending.message === 'string' && value.pending.message.length <= 2_000 && /^[a-f0-9-]{36}$/.test(value.pending.key)))) selected = value;
    }
  } catch { /* Storage can be disabled; this tab still works without reload recovery. */ }
  let disposed = false; let working = false; let generation = 0; let detachRun = () => {};
  let state = Object.freeze({ phase: 'idle', busy: false, threadStore: null, runStore: null, approval: null, message: selected.message ?? null,
    threadId: selected.threadId ?? null, runId: selected.runId ?? null, hasPending: Boolean(selected.pending), errorCode: null });
  const listeners = new Set(); const lifetime = new AbortController();
  const publish = change => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...change });
    for (const listener of [...listeners]) { try { listener(); } catch { /* UI listeners cannot break transport work. */ } }
  };
  const save = () => { try { storage?.setItem(key, JSON.stringify(selected)); } catch { /* In-memory fallback. */ } };
  const failure = error => { if (!disposed) publish({ phase: 'error', errorCode: error instanceof ClientError ? error.code : 'CHAT_FAILED' }); };
  const perform = async work => {
    if (disposed) throw new ClientError('VIEW_DISPOSED'); if (working) throw new ClientError('VIEW_BUSY'); working = true; publish({ busy: true });
    try { return await work(); } catch (error) { failure(error); throw error; } finally { working = false; publish({ busy: false }); }
  };
  const latestHistory = async () => {
    const thread = await client.thread(selected.threadId, { signal: lifetime.signal });
    return state.threadStore.refresh({ before: thread.lastSequence + 1, signal: lifetime.signal });
  };
  const dropRun = () => {
    generation++; detachRun(); detachRun = () => {}; state.runStore?.dispose(); state.approval?.dispose();
    publish({ runStore: null, approval: null });
  };
  const attach = run => {
    dropRun(); const current = generation; const runStore = createHeadlessRunStore({ run });
    let captured = null;
    detachRun = runStore.subscribe(() => {
      const snapshot = runStore.getSnapshot().snapshot;
      if (disposed || current !== generation || !snapshot?.approval || snapshot.status !== 'waiting') return;
      const capture = `${snapshot.approval.callId}:${snapshot.approval.digest}`;
      if (capture !== captured) {
        captured = capture; state.approval?.dispose(); publish({ approval: createRunApprovalController({ run, approval: snapshot.approval }) });
      }
    });
    publish({ runStore, runId: run.id, phase: 'active', errorCode: null });
    // Reading first recovers an already waiting/completed run. Observation then follows pauses/resumes without making decisions.
    void (async () => {
      try {
        await runStore.refresh({ signal: lifetime.signal });
        if (!terminal(runStore.getSnapshot().snapshot?.status)) await runStore.observe({ signal: lifetime.signal });
        if (disposed || current !== generation) return;
        const outcome = await run.result(reply, { signal: lifetime.signal });
        if (!outcome) throw new ClientError('RUN_STILL_ACTIVE');
        await latestHistory(); if (disposed || current !== generation) return;
        selected = { threadId: selected.threadId }; save();
        publish({ phase: 'ready', runId: null, message: null, hasPending: false, errorCode: null });
      } catch (error) { if (!disposed && current === generation) failure(error); }
    })();
  };
  const submitPending = async () => {
    const pending = selected.pending; if (!pending) throw new ClientError('INVALID_REQUEST');
    publish({ phase: 'submitting', hasPending: true, message: pending.message, errorCode: null });
    const run = await state.threadStore.submit('chat.notes', { message: pending.message }, { idempotencyKey: pending.key, signal: lifetime.signal });
    if (disposed) return;
    selected = { threadId: selected.threadId, runId: run.id, message: pending.message }; save(); publish({ hasPending: false }); attach(run);
  };
  const open = () => perform(async () => {
    publish({ phase: 'opening', errorCode: null });
    if (!selected.threadId) {
      const thread = await client.createThread({ agentId: 'chat.notes', title: 'My notes' }, { signal: lifetime.signal });
      selected = { threadId: thread.id }; save();
    }
    if (disposed) return;
    state.threadStore?.dispose(); const threadStore = createHeadlessThreadStore({ client, threadId: selected.threadId, maxEntries: 40 });
    publish({ threadStore, threadId: selected.threadId }); await latestHistory();
    if (selected.runId) attach(client.run(selected.runId));
    else publish({ phase: 'ready', hasPending: Boolean(selected.pending), message: selected.pending?.message ?? null });
  });
  return Object.freeze({
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    open,
    send: message => perform(async () => {
      if (state.phase !== 'ready' || selected.runId || selected.pending) throw new ClientError('VIEW_BUSY');
      if (typeof message !== 'string' || !message.trim() || message.trim().length > 2_000) throw new ClientError('INVALID_REQUEST');
      // Save before the POST. An ambiguous response can be retried explicitly with the exact same key and message.
      selected = { threadId: selected.threadId, pending: { key: crypto.randomUUID(), message: message.trim() } }; save(); await submitPending();
    }),
    retrySubmission: () => perform(submitPending),
    reconnect: () => perform(async () => {
      if (!selected.runId) { await latestHistory(); publish({ phase: 'ready', errorCode: null }); return; }
      attach(client.run(selected.runId));
    }),
    cancel: () => perform(async () => { if (!selected.runId) throw new ClientError('INVALID_REQUEST'); await client.run(selected.runId).cancel({ signal: lifetime.signal }); }),
    refreshHistory: page => perform(async () => { await state.threadStore.refresh({ ...page, signal: lifetime.signal }); }),
    forgetMissing: () => {
      if (disposed) return Promise.reject(new ClientError('VIEW_DISPOSED'));
      if (working || !['THREAD_NOT_FOUND', 'RUN_NOT_FOUND'].includes(state.errorCode)) return Promise.reject(new ClientError('VIEW_BUSY'));
      // This drops only browser selection after a confirmed not-found response, not server history or running work.
      dropRun(); state.threadStore?.dispose(); selected = {}; save(); publish({ phase: 'opening', threadStore: null, threadId: null, runId: null, message: null, hasPending: false });
      return open();
    },
    newThread: () => perform(async () => {
      if (selected.runId || selected.pending) throw new ClientError('VIEW_BUSY');
      const thread = await client.createThread({ agentId: 'chat.notes', title: 'My notes' }, { signal: lifetime.signal });
      if (disposed) return; dropRun(); state.threadStore?.dispose(); selected = { threadId: thread.id }; save();
      const threadStore = createHeadlessThreadStore({ client, threadId: thread.id, maxEntries: 40 });
      publish({ threadStore, threadId: thread.id, runId: null, message: null, phase: 'ready', errorCode: null }); await latestHistory();
    }),
    dispose: () => {
      if (disposed) return; disposed = true; generation++; lifetime.abort(); detachRun();
      state.runStore?.dispose(); state.approval?.dispose(); state.threadStore?.dispose(); listeners.clear();
    },
  });
}
