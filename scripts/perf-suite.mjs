// Performance suite for the framework plan §21.3 reference targets, on declared hardware.
//   node scripts/perf-suite.mjs [--waits 10000] [--records 50000] [--postgres]
// Measures framework compute only: models and tools are local, zero-latency fixtures, and human waiting time is
// replaced by an injected clock. Writes a JSON report under .artifacts/ and prints it.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir, totalmem, arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = path => import(pathToFileURL(join(workspace, 'packages', ...path.split('/'))).href);
const option = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : Number(process.argv[index + 1]); };
const waits = option('--waits', 10_000); const records = option('--records', 50_000);
const { createSqliteStore, createPostgresStore } = await load('storage/dist/index.js');
const { createWorkflowLifecycleFleetRuntime, defineWorkflowLifecycle } = await load('workflows/dist/lifecycle.js');
const { createRuntime, defineAgent } = await load('runtime/dist/index.js');
const { defineTool } = await load('tools/dist/index.js');
const { createNativeMemory, hashingEmbedder } = await load('memory/dist/index.js');

const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)]; };
const summary = values => ({ n: values.length, p50: +percentile(values, 50).toFixed(2), p95: +percentile(values, 95).toFixed(2), max: +Math.max(...values).toFixed(2) });
const rssMb = () => +(process.memoryUsage().rss / 1_048_576).toFixed(1);
const root = await mkdtemp(join(tmpdir(), 'mayura-perf-'));
const openStore = async name => {
  const store = process.argv.includes('--postgres')
    ? createPostgresStore({ connectionString: process.env.MAYURA_TEST_POSTGRES_URL, schema: `mayura_perf_${name}_${Date.now()}` })
    : createSqliteStore({ filename: join(root, `${name}.sqlite`) });
  await store.initialize(); return store;
};
const any = { '~standard': { version: 1, vendor: 'perf', validate: value => ({ value }) } };
const results = {};

try {
  // 1. Suspended waits: many durable timer waits held in storage, with no thread, process or model context per wait.
  {
    const store = await openStore('waits'); const clock = { value: 1_000 };
    const runtime = createWorkflowLifecycleFleetRuntime({ store, scope: { principalId: 'perf', projectId: 'waits' }, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0, now: () => clock.value });
    const timer = defineWorkflowLifecycle({ id: 'perf-timer', version: '1', input: any, output: any,
      nodes: [{ kind: 'timer', id: 'wake', fireAtMs: { kind: 'input', path: ['at'] } }], result: { kind: 'step', stepId: 'wake', path: [] } });
    const before = rssMb(); const started = performance.now(); const ids = [];
    for (let index = 0; index < waits; index++) {
      const run = await runtime.submit(timer, { input: { at: 5_000 }, idempotencyKey: `wait-${index}` });
      await runtime.runUntilSettled(timer, run.id); ids.push(run.id);
    }
    const suspendMs = performance.now() - started; const heldRss = rssMb();
    // 2. Wakeup: advance the clock and measure per-run dispatch of a due wait to completion (framework compute only).
    clock.value = 5_000; const wake = [];
    for (const id of ids.slice(0, Math.min(1_000, ids.length))) {
      const at = performance.now(); const done = await runtime.runUntilSettled(timer, id); wake.push(performance.now() - at);
      assert.equal(done.status, 'succeeded');
    }
    results.suspendedWaits = { waits, suspendSeconds: +(suspendMs / 1_000).toFixed(1), perWaitMs: +(suspendMs / waits).toFixed(2),
      rssBeforeMb: before, rssWhileSuspendedMb: heldRss, activeHandles: process.getActiveResourcesInfo().length, wakeupMs: summary(wake) };
    runtime.close(); await store.close();
  }

  // 3. Scheduling overhead and cancellation for ephemeral runs.
  {
    const tool = defineTool({ id: 'perf.echo', version: '1', description: 'echo', input: any, output: any, effects: 'none', capabilities: [], execute: value => value });
    let step = 0;
    const model = { id: 'perf', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0,
      generate: async () => (step++ % 2 === 0 ? { type: 'tool_calls', calls: [{ id: `c${step}`, toolId: 'perf.echo', input: 1 }], usage: { costMicros: 0 } } : { type: 'final', output: 1, usage: { costMicros: 0 } }) };
    const agent = defineAgent({ id: 'perf', version: '1', instructions: 'x', input: any, output: any, tools: [tool], model });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:perf', 'tool:perf.echo'] }, limits: { maxConcurrentRuns: 64 } });
    const overhead = [];
    for (let index = 0; index < 2_000; index++) { const at = performance.now(); const outcome = await runtime.submit(agent, { input: 1 }).result(); overhead.push(performance.now() - at); assert.equal(outcome.status, 'succeeded'); }
    const hanging = defineAgent({ id: 'hang', version: '1', instructions: 'x', input: any, output: any, tools: [],
      model: { ...model, id: 'perf', generate: request => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) } });
    const cancel = [];
    for (let index = 0; index < 100; index++) {
      const handle = runtime.submit(hanging, { input: 1 }); await new Promise(done => setTimeout(done, 1));
      const at = performance.now(); handle.cancel(); const outcome = await handle.result(); cancel.push(performance.now() - at);
      assert.equal(outcome.status, 'cancelled');
    }
    results.ephemeral = { runWithOneToolCallMs: summary(overhead), cancellationToTerminalMs: summary(cancel) };
    await runtime.close();
  }

  // 4. Native memory at scale: load, lexical and semantic latency, and IVF recall against exact search.
  {
    const store = await openStore('memory'); await store.memory.initialize();
    const words = Array.from({ length: 400 }, (_, index) => `w${index.toString(36)}`);
    const embedder = hashingEmbedder({ dimensions: 128 });
    const memory = createNativeMemory({ store, scope: { principalId: 'perf', projectId: 'memory' }, embedder,
      permissions: { allow: ['memory:read', 'memory:write', 'memory:index'] } });
    const provenance = { sourceId: 'perf', reference: 'perf://corpus', revision: '1', sha256: 'a'.repeat(64), author: 'perf', observedAt: '2026-01-01T00:00:00.000Z', origin: 'observed', confidence: 1 };
    let seed = 7; const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
    const sentence = () => Array.from({ length: 12 }, () => words[Math.floor(random() ** 2 * words.length)]).join(' ');
    const loadStarted = performance.now();
    for (let index = 0; index < records; index++) await memory.add({ id: `r${index}`, content: sentence(), provenance });
    const loadSeconds = (performance.now() - loadStarted) / 1_000;
    // The corpus is Zipf-like: the first words appear in about half of all records (a worst case for postings), while
    // uniformly sampled vocabulary terms approximate typical queries.
    const lexical = []; const typical = [];
    for (let index = 0; index < 100; index++) { const at = performance.now(); await memory.search(`${words[index]} ${words[index + 1]}`, { limit: 10 }); lexical.push(performance.now() - at); }
    for (let index = 0; index < 100; index++) { const at = performance.now(); await memory.search(`${words[200 + (index * 7) % 200]} ${words[100 + (index * 13) % 300]}`, { limit: 10 }); typical.push(performance.now() - at); }
    const indexStarted = performance.now(); let report;
    do report = await memory.index({ limit: 999 }); while (report.remaining);
    const indexSeconds = (performance.now() - indexStarted) / 1_000;
    const semantic = [];
    for (let index = 0; index < 50; index++) { const at = performance.now(); await memory.semanticSearch(sentence(), { limit: 10 }); semantic.push(performance.now() - at); }
    results.memory = { records, loadSeconds: +loadSeconds.toFixed(1), perAddMs: +(loadSeconds * 1_000 / records).toFixed(2), lexicalCommonTermsMs: summary(lexical), lexicalTypicalTermsMs: summary(typical),
      indexSeconds: +indexSeconds.toFixed(1), ivfLists: report.lists, semanticSearchMs: summary(semantic) };
    // Recall on the first `recallSize` records: IVF against an exact scan of the same vectors.
    const exact = createNativeMemory({ store, scope: { principalId: 'perf', projectId: 'memory' }, embedder, exactThreshold: 1_000_000, permissions: { allow: ['memory:read'] } });
    let found = 0; let total = 0;
    for (let index = 0; index < 20; index++) {
      const query = sentence();
      const truth = new Set((await exact.semanticSearch(query, { limit: 10 })).hits.map(hit => hit.record.id));
      found += (await memory.semanticSearch(query, { limit: 10 })).hits.filter(hit => truth.has(hit.record.id)).length; total += truth.size;
    }
    results.memory.recallAt10 = +(found / total).toFixed(3); results.memory.recallCorpus = records;
    await store.close();
  }

  const report = {
    status: 'measured', measuredAt: new Date().toISOString(),
    hardware: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length, memoryGb: +(totalmem() / 1_073_741_824).toFixed(1) },
    runtime: { node: process.version }, storage: process.argv.includes('--postgres') ? 'postgresql' : 'sqlite (WAL, synchronous=FULL)',
    exclusions: 'Models and tools are zero-latency local fixtures; human wait is replaced by an injected clock; provider/network time is excluded.',
    targets: {
      suspendedWaits: { target: '10,000 suspended waits without a thread/process/model context per wait', met: results.suspendedWaits.waits >= 10_000 },
      wakeupP95: { target: 'synthetic local dispatch/wakeup p95 <= 100 ms', p95: results.suspendedWaits.wakeupMs.p95, met: results.suspendedWaits.wakeupMs.p95 <= 100 },
      cancellation: { target: 'local cancellation stops owned work within 5 s', max: results.ephemeral.cancellationToTerminalMs.max, met: results.ephemeral.cancellationToTerminalMs.max <= 5_000 },
      recall: { target: 'IVF recall@10 >= 0.9 against exact search', value: results.memory.recallAt10, met: results.memory.recallAt10 >= 0.9 },
    },
    results,
  };
  await mkdir(join(workspace, '.artifacts'), { recursive: true });
  const path = join(workspace, '.artifacts', `perf-${Date.now()}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, report: path }, null, 2));
} finally { await rm(root, { recursive: true, force: true }).catch(() => {}); }
