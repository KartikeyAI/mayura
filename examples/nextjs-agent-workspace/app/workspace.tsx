'use client';

import { useState } from 'react';
import { AgentWorkspace } from '@mayurajs/ui';
import type { AgUiTransport } from '@mayurajs/ui/ag-ui';
import { demoConversationOptions } from '../../ui-ag-ui-prototype/src/demo-ag-ui';
import { readChecklistChange } from '../../ui-ag-ui-prototype/src/change-review';

const request = (path: string, signal: AbortSignal, options?: RequestInit) =>
  fetch('/api/workspace' + path, { ...options, signal, cache: 'no-store' });

async function history(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await request(path, signal);
  if (!response.ok) throw Object.assign(new Error('Thread history is unavailable.'), { status: response.status });
  return response.json();
}

const transport: AgUiTransport = {
  run: (input, signal) => request('/ag-ui', signal, {
    method: 'POST', headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }),
  observeRun: (binding, signal) => request('/ag-ui?' + new URLSearchParams({
    threadId: binding.threadId, runId: binding.runId,
  }), signal, { headers: { Accept: 'text/event-stream' } }),
  async cancel(runId, signal) {
    const response = await request('/v1/runs/' + encodeURIComponent(runId) + '/cancel', signal, { method: 'POST' });
    await response.body?.cancel();
    return response.ok;
  },
  listThreads: signal => history('/history', signal),
  readThread: (threadId, signal) => history('/history/' + encodeURIComponent(threadId), signal),
};

function rememberThread(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('thread', id);
  else url.searchParams.delete('thread');
  window.history.replaceState(window.history.state, '', url);
}

export function Workspace({ initialThreadId }: { initialThreadId: string | null }) {
  const [acknowledged, setAcknowledged] = useState(false);
  return <>
    <AgentWorkspace
      transport={transport}
      title="Support workspace"
      emptyTitle="What are we working on?"
      suggestions={['Draft a rollout checklist', 'Summarize the release notes', 'Save the rollout checklist']}
      {...(initialThreadId ? { initialThreadId } : {})}
      onThreadChange={rememberThread}
      approval={demoConversationOptions.approval}
      projectStoredAnswer={demoConversationOptions.projectStoredAnswer}
      reviewChange={proposal => readChecklistChange(proposal.arguments)}
      replyCards={{
        downloadPaths: ['/runbook.txt'],
        confirmActions: [{
          cardId: 'release-plan-review', actionId: 'acknowledge',
          label: 'Mark reviewed', description: 'Mark the rollout checklist as reviewed in this browser view.',
        }],
        onConfirm: () => { setAcknowledged(true); },
      }}
    />
    <p className="sr-only" role="status">{acknowledged ? 'Rollout checklist marked reviewed.' : ''}</p>
  </>;
}
