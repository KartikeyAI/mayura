import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { createScheduledWorkflowRuntime, defineWorkflow, defineWorkflowMigration } from '../src/index.js';
import { createWorkflowLifecycleRuntime, defineWorkflowLifecycle } from '../src/lifecycle.js';
import { graphSqliteFixture, type GraphFixture } from './graph-fixtures.js';
import { prng, type Random } from './property-random.js';

/*
 * Property tests across planner, runtime and storage. For generated definitions, progress and target versions:
 * an allowed plan must apply and the run must then finish on the new version without re-running a completed effect;
 * a refused plan must leave the run exactly as it was. Replay a failure with MAYURA_PROPERTY_SEED.
 */
const runs = Number(process.env['MAYURA_RUNTIME_PROPERTY_RUNS'] ?? 30);
const baseSeed = Number(process.env['MAYURA_PROPERTY_SEED'] ?? 20260927);
const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'property', validate: value => ({ value: value as JsonValue }) } };
const scope = { principalId: 'property', projectId: 'property' };
const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const executions = new Map<string, number>();
const tools = new Map(ids.flatMap(id => [0, 1, 2].map(variant => [`${id}${variant}`, defineTool({ id: `prop.${id}.${variant}`, version: '1', description: 'counted',
  input: any, output: any, effects: 'none', capabilities: [], costMicros: 0,
  execute: () => { executions.set(`${id}${variant}`, (executions.get(`${id}${variant}`) ?? 0) + 1); return `${id}${variant}`; } })] as const)));
const permissions = [...tools.values()].map(tool => `tool:${tool.id}`);

interface Spec { readonly id: string; readonly kind: 'tool' | 'timer'; readonly variant: number; readonly dependsOn: readonly string[]; readonly approval: boolean }
function source(random: Random, allowTimers: boolean): Spec[] {
  const chosen = random.shuffle(ids.slice(0, 6)).slice(0, 2 + random.int(4)); const specs: Spec[] = [];
  for (const id of chosen) specs.push({ id, kind: allowTimers && random.chance(0.35) ? 'timer' : 'tool', variant: random.int(3), approval: random.chance(0.35),
    dependsOn: specs.filter(() => random.chance(0.4)).map(spec => spec.id) });
  return specs;
}
function evolve(random: Random, from: readonly Spec[], allowTimers: boolean) {
  const to: Spec[] = []; const renames: Record<string, string> = {}; const unused = ids.filter(id => !from.some(spec => spec.id === id));
  for (const spec of from) {
    if (random.chance(0.15)) continue;
    let id = spec.id;
    if (random.chance(0.1) && unused.length) { id = unused.splice(random.int(unused.length), 1)[0]!; renames[id] = spec.id; }
    const alias = (dependency: string) => Object.entries(renames).find(([, original]) => original === dependency)?.[0] ?? dependency;
    to.push({ ...spec, id, variant: random.chance(0.3) ? random.int(3) : spec.variant,
      dependsOn: spec.dependsOn.map(alias).filter(dependency => to.some(item => item.id === dependency)) });
  }
  while (random.chance(0.35) && unused.length) {
    const id = unused.splice(random.int(unused.length), 1)[0]!;
    to.push({ id, kind: allowTimers && random.chance(0.3) ? 'timer' : 'tool', variant: random.int(3), approval: random.chance(0.3), dependsOn: to.filter(() => random.chance(0.3)).map(spec => spec.id) });
  }
  if (!to.length) to.push({ id: unused[0] ?? 'h', kind: 'tool', variant: 0, approval: false, dependsOn: [] });
  return { to, renames, acceptCompleted: to.filter(() => random.chance(0.35)).map(spec => spec.id),
    acceptRemoved: from.filter(spec => !to.some(item => item.id === spec.id) && random.chance(0.5)).map(spec => spec.id) };
}
// Timers read their fire time from the input: variant 0 fires at 50 (already due), others at 5,000 (still waiting).
const lifecycle = (name: string, specs: readonly Spec[]) => defineWorkflowLifecycle({ id: 'property', version: name, input: any, output: any,
  nodes: specs.map(spec => spec.kind === 'timer'
    ? { kind: 'timer' as const, id: spec.id, dependsOn: [...spec.dependsOn], fireAtMs: { kind: 'input' as const, path: [spec.variant === 0 ? 'soon' : 'later'] } }
    : { kind: 'tool' as const, id: spec.id, dependsOn: [...spec.dependsOn], tool: tools.get(`${spec.id}${spec.variant}`)!, input: { kind: 'input' as const, path: [] } }),
  result: { kind: 'input', path: [] } });
const scheduled = (name: string, specs: readonly Spec[]) => defineWorkflow({ id: 'property-scheduled', version: name, input: any, output: any,
  nodes: specs.map(spec => ({ kind: 'tool' as const, id: spec.id, dependsOn: [...spec.dependsOn], tool: tools.get(`${spec.id}${spec.variant}`)!,
    input: { kind: 'input' as const, path: [] }, approval: spec.approval })),
  result: { kind: 'input', path: [] } });
const toolOf = (specs: readonly Spec[], id: string): string | undefined => { const spec = specs.find(item => item.id === id); return spec?.kind === 'tool' ? `${spec.id}${spec.variant}` : undefined; };

describe('migration properties across planner, runtime and SQLite storage', () => {
  let fixture: GraphFixture;
  beforeAll(async () => { fixture = await graphSqliteFixture(); await fixture.store.initialize(); });
  afterAll(async () => { await fixture.store.close(); await fixture.cleanup(); });

  it(`lifecycle: allowed plans apply and finish without re-running effects; refused plans change nothing (${runs} cases)`, async () => {
    const clock = { value: 100 };
    const runtime = createWorkflowLifecycleRuntime({ store: fixture.store, scope, permissions: { allow: permissions }, policyVersion: '1', maxCostMicros: 0, now: () => clock.value });
    let allowed = 0; let refused = 0;
    for (let index = 0; index < runs; index++) {
      const seed = baseSeed + index; const random = prng(seed); const label = `MAYURA_PROPERTY_SEED=${seed}`;
      const fromSpecs = source(random, true); const { to: toSpecs, renames, acceptCompleted, acceptRemoved } = evolve(random, fromSpecs, true);
      const from = lifecycle(`1-${seed}`, fromSpecs); const to = lifecycle(`2-${seed}`, toSpecs);
      let migration; try { migration = defineWorkflowMigration({ id: `life-${seed}`, from, to, renames, acceptCompleted, acceptRemoved }); } catch { continue; }
      clock.value = 100; executions.clear();
      const run = await runtime.submit(from, { input: { soon: 50, later: 5_000 }, idempotencyKey: `life-${seed}` });
      if (['succeeded', 'failed'].includes((await runtime.runUntilSettled(from, run.id)).status)) continue; // finished before it could be paused
      await runtime.pause(run.id);
      const before = await runtime.inspect(run.id); const ranBefore = new Map(executions);
      const { plan } = await runtime.migrate(migration, { id: run.id, actorId: 'property', commandId: `c-${seed}`, dryRun: true });
      if (!plan.allowed) {
        refused++;
        await expect(runtime.migrate(migration, { id: run.id, actorId: 'property', commandId: `c-${seed}` }), label).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await runtime.inspect(run.id), label).toEqual(before);
        continue;
      }
      allowed++;
      const applied = await runtime.migrate(migration, { id: run.id, actorId: 'property', commandId: `c-${seed}` })
        .catch((error: Error) => { throw new Error(`${label}: an allowed plan failed to apply: ${error.message}
${JSON.stringify({ fromSpecs, toSpecs, renames, acceptCompleted, acceptRemoved, steps: before.steps, plan }, null, 1)}`); });
      for (const entry of plan.entries) if (entry.action === 'keep' || entry.action === 'accept') expect(applied.snapshot!.steps[entry.target!], label).toEqual(before.steps[entry.source!]);
      await runtime.resume(run.id); clock.value = 10_000;
      expect((await runtime.runUntilSettled(to, run.id)).status, label).toBe('succeeded');
      // A kept or accepted step that already succeeded never runs its effect again.
      for (const entry of plan.entries) if ((entry.action === 'keep' || entry.action === 'accept') && entry.status === 'succeeded') {
        const tool = toolOf(fromSpecs, entry.source!); if (tool) expect(executions.get(tool), `${label} re-ran ${entry.source}`).toBe(ranBefore.get(tool));
      }
    }
    runtime.close();
    expect(allowed, 'the generator must produce allowed migrations').toBeGreaterThan(runs / 10);
    expect(refused, 'the generator must produce refused migrations').toBeGreaterThan(runs / 10);
  }, Math.max(120_000, runs * 4_000));

  it(`scheduled: storage accepts every plan the runtime allows and refuses nothing silently (${runs} cases)`, async () => {
    const human = 'property-human';
    // A lease far above runner stalls: with the 3 s default, a starved Windows CI worker lost a started step's lease and
    // the run rightly ended outcome_unknown, which cannot be paused. This property is about migrations, not expiry.
    const runtime = createScheduledWorkflowRuntime({ store: fixture.store, scope, permissions: { allow: permissions }, policyVersion: '1', maxCostMicros: 0,
      maxOutputBytes: 65_536, approvalTtlMs: 600_000, workerId: 'property-worker', leaseMs: 30_000,
      verifyHuman: async credential => { if (credential !== human) throw new Error('unverified'); return { id: 'property-human', projectId: scope.projectId, canApprove: true }; } });
    const approveAll = async (definition: ReturnType<typeof scheduled>, id: string, random?: Random) => {
      for (let round = 0; round < 12; round++) {
        const snapshot = await runtime.runUntilSettled(definition, id);
        const waiting = Object.entries(snapshot.steps).filter(([, step]) => step.status === 'waiting' && step.approval && (!random || random.chance(0.5)));
        if (!waiting.length) return snapshot;
        for (const [nodeId, step] of waiting) await runtime.approve({ id, nodeId, digest: step.approval!.digest, credential: human });
      }
      return runtime.inspect(id);
    };
    let allowed = 0; let refused = 0;
    for (let index = 0; index < runs; index++) {
      const seed = baseSeed + 1_000 + index; const random = prng(seed); const label = `MAYURA_PROPERTY_SEED=${seed}`;
      const fromSpecs = source(random, false); const { to: toSpecs, renames, acceptCompleted, acceptRemoved } = evolve(random, fromSpecs, false);
      const from = scheduled(`1-${seed}`, fromSpecs); const to = scheduled(`2-${seed}`, toSpecs);
      let migration; try { migration = defineWorkflowMigration({ id: `sched-${seed}`, from, to, renames, acceptCompleted, acceptRemoved }); } catch { continue; }
      executions.clear();
      const run = await runtime.submit(from, { input: null, idempotencyKey: `sched-${seed}` });
      await approveAll(from, run.id, random); // random partial progress: some approvals granted, some pending
      if (['succeeded', 'failed'].includes((await runtime.inspect(run.id)).status)) continue;
      await runtime.pause(run.id);
      const before = await runtime.inspect(run.id); const ranBefore = new Map(executions);
      const { plan } = await runtime.migrate(migration, { id: run.id, actorId: 'property', commandId: `c-${seed}`, dryRun: true });
      if (!plan.allowed) {
        refused++;
        await expect(runtime.migrate(migration, { id: run.id, actorId: 'property', commandId: `c-${seed}` }), label).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await runtime.inspect(run.id), label).toEqual(before);
        continue;
      }
      allowed++;
      // The storage transaction re-verifies independently; an allowed plan it refuses would be a planner/storage mismatch.
      const applied = await runtime.migrate(migration, { id: run.id, actorId: 'property', commandId: `c-${seed}` }).catch((error: Error) => { throw new Error(`${label}: storage refused an allowed plan: ${error.message}`); });
      for (const entry of plan.entries) if (entry.action === 'keep' || entry.action === 'accept') expect(applied.snapshot!.steps[entry.target!], label).toEqual(before.steps[entry.source!]);
      await runtime.resume(run.id);
      expect((await approveAll(to, run.id)).status, label).toBe('succeeded');
      for (const entry of plan.entries) if ((entry.action === 'keep' || entry.action === 'accept') && entry.status === 'succeeded') {
        const tool = toolOf(fromSpecs, entry.source!); if (tool) expect(executions.get(tool), `${label} re-ran ${entry.source}`).toBe(ranBefore.get(tool));
      }
    }
    await runtime.close();
    expect(allowed, 'the generator must produce allowed migrations').toBeGreaterThan(runs / 10);
    expect(refused, 'the generator must produce refused migrations').toBeGreaterThan(runs / 10);
  }, Math.max(120_000, runs * 4_000));
});
