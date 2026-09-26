import { createElement as h, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@mayura/client';
import { createWorkflowCommandController } from '@mayura/client/workflows';
import { MayuraFleetHoldControl, MayuraWorkflowGraph, MayuraWorkflowPauseControl } from '@mayura/client-react/components';

const config = await (await fetch('/config.json', { cache: 'no-store' })).json();
// Demo only: the loopback server hands this page a short-lived local token. Real apps use their identity provider.
const client = createClient({ baseUrl: config.apiOrigin, token: () => config.token, requestTimeoutMs: 10_000 });
const commandId = () => crypto.randomUUID();

async function sweepAll(phase) {
  const outcomes = []; let cursor = null; let pages = 0;
  do { const page = await client.sweepWorkflowFleet(phase, { cursor, limit: 64 }); outcomes.push(...page.outcomes); cursor = page.nextCursor; pages++; }
  while (cursor && pages < 512);
  return outcomes;
}

function Run({ view, onChanged }) {
  const [state, setState] = useState(undefined);
  const run = useCallback(action => {
    // A controller is bound to one validated view and revision; each command gets a fresh one.
    const controller = createWorkflowCommandController({ workflow: view, client });
    const unsubscribe = controller.subscribe(() => setState(controller.getSnapshot()));
    setState(controller.getSnapshot());
    controller[action]({ commandId: commandId() }).catch(() => undefined).finally(() => { unsubscribe(); setState(controller.getSnapshot()); onChanged(); });
  }, [view, onChanged]);
  const commandState = state && state.runId === view.runId ? state : undefined;
  return h('article', { 'aria-label': `Run ${view.runId.slice(0, 8)}` },
    h('h3', null, 'Run ', h('code', null, view.runId.slice(0, 12))),
    h(MayuraWorkflowGraph, { input: view, label: `Steps for run ${view.runId.slice(0, 8)}` }),
    h(MayuraWorkflowPauseControl, { workflow: view, commandState, label: `Pause control for run ${view.runId.slice(0, 8)}`, subject: `run ${view.runId.slice(0, 8)}`,
      onPause: () => run('pause'), onResume: () => run('resume') }));
}

function App() {
  const [fleet, setFleet] = useState(null); const [fleetStatus, setFleetStatus] = useState('idle');
  const [views, setViews] = useState([]); const [sweep, setSweep] = useState(null); const [error, setError] = useState(null);
  const refresh = useCallback(async () => {
    try {
      const [hold, page] = await Promise.all([client.workflowFleet(), client.workflows({ limit: 50 })]);
      const loaded = await Promise.all(page.items.map(item => client.workflow(item.runId)));
      setFleet(hold); setViews(loaded); setError(null);
    } catch (failure) { setError(failure?.code ?? 'REFRESH_FAILED'); }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh(); }, 1_500); return () => clearInterval(timer); }, [refresh]);
  const fleetCommand = useCallback(async action => {
    setFleetStatus('submitting');
    try {
      if (action === 'hold') { await client.holdWorkflowFleet(); setSweep({ phase: 'pause', outcomes: await sweepAll('pause') }); }
      else { await client.releaseWorkflowFleet(); setSweep({ phase: 'resume', outcomes: await sweepAll('resume') }); }
      setFleetStatus('succeeded');
    } catch (failure) { setFleetStatus(failure?.status === 409 ? 'conflict' : 'failed'); }
    await refresh();
  }, [refresh]);
  return h('div', null,
    h('h1', null, 'Mayura pause console'),
    h('p', null, 'Live runs from a SQLite lifecycle fleet. Each run drafts slowly, then waits for its publish timer.'),
    error ? h('p', { role: 'alert' }, `Refresh failed (${error}); retrying`) : null,
    h('h2', null, 'Fleet'),
    fleet ? h(MayuraFleetHoldControl, { fleet, status: fleetStatus, onHold: () => fleetCommand('hold'), onRelease: () => fleetCommand('release') }) : h('p', null, 'Loading fleet state…'),
    sweep ? h('section', { 'aria-label': 'Last fleet sweep' }, h('p', null, `Last ${sweep.phase} sweep: ${sweep.outcomes.length} outcome(s)`),
      h('ul', null, sweep.outcomes.map(item => h('li', { key: `${item.target}/${item.runId}` }, `${item.runId.slice(0, 12)}: ${item.outcome}${item.code ? ` (${item.code})` : ''}`)))) : null,
    h('h2', null, 'Runs'),
    views.map(view => h(Run, { key: view.runId, view, onChanged: refresh })));
}

createRoot(document.getElementById('root')).render(h(App));
