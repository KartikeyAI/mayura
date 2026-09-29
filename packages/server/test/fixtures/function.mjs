// One "function invocation", as on a serverless platform: a fresh process that handles one call, prints what it
// returned, then stops at once (process.exit), the way a platform stops or freezes an instance once it has responded.
// Nothing started during the invocation gets to continue after it. The state lives in a SQLite file in the directory.
//
//   node function.mjs <directory> submit <request|background>
//   node function.mjs <directory> read <runId>
//   node function.mjs <directory> workflow-submit <count>
//   node function.mjs <directory> worker-once <budgetMs> [hang]
//   node function.mjs <directory> workflow-read <runId,runId,...>
//
// CLOCK_OFFSET_MS moves this invocation's workflow clock forward, standing in for time passing between invocations.
import { appendFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
// Public entry points only, exactly as a function in an application would import them.
import { defineAgent, defineTool } from 'mayura';
import { createAgentServer } from 'mayura/server';
import { createAggregateRunRecords } from 'mayura/storage-contracts';
import { createSqliteStore } from 'mayura/storage-sqlite';
import { createWorkflowLeadership, createWorkflowWorker } from 'mayura/workflows';
import { createWorkflowLifecycleHost, defineWorkflowLifecycle } from 'mayura/workflows/lifecycle';

const [directoryArgument, command, argument, extra] = process.argv.slice(2);
const directory = resolve(directoryArgument ?? '');
if (!basename(directory).startsWith('mayura-serverless-')) throw new Error('Unexpected fixture directory.');
const offset = Number(process.env.CLOCK_OFFSET_MS ?? 0);
const now = () => Date.now() + offset;
const store = createSqliteStore({ filename: join(directory, 'state.sqlite') });
await store.initialize();
const finish = (result) => { process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0)); };

const any = { '~standard': { version: 1, vendor: 'serverless-fixture', validate: value => ({ value }) } };
const scope = { principalId: 'fn', projectId: 'serverless' };
const identity = { scope, agentIds: ['answer'], capabilities: ['runs:submit', 'runs:read'], expiresAtMs: Date.now() + 60_000 };

if (command === 'submit' || command === 'read') {
  // The model takes a moment, so a run in background mode is still going when the invocation stops.
  const model = { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0,
    async generate() { await new Promise(done => setTimeout(done, 300)); return { type: 'final', output: { answer: 42 }, usage: { costMicros: 0 } }; } };
  const agent = defineAgent({ id: 'answer', version: '1', instructions: 'Answer.', input: any, output: any, tools: [], model });
  const api = createAgentServer({
    publicOrigin: 'https://fn.example.test', mounted: true, authenticate: async () => identity,
    agents: [{ agent, permissions: { allow: ['model:fixture'] } }],
    runRecords: createAggregateRunRecords(store),
    ...(command === 'submit' && argument === 'request' ? { runExecution: 'request' } : {}),
    limits: { runLeaseMs: 1_000, runRecordPollMs: 50 },
  });
  const headers = { authorization: 'Bearer fixture', 'content-type': 'application/json' };
  if (command === 'submit') {
    const response = await api.fetch(new Request('http://internal/v1/runs', { method: 'POST',
      headers: { ...headers, 'idempotency-key': `question-${argument}` }, body: JSON.stringify({ agentId: 'answer', input: {} }) }));
    finish({ http: response.status, body: await response.json() });
  } else {
    const response = await api.fetch(new Request(`http://internal/v1/runs/${argument}`, { headers }));
    finish({ http: response.status, body: await response.json() });
  }
} else {
  // A workflow whose one step charges an order: each call is appended to a ledger, so repeats would show.
  const ledger = join(directory, 'effects.ndjson');
  const hang = extra === 'hang';
  const charge = defineTool({ id: 'orders.charge', version: '1', description: 'Charge an order.', input: any, output: any,
    effects: 'write', capabilities: [], costMicros: 1, timeoutMs: 5_000,
    execute: async input => {
      appendFileSync(ledger, `${JSON.stringify(input)}\n`);
      if (hang) { writeFileSync(join(directory, 'hanging'), 'yes'); await new Promise(() => {}); }
      return input;
    } });
  const flow = defineWorkflowLifecycle({ id: 'orders.flow', version: '1', input: any, output: any,
    nodes: [{ kind: 'tool', id: 'charge', tool: charge, input: { kind: 'input', path: [] } }],
    result: { kind: 'step', stepId: 'charge', path: [] } });
  const host = createWorkflowLifecycleHost({ store, scope, definitions: [flow], permissions: { allow: ['tool:orders.charge', 'effect:write'] },
    policyVersion: '1', maxCostMicros: 1_000, now, pageLimit: 2, maxPagesPerCycle: 1 });
  if (command === 'workflow-submit') {
    const ids = [];
    for (let index = 0; index < Number(argument); index++) ids.push((await host.runtime.submit(flow, { input: { order: index }, idempotencyKey: `order-${index}` })).id);
    finish({ ids });
  } else if (command === 'workflow-read') {
    const runs = await Promise.all(argument.split(',').map(id => host.runtime.inspect(id)));
    finish({ runs: runs.map(run => ({ id: run.id, status: run.status, step: run.steps.charge.status })) });
  } else if (command === 'worker-once') {
    const leadership = createWorkflowLeadership({ store, scope, role: 'workflows', holderId: `invocation-${process.pid}`, now });
    finish({ report: await createWorkflowWorker({ units: [host], leadership, now }).runOnce({ budgetMs: Number(argument) }) });
  } else throw new Error('Unknown fixture command.');
}
