import { describe, expect, it } from 'vitest';
import { defineWorkflowMigration, planWorkflowMigration, type MigrationNode, type MigrationPlan } from '../src/index.js';
import { prng, type Random } from './property-random.js';

/*
 * Property tests for the migration planner. Each case is generated from a seed; a failure prints the seed so the exact
 * case can be replayed with MAYURA_PROPERTY_SEED. MAYURA_PROPERTY_RUNS raises the case count for longer local runs.
 */
const runs = Number(process.env['MAYURA_PROPERTY_RUNS'] ?? 400);
const baseSeed = Number(process.env['MAYURA_PROPERTY_SEED'] ?? 20260927);
const statuses = ['pending', 'waiting', 'approved', 'forward_waiting', 'compensation_waiting', 'dispatching', 'unknown', 'leased', 'started', 'running',
  'succeeded', 'failed', 'blocked', 'skipped', 'timed_out', 'compensated'] as const;
const unstarted = new Set(['pending']);
const parked = new Set(['waiting', 'approved', 'forward_waiting', 'compensation_waiting']);
const inFlight = new Set(['dispatching', 'unknown', 'leased', 'started', 'running']);
const succeeded = new Set(['succeeded', 'compensated']);
const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
const kinds = ['tool', 'join', 'human', 'timer'];
const digestA = 'a'.repeat(64); const digestB = 'b'.repeat(64);

function graph(random: Random, pool: readonly string[], size: number): MigrationNode[] {
  const chosen = random.shuffle(pool).slice(0, size);
  return chosen.map((id, index) => { const kind = random.pick(kinds);
    return { id, kind, fingerprint: `f${random.int(3)}`, ...(kind === 'tool' ? { evidence: `tool:t${random.int(2)}` } : {}),
      dependsOn: chosen.slice(0, index).filter(() => random.chance(0.35)) }; });
}
/** A target version derived from the source: nodes kept, changed, dropped, added and renamed at random. */
function evolve(random: Random, from: readonly MigrationNode[]) {
  const to: MigrationNode[] = []; const renames: Record<string, string> = {};
  const unused = ids.filter(id => !from.some(node => node.id === id));
  for (const node of from) {
    if (random.chance(0.15)) continue; // dropped
    let id = node.id;
    if (random.chance(0.12) && unused.length) { id = unused.splice(random.int(unused.length), 1)[0]!; renames[id] = node.id; }
    const changed = random.chance(0.3); const kind = random.chance(0.1) ? random.pick(kinds) : node.kind;
    const evidence = kind !== 'tool' ? undefined : changed && random.chance(0.5) ? `tool:t${random.int(2)}` : node.evidence ?? 'tool:t0';
    to.push({ id, kind, fingerprint: changed ? `f${random.int(3)}` : node.fingerprint, ...(evidence ? { evidence } : {}),
      dependsOn: node.dependsOn.map(dependency => Object.entries(renames).find(([, source]) => source === dependency)?.[0] ?? dependency)
        .filter(dependency => to.some(item => item.id === dependency)) });
  }
  while (random.chance(0.3) && unused.length) {
    const id = unused.splice(random.int(unused.length), 1)[0]!;
    to.push({ id, kind: random.pick(kinds), fingerprint: `f${random.int(3)}`, dependsOn: to.filter(() => random.chance(0.3)).map(node => node.id) });
  }
  if (random.chance(0.05) && unused.length) renames[unused[0]!] = random.pick(ids); // occasionally an invalid rename
  const acceptCompleted = to.filter(() => random.chance(0.3)).map(node => node.id);
  const acceptRemoved = from.filter(() => random.chance(0.3)).map(node => node.id).filter(id => !to.some(node => node.id === id));
  return { to, renames, acceptCompleted, acceptRemoved };
}

function generate(seed: number) {
  const random = prng(seed);
  const from = graph(random, ids.slice(0, 7), 1 + random.int(6));
  const { to, renames, acceptCompleted, acceptRemoved } = evolve(random, from);
  const steps = from.map(node => ({ id: node.id, status: random.pick(statuses) as string }));
  let migration: ReturnType<typeof defineWorkflowMigration>;
  // Malformed declarations (for example two renames of one source) are rejected before any planning.
  try { migration = defineWorkflowMigration({ id: `m-${seed}`, from: {}, to: {}, renames, acceptCompleted, acceptRemoved }); } catch { return null; }
  const plan = planWorkflowMigration({ migration, format: 'property', runId: 'r'.repeat(64), fromDigest: digestA, toDigest: digestB, from, to, steps });
  return { from, to, steps, migration, plan };
}

/** Every invariant an allowed plan must satisfy; returns the first violation or null. */
function violation(input: NonNullable<ReturnType<typeof generate>>): string | null {
  const { from, to, steps, migration, plan } = input;
  const status = new Map(steps.map(step => [step.id, step.status]));
  const source = new Map(from.map(node => [node.id, node])); const target = new Map(to.map(node => [node.id, node]));
  if (plan.allowed !== (plan.blockers.length === 0)) return 'allowed must mean no blockers';
  if (!plan.allowed) return null;
  const targets = plan.entries.filter(entry => entry.target).map(entry => entry.target!);
  if (targets.length !== to.length || new Set(targets).size !== to.length || to.some(node => !targets.includes(node.id))) return 'every target node exactly once';
  const sources = plan.entries.filter(entry => entry.source).map(entry => entry.source!);
  if (new Set(sources).size !== sources.length) return 'a source step used twice';
  if (from.some(node => !sources.includes(node.id))) return 'a source step without an entry';
  const carried = new Map<string, string>();
  for (const entry of plan.entries) {
    const current = entry.source ? status.get(entry.source) ?? 'pending' : 'pending';
    const before = entry.source ? source.get(entry.source) : undefined; const after = entry.target ? target.get(entry.target) : undefined;
    if (entry.status !== undefined && entry.status !== current) return `entry status differs from the run for ${entry.source}`;
    if (inFlight.has(current) && (entry.action !== 'keep' || entry.source !== entry.target || before!.fingerprint !== after!.fingerprint || before!.kind !== after!.kind)) {
      return `in-flight step ${entry.source} was ${entry.action}`;
    }
    const settled = entry.source !== undefined && !unstarted.has(current) && !parked.has(current) && !inFlight.has(current);
    if (settled) {
      if (entry.action === 'keep' && (entry.source !== entry.target || before!.fingerprint !== after!.fingerprint || before!.kind !== after!.kind)) return `settled ${entry.source} kept although changed`;
      if (entry.action === 'accept' && (entry.source !== entry.target || !migration.acceptCompleted.includes(entry.target!))) return `settled ${entry.source} accepted without acceptCompleted`;
      if (entry.action === 'accept' && before!.evidence !== after!.evidence) return `settled ${entry.source} accepted across an evidence change`;
      if (entry.action === 'remove' && current !== 'skipped' && !migration.acceptRemoved.includes(entry.source!)) return `settled ${entry.source} removed without acceptRemoved`;
      if (!['keep', 'accept', 'remove'].includes(entry.action)) return `settled ${entry.source} was ${entry.action}`;
    }
    if (entry.action === 'update' && !unstarted.has(current)) return `update of a ${current} step`;
    if (entry.action === 'reset' && !parked.has(current)) return `reset of a ${current} step`;
    if (entry.action === 'add' && entry.source !== undefined) return 'add with a source';
    if (entry.target) carried.set(entry.target, ['update', 'reset', 'add'].includes(entry.action) ? 'pending' : current);
  }
  for (const node of to) {
    const current = carried.get(node.id)!;
    if (!unstarted.has(current) && node.dependsOn.some(dependency => !succeeded.has(carried.get(dependency) ?? 'pending'))) return `${node.id} is ${current} with an unsucceeded dependency`;
  }
  return null;
}

describe('migration planner properties', () => {
  it(`holds every invariant for ${runs} generated migrations`, () => {
    let allowed = 0; let refused = 0;
    for (let index = 0; index < runs; index++) {
      const seed = baseSeed + index; const input = generate(seed); if (!input) continue; const problem = violation(input);
      if (problem) throw new Error(`Property violated (MAYURA_PROPERTY_SEED=${seed}): ${problem}\n${JSON.stringify({ from: input.from, to: input.to, steps: input.steps, plan: input.plan }, null, 2)}`);
      if (input.plan.allowed) allowed++; else refused++;
    }
    // The generator must exercise both outcomes, or the invariants above prove little.
    expect(allowed).toBeGreaterThan(runs / 10); expect(refused).toBeGreaterThan(runs / 10);
  });

  it('is deterministic', () => {
    for (let index = 0; index < 50; index++) expect(generate(baseSeed + index)?.plan).toEqual(generate(baseSeed + index)?.plan);
  });

  it('always allows migrating a run that has not started, whatever the new version looks like', () => {
    for (let index = 0; index < runs; index++) {
      const random = prng(baseSeed * 3 + index); const from = graph(random, ids.slice(0, 7), 1 + random.int(6));
      const to = graph(random, ids, 1 + random.int(8));
      const plan: MigrationPlan = planWorkflowMigration({ migration: defineWorkflowMigration({ id: 'fresh', from: {}, to: {} }), format: 'property', runId: 'r'.repeat(64),
        fromDigest: digestA, toDigest: digestB, from, to, steps: from.map(node => ({ id: node.id, status: 'pending' })) });
      expect(plan.allowed, `MAYURA_PROPERTY_SEED=${baseSeed * 3 + index}`).toBe(true);
      expect(plan.entries.some(entry => entry.action === 'accept' || entry.action === 'reset')).toBe(false);
    }
  });
});
