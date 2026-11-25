import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AG_UI_PROTOCOL_VERSION } from '@mayurajs/ui/ag-ui';

const require = createRequire(import.meta.url);
const app = fileURLToPath(new URL('../', import.meta.url));
const readPrompt = 'Summarize the release notes';
const writePrompt = 'Save the rollout checklist';
const savedReply = 'Saved Rollout checklist to the Release workspace.';
const expectedChange = {
  title: 'Rollout checklist',
  destination: 'Release workspace',
  content: [
    '1. Confirm the deploy owner, CI, migrations, and staging smoke tests. [1]',
    '2. Start with 5% of traffic. Watch errors and latency for 15 minutes. [2]',
    '3. Revert if the error rate exceeds 1% or p95 latency rises by 20%. [3]',
  ].join('\n'),
};

async function localPort() {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert(address && typeof address !== 'string');
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function launch(t) {
  const port = await localPort();
  const origin = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: app, env: { ...process.env, MAYURA_WORKSPACE_PORT: String(port), NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', part => { log = (log + part).slice(-8_192); });
  child.stderr.on('data', part => { log = (log + part).slice(-8_192); });
  const exited = once(child, 'exit');
  void exited.catch(() => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    const stopped = exited.then(() => true, () => true);
    if (await Promise.race([stopped, delay(5_000, false, { ref: false })])) return;
    child.kill('SIGKILL');
    assert(await Promise.race([stopped, delay(5_000, false, { ref: false })]), 'The test server did not stop.');
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    const page = await fetch(origin, { signal: AbortSignal.timeout(1_000) }).catch(() => undefined);
    if (page?.ok) {
      assert.match(await page.text(), /Support workspace/u);
      return origin;
    }
    await page?.body?.cancel();
    await delay(75);
  }
  assert.fail('The built Next.js workspace did not start.\n' + log);
}

async function frameEvents(response, disconnect) {
  assert.equal(response.status, 200, 'Expected an authorized event stream.');
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/u);
  assert(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith('data: ')) {
          const event = JSON.parse(frame.slice(6));
          events.push(event);
          if (disconnect && event.type === 'STEP_STARTED') {
            disconnect.abort();
            return events;
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
    assert.equal(buffer, '', 'The stream must end at an SSE frame boundary.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  assert(!events.some(event => event.type === 'RUN_ERROR'), 'No event may report a run failure.');
  return events;
}

function latestSnapshot(events) {
  const snapshot = events.findLast(event => event.type === 'MESSAGES_SNAPSHOT');
  assert(snapshot);
  return snapshot.messages;
}

function expectRun(events, threadId, runId, outcome = 'success') {
  const start = events.find(event => event.type === 'RUN_STARTED');
  assert.equal(start?.threadId, threadId);
  assert.equal(start?.metadata.mayura.runId, runId);
  const finish = events.at(-1);
  assert.equal(finish?.type, 'RUN_FINISHED');
  assert.equal(finish?.threadId, threadId);
  assert.equal(finish?.outcome.type, outcome);
  return finish;
}

async function readHistory(base, threadId) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetch(base + '/history/' + threadId, { signal: AbortSignal.timeout(5_000) });
    if (response.status === 409) {
      // The durable history may advance between scoped reads. Only reread this projection.
      await response.body?.cancel();
      await delay(30);
      continue;
    }
    assert.equal(response.status, 200);
    return response.json();
  }
  assert.fail('The scoped history never settled.');
}

test('the built Next.js workspace reconnects, reads citations and resolves one exact approval', { timeout: 60_000 }, async t => {
  const origin = await launch(t);
  const base = origin + '/api/workspace';
  const threadId = randomUUID();
  const post = (input, signal = AbortSignal.timeout(15_000)) => fetch(base + '/ag-ui', {
    method: 'POST', signal, headers: { Origin: origin, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ protocolVersion: AG_UI_PROTOCOL_VERSION, threadId, runId: randomUUID(), ...input }),
  });
  const observe = runId => fetch(base + '/ag-ui?' + new URLSearchParams({ threadId, runId }), {
    signal: AbortSignal.timeout(15_000), headers: { Origin: origin, Accept: 'text/event-stream' },
  });
  const send = (content, signal) => post({ messages: [{ id: randomUUID(), role: 'user', content }] }, signal);

  const deny = await fetch(base + '/history', {
    signal: AbortSignal.timeout(5_000), headers: { Origin: 'https://outside.example' },
  });
  assert.equal(deny.status, 403);
  await deny.body?.cancel();

  const disconnect = new AbortController();
  const sent = await send(readPrompt, AbortSignal.any([disconnect.signal, AbortSignal.timeout(10_000)]));
  const runId = sent.headers.get('x-mayura-run-id');
  assert(runId);
  const partial = await frameEvents(sent, disconnect);
  assert.equal(partial.find(event => event.type === 'RUN_STARTED')?.metadata.mayura.runId, runId);
  assert.equal(partial.at(-1)?.type, 'STEP_STARTED');

  const reopening = await readHistory(base, threadId);
  if (reopening.busy) assert.equal(reopening.activeRunId, runId);
  const followed = await frameEvents(await observe(runId));
  expectRun(followed, threadId, runId);
  assert.equal(followed[0].runId, runId, 'Observation must identify the existing run on the wire.');
  assert.equal(latestSnapshot(followed).filter(message => message.role === 'user' && message.content === readPrompt).length, 1);
  const state = followed.find(event => event.type === 'STATE_SNAPSHOT')?.snapshot;
  assert(state);
  assert.deepEqual(state.citations.find(citation => citation.id === '2'), {
    id: '2', title: 'v1.3 staging notes', detail: 'Canary rollout · page 1',
    excerpt: 'Route 5% of traffic to the candidate. Observe the error rate and p95 latency for 15 minutes before expanding.',
  });
  assert.equal(state.replyCards.find(card => card.type === 'table')?.title, 'Rollout checkpoints');
  const answer = JSON.parse(latestSnapshot(followed).findLast(message => message.role === 'assistant').content).reply;
  assert.match(answer, /5% canary and a 15-minute observation window\. \[2\]/u);

  const proposalResponse = await send(writePrompt);
  const approvalRun = proposalResponse.headers.get('x-mayura-run-id');
  assert(approvalRun);
  const original = expectRun(await frameEvents(proposalResponse), threadId, approvalRun, 'interrupt');
  const resumed = await frameEvents(await observe(approvalRun));
  const observedPause = expectRun(resumed, threadId, approvalRun, 'interrupt');
  assert.equal(observedPause.outcome.interrupts.length, 1);
  const [approval] = observedPause.outcome.interrupts;
  assert.notEqual(approval.id, original.outcome.interrupts[0].id, 'The observation should bind a fresh approval handle.');
  assert.equal(approval.toolCallId, original.outcome.interrupts[0].toolCallId, 'The same underlying proposal must be preserved.');
  assert.equal(resumed.find(event => event.type === 'TOOL_CALL_START' && event.toolCallId === approval.toolCallId)?.toolCallName,
    'workspace.save-checklist');
  const raw = resumed.filter(event => event.type === 'TOOL_CALL_ARGS' && event.toolCallId === approval.toolCallId)
    .map(event => event.delta).join('');
  assert.deepEqual(JSON.parse(raw), expectedChange);

  const confirmed = await frameEvents(await post({
    messages: [], resume: [{ interruptId: approval.id, status: 'resolved', payload: { approved: true } }],
  }));
  expectRun(confirmed, threadId, approvalRun);
  const confirmation = confirmed.filter(event => event.type === 'TOOL_CALL_RESULT' && event.toolCallId === approval.toolCallId);
  assert.equal(confirmation.length, 1);
  assert.deepEqual(JSON.parse(confirmation[0].content), { saved: true });
  const durable = await frameEvents(await observe(approvalRun));
  expectRun(durable, threadId, approvalRun);
  assert.equal(latestSnapshot(durable).filter(message => message.role === 'tool' && message.toolCallId === approval.toolCallId).length, 1);
  const history = await readHistory(base, threadId);
  assert.deepEqual(history.messages.filter(message => message.role === 'user').map(message => message.content), [readPrompt, writePrompt]);
  assert.equal(history.messages.filter(message => message.role === 'assistant' && JSON.parse(message.content).reply === savedReply).length, 1);
  assert.equal(history.interruption, null);
});
