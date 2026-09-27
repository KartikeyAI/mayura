import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createClient } from 'mayura/client';
import { newToken, tokenDigest } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { deskOutput, type DeskInput } from '../src/desk.js';
import { harlowCreekCorpus } from '../src/library/corpus.js';
import { localLibrary, type SourceLibrary } from '../src/library/index.js';
import { startServer } from '../src/server.js';
import { openServices } from '../src/services.js';
import { createResearchWorker } from '../src/worker.js';
import { researchSlots } from '../src/workflow.js';

// Everything runs offline: the rule-based stand-in models, SQLite and artifacts in a temporary directory, and a
// loopback server driven over real HTTP. Tests drive the worker one cycle at a time instead of starting its timer.
const QUESTION = 'How much did the Harlow Creek microgrid cost, who owns and governs it, and how did its batteries perform during outages?';
const corpusIds = new Set(harlowCreekCorpus.map(document => document.id));

async function harness(env: Record<string, string> = {}, options: { readonly library?: SourceLibrary } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'research-test-'));
  const operatorToken = newToken(); const deskToken = newToken();
  const config = await loadConfig({ MAYURA_ENV: 'development', PORT: '0', MAYURA_SQLITE_PATH: join(directory, 'research.sqlite'),
    RESEARCH_ARTIFACTS_DIR: join(directory, 'artifacts'), MAYURA_OPERATOR_TOKEN_SHA256: tokenDigest(operatorToken),
    MAYURA_DESK_TOKEN_SHA256: tokenDigest(deskToken), ...env });
  const services = await openServices(config, options);
  const server = await startServer(config, services);
  const { host } = createResearchWorker(config, services);
  const desk = createClient({ baseUrl: server.origin, token: () => deskToken });
  const operator = createClient({ baseUrl: server.origin, token: () => operatorToken });
  /** One request to the research desk, over HTTP, to completion. */
  const ask = async (input: DeskInput, idempotencyKey: string) => {
    const run = await desk.submit('research.desk', input, { idempotencyKey });
    for await (const _event of run.events()) { /* The stream ends when the desk run settles. */ }
    return run.result(deskOutput);
  };
  const start = async (requestId: string, question = QUESTION) => {
    const outcome = await ask({ requestId, question }, `desk-${requestId}`);
    assert.equal(outcome?.status, 'succeeded'); return outcome.status === 'succeeded' ? outcome.output : assert.fail();
  };
  const report = async (runId: string, key: string) => {
    const outcome = await ask({ runId }, key);
    assert.equal(outcome?.status, 'succeeded'); return outcome.status === 'succeeded' ? outcome.output : assert.fail();
  };
  /** Run worker cycles until the research run leaves `running`. */
  const settle = async (runId: string) => {
    for (let cycle = 0; cycle < 8; cycle++) { await host.runOnce(); const view = await operator.workflow(runId); if (view.status !== 'running') return view; }
    throw new Error('The research run did not settle.');
  };
  const artifactFiles = async (): Promise<string[]> => {
    try { return (await readdir(join(directory, 'artifacts', 'objects'), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name); }
    catch { return []; }
  };
  return { config, services, host, desk, operator, ask, start, report, settle, artifactFiles, origin: server.origin,
    close: async () => { await host.close(); await server.close(); await services.close(); await rm(directory, { recursive: true, force: true }); } };
}

/** A library whose searches wait until the test releases them, so a running researcher keeps its budget reservation. */
function gatedSearches(): SourceLibrary & { readonly release: () => void } {
  const inner = localLibrary(harlowCreekCorpus); let open: () => void = () => {};
  const gate = new Promise<void>(resolve => { open = resolve; });
  return {
    release: () => open(),
    read: id => inner.read(id),
    async search(query, options) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([gate, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The search was never released.')), 10_000); })]);
      } finally { clearTimeout(timer); }
      return inner.search(query, options);
    },
  };
}

/** A library whose searches wait for each other: it only answers once `expected` searches are in flight at once. */
function overlappingSearches(expected: number): SourceLibrary & { readonly peak: () => number } {
  const inner = localLibrary(harlowCreekCorpus); let active = 0; let peak = 0; const waiting: (() => void)[] = [];
  return {
    peak: () => peak,
    read: id => inner.read(id),
    async search(query, options) {
      active += 1; peak = Math.max(peak, active);
      try {
        if (active >= expected) waiting.splice(0).forEach(release => release());
        else await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Research steps did not run in parallel.')), 10_000);
          waiting.push(() => { clearTimeout(timer); resolve(); });
        });
        return await inner.search(query, options);
      } finally { active -= 1; }
    },
  };
}

describe('research runs', () => {
  it('plans, researches in parallel, writes a cited report and stores it as a content-addressed artifact', async () => {
    const library = overlappingSearches(3);
    const h = await harness({}, { library });
    try {
      const started = await h.start('rq-1');
      assert.equal(started.status, 'running'); assert.equal(started.report, null);

      const done = await h.settle(started.runId);
      assert.equal(done.status, 'succeeded');
      const status = Object.fromEntries(done.steps.map(step => [step.id, step.status]));
      // Three sub-questions: three researchers run, and the fourth slot is bypassed (shown to operators as skipped).
      assert.deepEqual(status, { plan: 'succeeded', 'research.1': 'succeeded', 'research.2': 'succeeded', 'research.3': 'succeeded',
        'research.4': 'skipped', research: 'succeeded', write: 'succeeded', store: 'succeeded' });
      // The three researchers searched at the same time: the library only answers once all three are waiting.
      assert.equal(library.peak(), 3);

      const result = await h.report(started.runId, 'report-rq-1');
      assert.equal(result.status, 'succeeded'); assert.equal(result.stopReason, null);
      const text = result.report ?? assert.fail('The finished run has no report.');
      assert.ok(text.startsWith('# Research brief: How much did the Harlow Creek microgrid cost'));
      for (const heading of ['## How much did the Harlow Creek microgrid cost?', '## Who owns and governs it?', '## How did its batteries perform during outages?', '## Sources']) {
        assert.ok(text.includes(heading), heading);
      }
      // Every citation is a real library document, and so is every source marker in the text.
      assert.ok(result.citations.length >= 3);
      for (const item of result.citations) assert.ok(corpusIds.has(item.sourceId), item.sourceId);
      const markers = [...text.matchAll(/\[([a-z0-9-]+)\]/gu)].map(match => match[1]!);
      assert.ok(markers.length > 0); for (const id of markers) assert.ok(corpusIds.has(id), id);
      assert.ok(text.includes('The microgrid cost 4.8 million dollars to build'));
      assert.ok(result.citations.some(item => item.sourceId === 'hc-finance'));
      // Content-addressed: the digest is the SHA-256 of the exact report bytes read back from the artifact store.
      assert.equal(result.artifactDigest, `sha256:${createHash('sha256').update(text).digest('hex')}`);
      assert.equal((await h.artifactFiles()).length, 1);
      assert.ok(result.budget && result.budget.spentMicros <= result.budget.maxCostMicros);
    } finally { await h.close(); }
  });

  it('starts one run per request id, and refuses a request id reused for a different question', async () => {
    const h = await harness();
    try {
      const first = await h.start('rq-2');
      const again = await h.ask({ requestId: 'rq-2', question: QUESTION }, 'desk-rq-2-retry');
      assert.equal(again?.status, 'succeeded');
      assert.equal(again.status === 'succeeded' && again.output.runId, first.runId);

      const reused = await h.ask({ requestId: 'rq-2', question: 'What did the co-operative learn after two years of operation?' }, 'desk-rq-2-other');
      assert.notEqual(reused?.status, 'succeeded');
      assert.equal((await h.operator.workflows()).items.length, 1);

      const unfinished = await h.report(first.runId, 'report-rq-2');
      assert.equal(unfinished.status, 'running'); assert.equal(unfinished.report, null);
      const missing = await h.report('0'.repeat(64), 'report-missing');
      assert.equal(missing.status, 'not_found');
    } finally { await h.close(); }
  });

  it('stops a run that exhausts its shared budget before any report is written', async () => {
    // Each agent step may spend 1,000 and a step starts only if that ceiling fits in what the run has left. The run may
    // spend 1,500: after the plan, the researchers the plan needs (at least two) start together, and while the first one
    // holds its 1,000 reservation (its searches wait for the test) the others cannot fit and are blocked. Slots the plan
    // did not use are bypassed and reserve nothing. The offline models cost nothing, so nothing is actually charged.
    const library = gatedSearches();
    const h = await harness({ MAYURA_MAX_RUN_COST_MICROS: '1000', RESEARCH_BUDGET_MICROS: '1500' }, { library });
    try {
      const started = await h.start('rq-3');
      const settling = h.settle(started.runId);
      for (let poll = 0; ; poll++) {
        const view = await h.operator.workflow(started.runId);
        if (view.steps.some(step => researchSlots.includes(step.id) && step.status === 'blocked')) break;
        if (poll > 200) assert.fail('No research step was blocked by the budget.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      library.release();
      const stopped = await settling;
      assert.equal(stopped.status, 'blocked');
      const research = stopped.steps.filter(step => researchSlots.includes(step.id));
      const used = research.filter(step => step.status !== 'skipped');
      assert.ok(used.length >= 2, 'The plan uses at least two researchers.');
      assert.equal(research.filter(step => step.status === 'succeeded').length, 1);
      assert.equal(research.filter(step => step.status === 'blocked').length, used.length - 1);
      for (const id of ['research', 'write', 'store']) assert.equal(stopped.steps.find(step => step.id === id)?.status, 'skipped', id);

      const result = await h.report(started.runId, 'report-rq-3');
      assert.equal(result.status, 'blocked'); assert.equal(result.stopReason, 'budget_exhausted');
      assert.equal(result.report, null); assert.equal(result.artifactDigest, null);
      assert.deepEqual(result.budget, { spentMicros: 0, reservedMicros: 0, maxCostMicros: 1_500 });
      assert.deepEqual(await h.artifactFiles(), []);
      // Nothing is retried: another worker cycle leaves the run exactly where it stopped.
      await h.host.runOnce();
      assert.equal((await h.operator.workflow(started.runId)).status, 'blocked');
    } finally { await h.close(); }
  });

  it('keeps callers to their own capabilities', async () => {
    const h = await harness();
    try {
      await assert.rejects(h.desk.workflows(), { status: 403 });
      // The team's agents are invisible to desk callers: the server does not even confirm they exist.
      await assert.rejects(h.desk.submit('research.planner', { question: QUESTION, maxSubQuestions: 2 }, { idempotencyKey: 'planner-1' }), { status: 404 });
      await assert.rejects(h.operator.submit('research.desk', { requestId: 'rq-op', question: QUESTION }, { idempotencyKey: 'operator-1' }), { status: 403 });
      const listed = (await h.operator.agents()).map(agent => agent.id).sort();
      assert.deepEqual(listed, ['research.desk', 'research.planner', 'research.researcher', 'research.writer']);
      const stranger = createClient({ baseUrl: h.origin, token: () => newToken() });
      await assert.rejects(stranger.agents(), { status: 401 });
      // The operator console is served; it asks for the operator token in the browser.
      assert.equal((await fetch(`${h.origin}/inspector`)).status, 200);
    } finally { await h.close(); }
  });
});

describe('telemetry', () => {
  it('exports metadata-only traces to the configured collector and never the research content', async () => {
    const received: { readonly path: string; readonly headers: IncomingHttpHeaders; readonly body: string }[] = [];
    const collector = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk as Buffer));
      request.on('end', () => {
        received.push({ path: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>(resolve => collector.listen(0, '127.0.0.1', resolve));
    const { port } = collector.address() as { port: number };
    const h = await harness({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`, OTEL_EXPORTER_OTLP_HEADERS: 'x-collector-key=test%20key' });
    try {
      const started = await h.start('rq-4');
      assert.equal((await h.settle(started.runId)).status, 'succeeded');
      await h.services.telemetry.flush();

      assert.ok(received.length > 0);
      for (const request of received) { assert.equal(request.path, '/v1/traces'); assert.equal(request.headers['x-collector-key'], 'test key'); }
      type Span = { traceId: string; spanId: string; parentSpanId?: string; name: string };
      const spans = received.flatMap(request => (JSON.parse(request.body) as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] })
        .resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));
      const names = new Set(spans.map(span => span.name));
      for (const name of ['workflow:research.run', 'tool:plan', ...researchSlots.map(id => `tool:${id}`), 'join:research', 'tool:write', 'tool:store',
        'agent:research.planner', 'agent:research.researcher', 'agent:research.writer', 'model.call', 'tool:library.search', 'tool:library.read']) {
        assert.ok(names.has(name), name);
      }
      assert.equal(new Set(spans.map(span => span.traceId)).size, 1);
      // One root, the run; every step hangs off it; every agent run hangs off the step that ran it.
      const roots = spans.filter(span => span.parentSpanId === undefined);
      assert.deepEqual(roots.map(span => span.name), ['workflow:research.run']);
      const byId = new Map(spans.map(span => [span.spanId, span]));
      for (const span of spans.filter(item => item.name.startsWith('agent:'))) {
        assert.ok(/^tool:(plan|research\.\d|write)$/u.test(byId.get(span.parentSpanId ?? '')?.name ?? ''), span.name);
      }
      for (const span of spans) if (span.parentSpanId !== undefined) assert.ok(byId.has(span.parentSpanId), `${span.name} has its parent exported`);
      // No question, finding, source or report text leaves the process: only names, ids and times.
      const exported = received.map(request => request.body).join('\n');
      for (const secret of ['Harlow', 'microgrid', 'batteries', 'co-operative', 'hc-finance', 'Research brief']) assert.ok(!exported.includes(secret), secret);
    } finally { await h.close(); await new Promise(resolve => collector.close(resolve)); }
  });
});

describe('configuration', () => {
  it('runs offline by default and validates production, providers, budgets and telemetry', async () => {
    const config = await loadConfig({});
    assert.equal(config.model.provider, 'offline'); assert.equal(config.storage.kind, 'sqlite'); assert.equal(config.telemetry, undefined);
    assert.deepEqual(config.budget, { stepMicros: 0, runMicros: 0 });
    assert.deepEqual((await loadConfig({ MAYURA_MAX_RUN_COST_MICROS: '1000' })).budget, { stepMicros: 1_000, runMicros: 6_000 });
    await assert.rejects(loadConfig({ MAYURA_MAX_RUN_COST_MICROS: '1000', RESEARCH_BUDGET_MICROS: '999' }), /RESEARCH_BUDGET_MICROS/u);
    await assert.rejects(loadConfig({ MAYURA_ENV: 'production' }), /MAYURA_PUBLIC_ORIGIN/u);
    await assert.rejects(loadConfig({ MAYURA_ENV: 'production', MAYURA_PUBLIC_ORIGIN: 'https://research.example.com' }), /MAYURA_OPERATOR_TOKEN_SHA256/u);
    await assert.rejects(loadConfig({ MAYURA_MODEL_PROVIDER: 'openai' }), /OPENAI_API_KEY/u);
    await assert.rejects(loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.internal:4318' }), /OTEL_EXPORTER_OTLP_ENDPOINT/u);
    await assert.rejects(loadConfig({ OTEL_EXPORTER_OTLP_HEADERS: 'x-key=1' }), /OTEL_EXPORTER_OTLP_ENDPOINT/u);
    await assert.rejects(loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com', OTEL_EXPORTER_OTLP_HEADERS: 'no-value' }), /OTEL_EXPORTER_OTLP_HEADERS/u);
    assert.equal((await loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com/otlp/' })).telemetry?.tracesEndpoint, 'https://collector.example.com/otlp/v1/traces');
    assert.equal((await loadConfig({ DATABASE_URL: 'postgres://research@db/research' })).storage.kind, 'postgres');
  });
});
