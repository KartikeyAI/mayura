import { ClientError, createClient } from '@mayura/client';
import { createWorkflowLifecycleFleetRuntime } from '@mayura/workflows/lifecycle';
import { newToken, tokenDigest } from './auth.js';
import { loadConfig } from './config.js';
import { intakeOutput } from './intake.js';
import { startServer } from './server.js';
import { openServices } from './services.js';
import { createRefundWorker } from './worker.js';

// Local development in one process: server and worker on SQLite, fresh tokens printed once, a few demo refunds.
// Production runs `npm run serve` and `npm run worker` as separate processes instead (see README).
const operatorToken = newToken(); const intakeToken = newToken();
const config = await loadConfig({ ...process.env, MAYURA_ENV: 'development',
  MAYURA_OPERATOR_TOKEN_SHA256: tokenDigest(operatorToken), MAYURA_INTAKE_TOKEN_SHA256: tokenDigest(intakeToken) });
const services = await openServices(config);
const server = await startServer(config, services);
const { worker } = createRefundWorker(config, services); worker.start();

// Demo data: three refund requests through the intake agent, and one run on workflow v1 so the console can show a
// reviewed migration to v2. Each uses a fixed idempotency key. On a restart the server's durable submission journal
// refuses the repeated keys (HTTP 409) instead of starting duplicates, and the demo keeps the runs it already has.
const intake = createClient({ baseUrl: server.origin, token: () => intakeToken });
const requests = [
  { ticketId: 'T-100', customerId: 'cus-ada', orderId: 'ord-1001', amountCents: 4_999, reason: 'The mug arrived cracked.' },
  { ticketId: 'T-101', customerId: 'cus-grace', orderId: 'ord-2001', amountCents: 18_450, reason: 'My parcel never arrived.' },
  { ticketId: 'T-102', customerId: 'cus-ada', orderId: 'ord-1002', amountCents: 129_900, reason: 'Not what I expected.' },
];
const opened = [];
for (const request of requests) {
  let run;
  try { run = await intake.submit('refunds.intake', request, { idempotencyKey: `dev-${request.ticketId}` }); }
  catch (error) {
    if (error instanceof ClientError && error.status === 409) { opened.push({ ticketId: request.ticketId, status: 'opened on an earlier run' }); continue; }
    throw error;
  }
  for await (const _event of run.events()) { /* The stream ends when the run settles. */ }
  const outcome = await run.result(intakeOutput);
  opened.push(outcome?.status === 'succeeded' ? outcome.output : { ticketId: request.ticketId, status: outcome?.status ?? 'running' });
}
// Submit through the fleet runtime so the run is indexed for the worker and the console.
const runtimeForSeed = createWorkflowLifecycleFleetRuntime(services.runtimeOptions);
await runtimeForSeed.submit(services.workflows.v1, { idempotencyKey: 'rf-T-099', input: { refundId: 'rf-T-099', customerId: 'cus-ada',
  orderId: 'ord-1001', amountCents: 1_500, currency: 'USD', reason: 'Shipping was late.', category: 'other', riskTier: 'low',
  summary: 'Partial refund for late shipping (started on workflow v1).' } });
runtimeForSeed.close();

console.log(JSON.stringify({
  console: `${server.origin}/inspector`,
  operatorToken, intakeToken,
  opened,
  next: 'Open the console, paste the operator token, and approve a refund. The worker issues it within a second.',
}, null, 2));

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) process.exit(1); stopping = true;
  await worker.drain({ timeoutMs: 10_000 }); await server.close(); await services.close();
};
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
