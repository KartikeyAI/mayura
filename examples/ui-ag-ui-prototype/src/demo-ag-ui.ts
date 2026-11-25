import type { AgUiConversationOptions, AgUiTransport } from '@mayurajs/ui/ag-ui';
import type { AgUiRunInput as MayuraRunInput } from 'mayura/ag-ui';
import { fixtureMedia } from './artifact-fixtures.js';
import { checklistToolId, readChecklistChange } from './change-review.js';

/** The local fixture issues a session token. A real application supplies its own scoped session. */
async function authorized(path: string, signal: AbortSignal, init?: RequestInit): Promise<Response> {
  const session = await fetch('/session', { cache: 'no-store', signal });
  if (!session.ok) throw new Error('Fixture session is unavailable.');
  const { token } = await session.json() as { token?: unknown };
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token)) throw new Error('Invalid fixture token.');
  const headers = new Headers(init?.headers);
  headers.set('Authorization', 'Bearer ' + token);
  return fetch(path, { ...init, cache: 'no-store', headers, signal });
}

async function history(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await authorized(path, signal);
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Thread history is unavailable.');
  }
  return response.json();
}

export const demoTransport: AgUiTransport = {
  run: (input, signal) => authorized('/ag-ui', signal, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(input satisfies MayuraRunInput),
  }),
  async cancel(id, signal) {
    const response = await authorized('/v1/runs/' + encodeURIComponent(id) + '/cancel', signal, { method: 'POST' });
    await response.body?.cancel();
    return response.ok;
  },
  listThreads: signal => history('/history', signal),
  readThread: (id, signal) => history('/history/' + encodeURIComponent(id), signal),
};

export const demoConversationOptions: AgUiConversationOptions = {
  transport: demoTransport,
  mediaPaths: Object.values(fixtureMedia),
  projectStoredAnswer(content) {
    if (!content.startsWith('{')) return content;
    const output = JSON.parse(content) as { reply?: unknown };
    return typeof output.reply === 'string' ? output.reply : content;
  },
  approval: {
    validate: proposal => proposal.toolName === checklistToolId && readChecklistChange(proposal.arguments) !== null,
    toolLabel: toolName => toolName === checklistToolId ? 'Save rollout checklist' : toolName,
    resultStatus({ toolName, approved, content }) {
      if (toolName !== checklistToolId) return 'unconfirmed';
      const result = JSON.parse(content) as { error?: unknown; saved?: unknown };
      if (result.error === 'APPROVAL_REJECTED' && !approved) return 'declined';
      if (typeof result.error === 'string') return 'failed';
      if (approved && result.saved === true) return 'complete';
      throw new Error('Unexpected checklist tool result.');
    },
  },
};
