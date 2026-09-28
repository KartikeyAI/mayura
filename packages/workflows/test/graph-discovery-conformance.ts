import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import type { JsonObject, Scope } from '@mayura/core';
import { createScheduledWorkflowRuntime, defineWorkflow } from '@mayura/workflows';
import { createWorkflowGraphDiscovery, createWorkflowGraphRuntime, defineWorkflowGraph } from '@mayura/workflows/graphs';
import type { WorkflowGraphManifest } from '@mayura/storage-contracts';
import { digest } from '../src/definition.js';
import type { GraphFixture } from './graph-fixtures.js';

type Store = GraphFixture['store'];
type Runtime = ReturnType<typeof createWorkflowGraphRuntime>;
type Discovery = ReturnType<typeof createWorkflowGraphDiscovery>;
type DiscoveryOptions = Parameters<typeof createWorkflowGraphDiscovery>[0];
type RuntimeOptions = Parameters<typeof createWorkflowGraphRuntime>[0];
type Page = Awaited<ReturnType<Discovery['scan']>>;
const scope = { principalId: 'discovery-developer', projectId: 'discovery-project' };
const scopeHash = digest('mayura:scope:v1', scope);
const policy = { scope, permissions: ['tool:discovery.effect', 'effect:write'], policyVersion: 'discovery-policy-1', maxCostMicros: 10, maxOutputBytes: 65_536, approvalTtlMs: 60_000 };
const policyHash = digest('mayura:policy:v1', { ...policy, permissions: [...policy.permissions].sort() });
const result = (stepId: string) => ({ kind: 'step' as const, stepId, path: [] });
const definition = defineWorkflowGraph({ id: 'discovery.graph', version: '1', input: z.unknown(), output: z.unknown(),
  nodes: [{ kind: 'join', id: 'joined', dependsOn: [] }], result: result('joined') });

async function bounded<T>(promise: Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Discovery fixture did not reach its bounded barrier.')), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Paired tests use actual selected SQL adapters; raw SQL is confined to owned fault fixtures. */
export function graphDiscoveryConformance(name: string, factory: () => Promise<GraphFixture>): void {
  describe(`${name} finite graph continuation discovery`, () => {
    let fixture: GraphFixture; let store: Store; let stores: Store[]; let clients: { close(): Promise<void> }[]; let worker = 0;
    const base = () => ({ store, scope, permissions: { allow: policy.permissions }, policyVersion: policy.policyVersion,
      maxCostMicros: policy.maxCostMicros, maxOutputBytes: policy.maxOutputBytes, approvalTtlMs: policy.approvalTtlMs });
    const runtime = (overrides: Partial<RuntimeOptions> = {}): Runtime => {
      const client = createWorkflowGraphRuntime({ ...base(), workerId: `discovery-worker-${++worker}`, ...overrides }); clients.push(client); return client;
    };
    const discover = (overrides: Partial<DiscoveryOptions> = {}): Discovery => {
      const client = createWorkflowGraphDiscovery({ ...base(), ...overrides }); clients.push(client); return client;
    };
    const submit = async (key: string = randomUUID(), engine = runtime()) => engine.submit(definition, { input: 'SECRET_GRAPH_INPUT', idempotencyKey: key });
    const reopen = async () => { const next = fixture.reopen(); stores.push(next); await next.initialize(); await next.workflowGraphs.initialize(); return next; };
    const access = async (id: string, owner: Scope = scope) => {
      const record = await store.read(digest('mayura:scope:v1', owner), id); if (!record || typeof record.state['policy'] !== 'string') throw new Error('Missing discovery fixture record.');
      return { scope: record.scope, id, policyHash: record.state['policy'] };
    };
    const target = async () => {
      const engine = createScheduledWorkflowRuntime({ ...base(), workerId: `discovery-target-${++worker}` }); clients.push(engine);
      const targetDefinition = defineWorkflow({ id: 'discovery.target', version: '1', input: z.unknown(), output: z.unknown(), nodes: [{ kind: 'join', id: 'joined', dependsOn: [] }], result: result('joined') });
      const run = await engine.submit(targetDefinition, { input: 'SECRET_TARGET_INPUT', idempotencyKey: randomUUID() });
      return { engine, run, reference: await engine.reference(run.id) };
    };
    const fingerprint = async () => {
      const tables = ['mayura_aggregates', 'mayura_events', 'mayura_workflow_owners', 'mayura_workflow_wait_targets', 'mayura_scheduler_jobs', 'mayura_execution_completions'];
      return Promise.all(tables.map(async table => ({ table, rows: await fixture.query(`SELECT * FROM ${fixture.prefix}${table} ORDER BY 1,2`) })));
    };
    beforeEach(async () => {
      fixture = await factory(); store = fixture.store; stores = [store]; clients = []; worker = 0;
      await store.initialize(); await store.workflowGraphs.initialize(); await store.workflows.initialize();
    });
    afterEach(async () => { await Promise.all((clients ?? []).map(client => client.close())); await Promise.all((stores ?? []).map(item => item.close())); await fixture?.cleanup(); });

    it('advertises a separate optional capability and returns exact empty metadata', async () => {
      expect(store.workflowGraphDiscovery).toBeDefined();
      expect(await discover().scan()).toEqual({ candidates: [], examined: 0, nextCursor: null });
    });

    it.each(['wrong columns', 'wrong table', 'partial', 'descending', 'wrong collation', 'expression', 'unique'] as const)(
      'rejects a %s discovery index while preserving its native catalog identity and business data', async mismatch => {
        await submit(`index-collision-${mismatch.replaceAll(' ', '-')}`);
        const collation = fixture.dialect === 'postgres' ? '"C"' : 'BINARY';
        const incompatibleCollation = fixture.dialect === 'postgres' ? '"POSIX"' : 'NOCASE';
        let indexedTable = 'mayura_workflow_owners';
        let keys = `scope,policy_hash,profile,aggregate_id COLLATE ${collation}`;
        if (mismatch === 'wrong columns') keys = 'scope';
        if (mismatch === 'wrong table') { indexedTable = 'mayura_aggregates'; keys = 'scope,id'; }
        if (mismatch === 'descending') keys += ' DESC';
        if (mismatch === 'wrong collation') keys = `scope,policy_hash,profile,aggregate_id COLLATE ${incompatibleCollation}`;
        if (mismatch === 'expression') keys = 'scope,policy_hash,profile,lower(aggregate_id)';
        await fixture.query(`CREATE ${mismatch === 'unique' ? 'UNIQUE ' : ''}INDEX mayura_workflow_owners_discovery ON ${fixture.prefix}${indexedTable} (${keys})${mismatch === 'partial' ? ' WHERE profile = 2' : ''}`);
        const catalog = () => fixture.dialect === 'sqlite'
          ? fixture.query('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema WHERE name = ?', ['mayura_workflow_owners_discovery'])
          : fixture.query(`SELECT c.oid::text AS oid,c.relkind,c.relname,i.indrelid::text AS table_oid,pg_get_indexdef(c.oid) AS definition
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_index i ON i.indexrelid = c.oid
              WHERE n.nspname = ? AND c.relname = ?`, [fixture.childConfig.kind === 'postgres' ? fixture.childConfig.schema : '', 'mayura_workflow_owners_discovery']);
        const identity = await catalog(); expect(identity).toHaveLength(1); const before = await fingerprint();
        await expect(store.workflowGraphDiscovery.initialize()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
        await expect(store.workflowGraphDiscovery.scan({ scope: scopeHash, policyHash, cursor: null, limit: 16 })).rejects.toMatchObject({ code: 'INVALID_CONFIG', storageCode: 'STORE_NOT_INITIALIZED' });
        await expect(discover().scan()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
        expect(await catalog()).toEqual(identity); expect(await fingerprint()).toEqual(before);
      });

    it('preserves a same-named table object instead of replacing it with an index', async () => {
      await fixture.query(`CREATE TABLE ${fixture.prefix}mayura_workflow_owners_discovery (fixture_value TEXT NOT NULL)`);
      await fixture.query(`INSERT INTO ${fixture.prefix}mayura_workflow_owners_discovery (fixture_value) VALUES (?)`, ['retained-fixture-value']);
      const catalog = () => fixture.dialect === 'sqlite'
        ? fixture.query('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema WHERE name = ?', ['mayura_workflow_owners_discovery'])
        : fixture.query(`SELECT c.oid::text AS oid,c.relkind,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ? AND c.relname = ?`,
          [fixture.childConfig.kind === 'postgres' ? fixture.childConfig.schema : '', 'mayura_workflow_owners_discovery']);
      const identity = await catalog(); expect(identity).toHaveLength(1);
      await expect(store.workflowGraphDiscovery.initialize()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      expect(await catalog()).toEqual(identity);
      expect(await fixture.query(`SELECT fixture_value FROM ${fixture.prefix}mayura_workflow_owners_discovery`)).toEqual([{ fixture_value: 'retained-fixture-value' }]);
    });

    it('discovers existing owned runs after index provisioning and close/reopen without a backfill', async () => {
      const runs = [await submit(), await submit(), await submit()];
      const indexExists = async () => fixture.dialect === 'sqlite'
        ? fixture.query('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', ['index', 'mayura_workflow_owners_discovery'])
        : fixture.query('SELECT indexname FROM pg_indexes WHERE schemaname = ? AND indexname = ?', [fixture.childConfig.kind === 'postgres' ? fixture.childConfig.schema : '', 'mayura_workflow_owners_discovery']);
      expect(await indexExists()).toEqual([]);
      const before = await fingerprint(); const first = await discover().scan();
      expect(first.candidates.map(candidate => candidate.reference.runId)).toEqual(runs.map(run => run.id).sort()); expect(first.examined).toBe(3); expect(first.nextCursor).toBeNull();
      expect(await indexExists()).toHaveLength(1); expect(await fingerprint()).toEqual(before);
      await store.close(); store = await reopen();
      expect(await discover().scan()).toEqual(first);
    });

    it('paginates ordered examined owners, requiring an empty scan after an exactly full final page', async () => {
      const engine = runtime(); const runs = [];
      for (let index = 0; index < 6; index++) runs.push(await submit(`page-${index}`, engine));
      const ordered = runs.map(run => run.id).sort(); const client = discover(); const pages: Page[] = [];
      let cursor: Page['nextCursor'] = null;
      do { const page = await client.scan({ ...(cursor ? { cursor } : {}), limit: 2 }); pages.push(page); cursor = page.nextCursor; } while (cursor && pages.length < 5);
      expect(pages.map(page => page.examined)).toEqual([2, 2, 2, 0]); expect(pages.flatMap(page => page.candidates.map(candidate => candidate.reference.runId))).toEqual(ordered);
      expect(pages.slice(0, 3).map(page => page.nextCursor)).toEqual([1, 3, 5].map(index => ({ format: 1, scope: scopeHash, policyHash, afterId: ordered[index] })));
      expect(pages.at(-1)!.nextCursor).toBeNull(); expect(Object.isFrozen(pages[0])).toBe(true); expect(Object.isFrozen(pages[0]!.candidates[0]!.reference)).toBe(true);
    });

    it('advances over terminal history even when full pages contain no candidates', async () => {
      const engine = runtime(); const runs = [];
      for (let index = 0; index < 4; index++) { const run = await submit(`terminal-${index}`, engine); runs.push(run); await engine.runUntilSettled(definition, run.id); }
      const client = discover(); const first = await client.scan({ limit: 2 });
      expect(first).toMatchObject({ candidates: [], examined: 2, nextCursor: { afterId: runs.map(run => run.id).sort()[1] } });
      const second = await client.scan({ cursor: first.nextCursor!, limit: 2 }); expect(second).toMatchObject({ candidates: [], examined: 2 }); expect(second.nextCursor).not.toBeNull();
      expect(await client.scan({ cursor: second.nextCursor!, limit: 2 })).toEqual({ candidates: [], examined: 0, nextCursor: null });
    });

    it('returns a short mixed page without treating its useful candidate count as the scan bound', async () => {
      const engine = runtime(); const runs = [await submit('mixed-a', engine), await submit('mixed-b', engine), await submit('mixed-c', engine)];
      await engine.cancel(runs[1]!.id); const page = await discover().scan({ limit: 4 });
      expect(page.examined).toBe(3); expect(page.nextCursor).toBeNull(); expect(page.candidates.map(candidate => candidate.reference.runId)).toEqual([runs[0]!.id, runs[2]!.id].sort());
    });

    it('isolates scope and policy and excludes legacy scheduled-v1 owners', async () => {
      const own = await submit('same-key'); const otherScope = { ...scope, principalId: 'other-principal' };
      const foreign = await submit('same-key', runtime({ scope: otherScope })); const changed = await submit('other-policy', runtime({ policyVersion: 'another-policy' })); await target();
      const page = await discover().scan(); expect(page.candidates.map(candidate => candidate.reference.runId)).toEqual([own.id]); expect(page.examined).toBe(1);
      expect((await discover({ scope: otherScope }).scan()).candidates.map(candidate => candidate.reference.runId)).toEqual([foreign.id]);
      expect((await discover({ policyVersion: 'another-policy' }).scan()).candidates.map(candidate => candidate.reference.runId)).toEqual([changed.id]);
      const cursor = (await discover().scan({ limit: 1 })).nextCursor!;
      await expect(discover({ scope: otherScope }).scan({ cursor })).rejects.toBeDefined(); await expect(discover({ policyVersion: 'another-policy' }).scan({ cursor })).rejects.toBeDefined();
    });

    it('preserves running and waiting candidates without modifying events, jobs, budgets or targets', async () => {
      const source = await target(); const engine = runtime(); const running = await submit('running', engine);
      const waitingDefinition = defineWorkflowGraph({ id: 'discovery.wait', version: '1', input: z.unknown(), output: z.unknown(), nodes: [{ kind: 'wait', id: 'wait', targets: { kind: 'literal', value: [source.reference] } }], result: result('wait') });
      const waiting = await engine.submit(waitingDefinition, { input: 'SECRET_PARENT_INPUT', idempotencyKey: 'waiting' }); await engine.runUntilSettled(waitingDefinition, waiting.id);
      const before = await fingerprint(); const client = discover();
      for (let index = 0; index < 8; index++) {
        const page = await client.scan(); expect(page.candidates.map(candidate => candidate.reference.runId)).toEqual([running.id, waiting.id].sort());
        expect(page.candidates.find(candidate => candidate.reference.runId === waiting.id)!.status).toBe('waiting'); expect(JSON.stringify(page)).not.toContain('SECRET');
      }
      expect(await fingerprint()).toEqual(before);
    });

    it('uses candidate versions as observations rather than dispatch authorization after cancellation', async () => {
      let effects = 0; const tool = defineTool({ id: 'discovery.effect', version: '1', description: 'Controlled discovered effect', input: z.unknown(), output: z.unknown(), effects: 'write', capabilities: [], costMicros: 1, timeoutMs: 5_000, execute: () => { effects++; return null; } });
      const effectDefinition = defineWorkflowGraph({ id: 'discovery.effect-graph', version: '1', input: z.unknown(), output: z.unknown(), nodes: [{ kind: 'tool', id: 'effect', tool, input: { kind: 'literal', value: null } }], result: result('effect') });
      const engine = runtime(); const run = await engine.submit(effectDefinition, { input: null, idempotencyKey: 'stale-hint' }); const hint = (await discover().scan()).candidates[0]!;
      await engine.cancel(run.id); const current = await engine.runUntilSettled(effectDefinition, hint.reference.runId);
      expect(current.status).toBe('cancelled'); expect(current.version).toBeGreaterThan(hint.version); expect(effects).toBe(0); expect((await discover().scan()).candidates).toEqual([]);
    });

    it('restarts a sweep to find later inserts before an earlier cursor without claiming stable membership', async () => {
      const engine = runtime(); const first = await submit('cursor-existing', engine); const client = discover(); const full = await client.scan({ limit: 1 });
      let earlierKey = '';
      for (let index = 0; index < 10_000; index++) { const key = `insert-earlier-${index}`; if (digest('mayura:run-id:v1', { scope: scopeHash, submissionKey: key }) < first.id) { earlierKey = key; break; } }
      expect(earlierKey).not.toBe(''); const inserted = await submit(earlierKey, engine);
      expect((await client.scan({ cursor: full.nextCursor!, limit: 32 })).candidates).toEqual([]);
      expect((await client.scan()).candidates.map(candidate => candidate.reference.runId)).toEqual([inserted.id, first.id].sort());
    });

    it.each(['state', 'owner-version', 'owner-data'] as const)('fails the whole page on selected %s corruption without exposing private data', async mutation => {
      const run = await submit(); const client = discover(); await client.scan();
      if (mutation === 'state') await fixture.query(`UPDATE ${fixture.prefix}mayura_aggregates SET state = ? WHERE scope = ? AND id = ?`, ['SECRET_BROKEN_JSON', scopeHash, run.id]);
      else if (mutation === 'owner-version') await fixture.query(`UPDATE ${fixture.prefix}mayura_workflow_owners SET aggregate_version = aggregate_version + 1 WHERE scope = ? AND aggregate_id = ?`, [scopeHash, run.id]);
      else {
        const rows = await fixture.query(`SELECT data FROM ${fixture.prefix}mayura_workflow_owners WHERE scope = ? AND aggregate_id = ?`, [scopeHash, run.id]);
        const data = JSON.parse(rows[0]!['data'] as string) as JsonObject; data['SECRET_extra'] = 'SECRET_DATA';
        await fixture.query(`UPDATE ${fixture.prefix}mayura_workflow_owners SET data = ? WHERE scope = ? AND aggregate_id = ?`, [JSON.stringify(data), scopeHash, run.id]);
      }
      const outcome = await Promise.allSettled([client.scan()]); expect(outcome[0]!.status).toBe('rejected'); expect(JSON.stringify(outcome)).not.toContain('SECRET');
      if (outcome[0]!.status === 'rejected') expect(String(outcome[0]!.reason)).not.toContain('SECRET');
    });

    it('validates terminal selected parents rather than silently skipping their corrupt history', async () => {
      const engine = runtime(); const run = await submit('terminal-corrupt', engine); await engine.runUntilSettled(definition, run.id);
      await fixture.query(`UPDATE ${fixture.prefix}mayura_workflow_owners SET aggregate_version = aggregate_version + 1 WHERE scope = ? AND aggregate_id = ?`, [scopeHash, run.id]);
      await expect(discover().scan()).rejects.toBeDefined();
    });

    it('does not inspect corruption beyond the examined-row limit until a later page', async () => {
      const engine = runtime(); const runs = [await submit('bound-a', engine), await submit('bound-b', engine)].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      await fixture.query(`UPDATE ${fixture.prefix}mayura_workflow_owners SET aggregate_version = aggregate_version + 1 WHERE scope = ? AND aggregate_id = ?`, [scopeHash, runs[1]!.id]);
      const client = discover(); const first = await client.scan({ limit: 1 }); expect(first.candidates[0]!.reference.runId).toBe(runs[0]!.id);
      await expect(client.scan({ cursor: first.nextCursor!, limit: 1 })).rejects.toBeDefined();
    });

    it('never acquires a target aggregate lock while validating a waiting parent candidate', async () => {
      if (fixture.dialect !== 'postgres') return;
      const source = await target(); const engine = runtime(); const wait = defineWorkflowGraph({ id: 'discovery.lock-order', version: '1', input: z.unknown(), output: z.unknown(), nodes: [{ kind: 'wait', id: 'wait', targets: { kind: 'literal', value: [source.reference] } }], result: result('wait') });
      const run = await engine.submit(wait, { input: null, idempotencyKey: 'locked-target' }); await engine.runUntilSettled(wait, run.id); const client = discover(); await client.scan();
      const release = await fixture.lockAggregate(scopeHash, source.run.id);
      try { expect((await bounded(client.scan())).candidates.map(candidate => candidate.reference.runId)).toEqual([run.id]); }
      finally { await release(); }
    }, 25_000);

    it('rejects invalid examined limits and closing discovery leaves caller-owned storage available', async () => {
      await submit(); const client = discover();
      for (const limit of [0, -1, 33, 1.5, Number.NaN]) await expect(client.scan({ limit })).rejects.toBeDefined();
      await client.close(); await expect(client.scan()).rejects.toMatchObject({ code: 'CANCELLED' }); expect((await discover().scan()).candidates).toHaveLength(1);
    });

    it.each(['finalize', 'prepare'] as const)('rediscovers a parent killed after wait resolution before %s', async continuation => {
      const source = await target(); const engine = runtime(); let effects = 0;
      const tool = defineTool({ id: 'discovery.effect', version: '1', description: 'Controlled discovered continuation', input: z.unknown(), output: z.unknown(), effects: 'write', capabilities: [], costMicros: 1, timeoutMs: 5_000, execute: () => { effects++; return 'done'; } });
      const nodes: Parameters<typeof defineWorkflowGraph>[0]['nodes'] = [{ kind: 'wait', id: 'wait', targets: { kind: 'literal', value: [source.reference] } },
        ...(continuation === 'prepare' ? [{ kind: 'tool' as const, id: 'effect', dependsOn: ['wait'], tool, input: result('wait') }] : [])];
      const graph = defineWorkflowGraph({ id: 'discovery.crash', version: '1', input: z.unknown(), output: z.unknown(), nodes, result: result(continuation === 'prepare' ? 'effect' : 'wait') });
      const run = await engine.submit(graph, { input: null, idempotencyKey: `crash-${continuation}` }); await engine.runUntilSettled(graph, run.id); await source.engine.cancel(source.run.id);
      const key = await access(run.id); const before = await store.workflowGraphs.inspect(key);
      const command = { ...key, expectedVersion: before.record.version, commandId: randomUUID() };
      const child = fork(fileURLToPath(new URL('./fixtures/graph-child.mjs', import.meta.url)), [JSON.stringify({ phase: 'resolution-after', backend: fixture.childConfig, command })], { silent: true, windowsHide: true, execArgv: [] });
      let exited = false; const exit = new Promise<void>(resolve => { child.once('exit', () => { exited = true; resolve(); }); child.once('error', () => { exited = true; resolve(); }); });
      try {
        await bounded(new Promise<void>((resolve, reject) => {
          child.on('message', message => { if (message && typeof message === 'object' && 'kind' in message && message.kind === 'checkpoint') resolve(); else reject(new Error('Discovery child did not reach its committed checkpoint.')); });
          child.once('exit', () => reject(new Error('Discovery child exited before checkpoint.'))); child.once('error', () => reject(new Error('Discovery child could not start.')));
        }));
      } finally { if (!exited) child.kill('SIGKILL'); await bounded(exit); }
      await store.close(); store = await reopen(); const client = discover(); const page = await client.scan();
      expect(page.candidates).toHaveLength(1); expect(page.candidates[0]!).toMatchObject({ reference: { runId: run.id }, status: 'running' });
      expect((await store.workflowGraphs.inspect(key)).jobs).toEqual([]); expect(effects).toBe(0);
      const resumed = await runtime().runUntilSettled(graph, page.candidates[0]!.reference.runId);
      expect(resumed.status).toBe('succeeded'); expect(effects).toBe(continuation === 'prepare' ? 1 : 0); expect((await client.scan()).candidates).toEqual([]);
    }, 30_000);

    it('uses the configured discovery index in actual unforced plans over populated ownership history', async () => {
      const manifest: WorkflowGraphManifest = { format: 3, id: 'discovery.plan-fixture', version: '1', graph: [{ kind: 'join', id: 'joined', dependsOn: [] }], result: result('joined') };
      // Isolate planner evidence from an unrelated older snapshot delaying the
      // eligibility of a newly built index over pre-existing HOT chains. Reopen
      // and HOT-specific tests independently cover initialization after data.
      const client = discover(); await client.scan();
      // These are valid owned runs, not synthetic corrupt rows: all remain inspectable.
      for (let index = 0; index < 1_024; index++) await store.workflowGraphs.submit({ manifest, policy: { ...policy, policyVersion: `plan-policy-${index % 64}` }, resources: {}, input: null, idempotencyKey: `plan-filler-${index}` });
      const run = await submit('plan-selected'); await client.scan();
      const collate = fixture.dialect === 'postgres' ? '"C"' : 'BINARY';
      const sql = `SELECT aggregate_id FROM ${fixture.prefix}mayura_workflow_owners WHERE scope = ? AND policy_hash = ? AND profile = 2 AND aggregate_id COLLATE ${collate} > ? ORDER BY aggregate_id COLLATE ${collate} LIMIT ?`;
      if (fixture.dialect === 'postgres') await fixture.query(`ANALYZE ${fixture.prefix}mayura_workflow_owners`);
      else await fixture.query('ANALYZE mayura_workflow_owners');
      const plan = await fixture.query(`${fixture.dialect === 'postgres' ? 'EXPLAIN (FORMAT JSON)' : 'EXPLAIN QUERY PLAN'} ${sql}`, [scopeHash, policyHash, '', 16]);
      const serialized = JSON.stringify(plan); expect(serialized).toContain('mayura_workflow_owners_discovery');
      if (fixture.dialect === 'sqlite') { expect(serialized).toContain('SEARCH'); expect(serialized).not.toContain('USE TEMP B-TREE'); }
      else { expect(serialized).toMatch(/Index (Only )?Scan/); expect(serialized).not.toContain('Seq Scan'); }
      expect((await client.scan()).candidates.map(candidate => candidate.reference.runId)).toEqual([run.id]);
    }, 120_000);

    it('accepts the full32 examined-owner limit and enforces a smaller next-page budget independently', async () => {
      const engine = runtime(); for (let index = 0; index < 33; index++) await submit(`max-page-${index}`, engine);
      const client = discover(); const first = await client.scan({ limit: 32 }); expect(first.examined).toBe(32); expect(first.candidates).toHaveLength(32); expect(first.nextCursor).not.toBeNull();
      const last = await client.scan({ cursor: first.nextCursor!, limit: 2 }); expect(last.examined).toBe(1); expect(last.candidates).toHaveLength(1); expect(last.nextCursor).toBeNull();
    });
  });
}
