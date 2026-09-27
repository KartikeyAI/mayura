import { setTimeout as sleep } from 'node:timers/promises';
import { ClientError, createClient } from 'mayura/client';
import { devSecrets, tokenDigest } from './auth.js';
import { loadConfig } from './config.js';
import { deskOutput, type DeskInput, type DeskOutput } from './desk.js';
import { startServer } from './server.js';
import { openServices } from './services.js';
import { createResearchWorker } from './worker.js';

// Local development in one process: server and worker on SQLite, tokens kept in .data/dev-secrets.json across restarts, one demo research run.
// Production runs `npm run serve` and `npm run worker` as separate processes instead (see README).
const { operatorToken, deskToken } = await devSecrets(['operatorToken', 'deskToken']);
const config = await loadConfig({ ...process.env, MAYURA_ENV: 'development',
  MAYURA_OPERATOR_TOKEN_SHA256: tokenDigest(operatorToken), MAYURA_DESK_TOKEN_SHA256: tokenDigest(deskToken) });
const services = await openServices(config);
const server = await startServer(config, services);
const { worker } = createResearchWorker(config, services); worker.start();

const desk = createClient({ baseUrl: server.origin, token: () => deskToken });
async function ask(input: DeskInput, idempotencyKey: string): Promise<DeskOutput | undefined> {
  const run = await desk.submit('research.desk', input, { idempotencyKey });
  for await (const _event of run.events()) { /* The stream ends when the desk run settles. */ }
  const outcome = await run.result(deskOutput);
  return outcome?.status === 'succeeded' ? outcome.output : undefined;
}

// Demo data: one research request with a fixed request id. On a restart the server's durable submission journal
// refuses the repeated desk idempotency key (HTTP 409) and the demo keeps the run it already has.
const question = 'How much did the Harlow Creek microgrid cost, who owns and governs it, and how did its batteries perform during outages?';
let demo: Record<string, unknown>;
try {
  const started = await ask({ requestId: 'demo-1', question }, 'dev-demo-1');
  if (!started) throw new Error('The research desk did not start the demo run.');
  // The worker picks the run up within a second; the offline team finishes in well under one.
  let report = started;
  for (let attempt = 0; attempt < 30 && ['running', 'waiting'].includes(report.status); attempt++) {
    await sleep(500);
    report = (await ask({ runId: started.runId }, `dev-report-${started.runId.slice(0, 12)}-${attempt}`)) ?? report;
  }
  demo = { runId: started.runId, status: report.status, title: report.title, citations: report.citations.map(item => item.sourceId), artifactDigest: report.artifactDigest };
} catch (error) {
  if (!(error instanceof ClientError && error.status === 409)) throw error;
  demo = { status: 'started on an earlier run; open the console to see it' };
}

console.log(JSON.stringify({
  console: `${server.origin}/inspector`,
  operatorToken, deskToken,
  demo,
  next: 'Open the console, paste the operator token and open Workflows to see the research run step by step. Ask the desk for the report with { runId } and the desk token.',
}, null, 2));

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) process.exit(1); stopping = true;
  await worker.drain({ timeoutMs: 10_000 }); await server.close(); await services.close();
};
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
