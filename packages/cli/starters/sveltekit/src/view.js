import { createHeadlessThreadsStore } from 'mayura/client/headless';
import { connectNotebook } from './connect.js';
/** Framework-neutral subscriptions. Observers read; all commands require an explicit UI action. */
export function createNotebookView() {
  const listeners = new Set(); let session; let threads; let detach = []; let watched = []; let detachSession; let busy = false; let disposed = false; let generation = 0;
  let state = Object.freeze({ connected: false, busy: false, phase: 'idle', error: null, threadId: null, runId: null, pending: false, message: null, history: [], threads: [], cursor: null, runStatus: null, approval: null });
  const publish = change => { if (disposed) return; state = Object.freeze({ ...state, ...change }); for (const listener of [...listeners]) { try { listener(); } catch { /* Rendering cannot change commands. */ } } };
  function sync() {
    if (disposed || !session) return; const next = session.getSnapshot(); const stores = [next.threadStore, next.runStore, next.approval, threads];
    if (stores.some((store, index) => watched[index] !== store)) { detach.forEach(fn => fn()); watched = stores; detach = stores.filter(Boolean).map(store => store.subscribe(sync)); }
    publish({ connected: true, phase: next.phase, error: next.errorCode, threadId: next.threadId, runId: next.runId, pending: next.hasPending, message: next.message,
      history: next.threadStore?.getSnapshot().entries ?? [], threads: threads.getSnapshot().page?.threads ?? [], cursor: threads.getSnapshot().page?.cursor ?? null,
      runStatus: next.runStore?.getSnapshot().snapshot?.status ?? null, approval: next.approval?.getSnapshot() ?? null });
  }
  const perform = async task => {
    if (disposed || busy) return; busy = true; publish({ busy: true, error: null });
    try { await task(); } catch { publish({ error: 'Action was not confirmed. Inspect or reconnect before repeating it.' }); }
    finally { busy = false; publish({ busy: false }); }
  };
  return Object.freeze({ getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    connect: token => perform(async () => {
      if (session) return; const current = ++generation; const next = await connectNotebook(token);
      if (disposed || current !== generation) { next.session.dispose(); return; }
      session = next.session; threads = createHeadlessThreadsStore({ client: next.client }); detachSession = session.subscribe(sync); sync();
      await Promise.all([session.open(), threads.refresh()]);
    }),
    disconnect() {
      if (disposed || busy) return; generation++; detachSession?.(); detach.forEach(fn => fn()); session?.dispose(); threads?.dispose();
      session = undefined; threads = undefined; detachSession = undefined; detach = []; watched = [];
      publish({ connected: false, busy: false, phase: 'idle', error: null, threadId: null, runId: null, pending: false, message: null, history: [], threads: [], cursor: null, runStatus: null, approval: null });
    },
    send: message => perform(() => session.send(message)),
    retry: () => perform(() => session.retrySubmission()),
    reconnect: () => perform(() => session.reconnect()),
    cancel: () => perform(() => session.cancel()),
    newThread: () => perform(async () => { await session.newThread(); await threads.refresh(); }),
    select: id => perform(() => session.selectThread(id)),
    list: cursor => perform(() => threads.refresh(cursor ? { cursor } : {})),
    history: options => perform(() => session.refreshHistory(options)),
    decide: decision => perform(async () => {
      const controller = session.getSnapshot().approval; const snapshot = controller?.getSnapshot();
      if (!snapshot || snapshot.status !== 'idle' || snapshot.approval.expiresAtMs <= Date.now()
        || decision === 'approved' && JSON.stringify(snapshot.approval.input).length > 16000) throw new Error('Approval must be refreshed.');
      await controller.submit(decision);
    }),
    dispose() { if (disposed) return; disposed = true; generation++; detachSession?.(); detach.forEach(fn => fn()); session?.dispose(); threads?.dispose(); listeners.clear(); },
  });
}
export const display = value => JSON.stringify(value, null, 2)?.slice(0, 16000) ?? '';
