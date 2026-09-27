import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createClient, type MayuraClient, type RemoteRun } from 'mayura/client';
import { createWorkflowLifecycleFleetRuntime } from 'mayura/workflows/lifecycle';
import { newToken, tokenDigest } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { intakeOutput, type IntakeInput } from '../src/intake.js';
import { startServer } from '../src/server.js';
import { openServices } from '../src/services.js';
import { createRefundWorker } from '../src/worker.js';

// Everything runs offline: the rule-based intake model, SQLite in a temporary directory and a loopback server.
async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'refunds-test-'));
  const operatorToken = newToken(); const intakeToken = newToken();
  const config = await loadConfig({ MAYURA_ENV: 'development', PORT: '0', MAYURA_SQLITE_PATH: join(directory, 'refunds.sqlite'),
    MAYURA_OPERATOR_TOKEN_SHA256: tokenDigest(operatorToken), MAYURA_INTAKE_TOKEN_SHA256: tokenDigest(intakeToken), REFUND_LIMIT_CENTS: '100000' });
  const services = await openServices(config);
  const server = await startServer(config, services);
  // Tests drive the worker one cycle at a time instead of starting its timer.
  const { host } = createRefundWorker(config, services);
  const intake = createClient({ baseUrl: server.origin, token: () => intakeToken });
  const operator = createClient({ baseUrl: server.origin, token: () => operatorToken });
  /** Run worker cycles until the run leaves `running`. */
  const settle = async (runId: string) => {
    for (let cycle = 0; cycle < 8; cycle++) { await host.runOnce(); const view = await operator.workflow(runId); if (view.status !== 'running') return view; }
    throw new Error('The run did not settle.');
  };
  return { config, services, host, intake, operator, settle, origin: server.origin,
    close: async () => { await host.close(); await server.close(); await services.close(); await rm(directory, { recursive: true, force: true }); } };
}

async function finish(run: RemoteRun) {
  for await (const _event of run.events()) { /* The stream ends when the run settles. */ }
  return run.result(intakeOutput);
}
const request = (overrides: Partial<IntakeInput> = {}): IntakeInput =>
  ({ ticketId: 'T-1', customerId: 'cus-ada', orderId: 'ord-1001', amountCents: 4_999, reason: 'The mug arrived cracked.', ...overrides });
async function open(intake: MayuraClient, input: IntakeInput) {
  const outcome = await finish(await intake.submit('refunds.intake', input, { idempotencyKey: `intake-${input.ticketId}` }));
  assert.equal(outcome?.status, 'succeeded'); return outcome.status === 'succeeded' ? outcome.output : assert.fail();
}

describe('refund approvals', () => {
  it('opens a durable refund through the intake agent and pays only after an operator approves it', async () => {
    const h = await harness();
    try {
      const opened = await open(h.intake, request());
      assert.deepEqual({ refundId: opened.refundId, category: opened.category, riskTier: opened.riskTier }, { refundId: 'rf-T-1', category: 'damaged', riskTier: 'low' });

      const waiting = await h.settle(opened.runId);
      assert.equal(waiting.status, 'waiting'); assert.equal(waiting.definitionVersion, '2');
      const issue = waiting.steps.find(step => step.id === 'issue');
      assert.equal(issue?.status, 'waiting');
      // The operator sees exactly what will be paid, with the currency from the order system rather than the model.
      assert.equal(issue?.approval?.subject?.toolId, 'refunds.issue');
      const payment = issue?.approval?.subject?.input as { refundId: string; amountCents: number; currency: string };
      assert.deepEqual([payment.refundId, payment.amountCents, payment.currency], ['rf-T-1', 4_999, 'USD']);

      await h.operator.approveWorkflow(opened.runId, { revision: waiting.revision, nodeId: 'issue', approvalDigest: issue!.approval!.digest }, { commandId: 'approve-1' });
      const done = await h.settle(opened.runId);
      assert.equal(done.status, 'succeeded');
      assert.deepEqual(done.steps.map(step => [step.id, step.status]), [['policy', 'succeeded'], ['issue', 'succeeded'], ['notify', 'succeeded']]);

      // A retried intake request finds the same run instead of opening a second refund.
      const again = await open(h.intake, request());
      assert.equal(again.runId, opened.runId);
    } finally { await h.close(); }
  });

  it('migrates a run started on v1 to v2 in place after the operator reviews the plan', async () => {
    const h = await harness();
    try {
      const runtime = createWorkflowLifecycleFleetRuntime(h.services.runtimeOptions);
      const started = await runtime.submit(h.services.workflows.v1, { idempotencyKey: 'rf-legacy', input: { refundId: 'rf-legacy', customerId: 'cus-ada',
        orderId: 'ord-1001', amountCents: 1_500, currency: 'USD', reason: 'Late delivery.', category: 'other', riskTier: 'low', summary: 'Late delivery goodwill.' } });
      runtime.close();
      const waiting = await h.settle(started.id);
      assert.equal(waiting.definitionVersion, '1');

      const [offer] = await h.operator.workflowMigrations(started.id);
      assert.equal(offer?.id, 'refunds-approval-1-to-2');
      // The dry run shows what happens to every step; applying it needs the run paused first.
      const preview = await h.operator.planWorkflowMigration(started.id, offer.id);
      assert.deepEqual(preview.entries.map(entry => [entry.action, entry.target]), [['keep', 'policy'], ['keep', 'issue'], ['add', 'notify']]);
      assert.equal(preview.allowed, false);
      const paused = await h.operator.pauseWorkflow(started.id, waiting.revision, { commandId: 'pause-legacy' });
      assert.equal((await h.operator.planWorkflowMigration(started.id, offer.id)).allowed, true);
      const migrated = await h.operator.migrateWorkflow(started.id, offer.id, paused.revision, { commandId: 'migrate-legacy' });
      assert.equal(migrated.workflow.definitionVersion, '2');
      await h.operator.resumeWorkflow(started.id, migrated.workflow.revision, { commandId: 'resume-legacy' });

      const review = await h.settle(started.id);
      const issue = review.steps.find(step => step.id === 'issue')!;
      await h.operator.approveWorkflow(started.id, { revision: review.revision, nodeId: 'issue', approvalDigest: issue.approval!.digest }, { commandId: 'approve-legacy' });
      const done = await h.settle(started.id);
      assert.equal(done.status, 'succeeded');
      assert.equal(done.steps.find(step => step.id === 'notify')?.status, 'succeeded');
    } finally { await h.close(); }
  });

  it('refuses a refund for someone else\'s order before any workflow starts, and one over the policy limit before any payment', async () => {
    const h = await harness();
    try {
      const foreign = await finish(await h.intake.submit('refunds.intake', request({ ticketId: 'T-2', customerId: 'cus-grace' }), { idempotencyKey: 'intake-T-2' }));
      assert.notEqual(foreign?.status, 'succeeded');
      assert.deepEqual((await h.operator.workflows()).items, []);

      const large = await open(h.intake, request({ ticketId: 'T-3', orderId: 'ord-1002', amountCents: 129_900, reason: 'Not what I expected.' }));
      assert.equal(large.riskTier, 'high');
      const refused = await h.settle(large.runId);
      assert.equal(refused.status, 'failed');
      assert.equal(refused.steps.find(step => step.id === 'policy')?.status, 'failed');
      assert.notEqual(refused.steps.find(step => step.id === 'issue')?.status, 'succeeded');
    } finally { await h.close(); }
  });

  it('keeps callers to their own capabilities', async () => {
    const h = await harness();
    try {
      await assert.rejects(h.intake.workflows(), { status: 403 });
      const stranger = createClient({ baseUrl: h.origin, token: () => newToken() });
      await assert.rejects(stranger.agents(), { status: 401 });
    } finally { await h.close(); }
  });
});

describe('configuration', () => {
  it('runs offline by default and requires an origin and operator tokens in production', async () => {
    const config = await loadConfig({});
    assert.equal(config.model.provider, 'offline'); assert.equal(config.storage.kind, 'sqlite');
    await assert.rejects(loadConfig({ MAYURA_ENV: 'production' }), /MAYURA_PUBLIC_ORIGIN/u);
    await assert.rejects(loadConfig({ MAYURA_ENV: 'production', MAYURA_PUBLIC_ORIGIN: 'https://refunds.example.com' }), /MAYURA_OPERATOR_TOKEN_SHA256/u);
    await assert.rejects(loadConfig({ MAYURA_MODEL_PROVIDER: 'openai' }), /OPENAI_API_KEY/u);
    assert.equal((await loadConfig({ DATABASE_URL: 'postgres://refunds@db/refunds' })).storage.kind, 'postgres');
  });
});
