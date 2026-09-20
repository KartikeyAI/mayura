import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonValue } from '@mayura/core';
import type { ScheduledWorkflowAggregateStore, ScheduledWorkflowSnapshot, WorkflowManifestNode } from '@mayura/storage-contracts';

/** Real storage-only admission tests: no model/tool callback is substituted for a database transaction. */
export function scheduledBounds(name: string, factory: () => Promise<{ store: ScheduledWorkflowAggregateStore; cleanup(): Promise<void> }>): void {
  describe(`${name} scheduled output and history bounds`, () => {
    let fixture: Awaited<ReturnType<typeof factory>>;
    let current: ScheduledWorkflowSnapshot;
    let command = 0;
    const key = () => ({ scope: current.record.scope, id: current.record.id, policyHash: current.policyHash });
    const write = () => ({ ...key(), expectedVersion: current.record.version, commandId: `bounded-${++command}` });
    const node = (id: string, approval = false): WorkflowManifestNode => ({ kind: 'tool', id, dependsOn: [], tool: 'bounded', toolVersion: '1',
      effects: 'write', capabilities: [], costMicros: 1, approval, input: { kind: 'literal', value: null } });
    const submit = async (graph: readonly WorkflowManifestNode[], maxOutputBytes = 65_536) => {
      current = (await fixture.store.workflows.submit({ manifest: { id: 'bounds', version: '1', graph, result: { kind: 'literal', value: null } },
        policy: { scope: { principalId: 'bounded', projectId: 'bounded' }, permissions: ['tool:bounded','effect:write'], policyVersion: '1',
          maxCostMicros: 128, maxOutputBytes, approvalTtlMs: 300_000 }, resources: {}, input: null, idempotencyKey: 'bounds' })).snapshot;
    };
    const finish = async (nodeId: string, output: JsonValue) => {
      current = await fixture.store.workflows.prepare({ ...write(), nodeId, input: null });
      const leased = (await fixture.store.workflows.claim({ ...key(), workerId: 'bounds', limit: 1, leaseMs: 300_000 }))[0]!;
      current = await fixture.store.workflows.inspect(key());
      current = (await fixture.store.workflows.start({ ...write(), claim: leased.claim, input: null })).snapshot;
      const evidenceId = `evidence-${nodeId}`;
      current = await fixture.store.workflows.recordReceipt({ ...key(), jobId: leased.job.jobId, fence: leased.claim.fence, evidenceId,
        receipt: { callId: `${current.record.id}/step:${nodeId}`, toolId: 'bounded', execution: 'succeeded', disclosure: 'withheld' } });
      current = await fixture.store.workflows.complete({ ...write(), claim: leased.claim, evidenceId, outcome: 'succeeded', output });
    };
    beforeEach(async () => { command = 0; fixture = await factory(); await fixture.store.initialize(); await fixture.store.workflows.initialize(); });
    afterEach(async () => { await fixture.store.close(); await fixture.cleanup(); });

    it('fails an oversized join deterministically without erasing successful tool evidence', async () => {
      await submit([node('first'),node('second'),{ kind:'join',id:'joined',dependsOn:['first','second'] }]);
      await finish('first','a'.repeat(40_000)); await finish('second','b'.repeat(40_000));
      current = await fixture.store.workflows.advance(write());
      expect(current.record.state['status']).toBe('failed');
      expect((current.record.state['steps'] as Record<string, { status:string;output:JsonValue }>)['joined']).toMatchObject({status:'failed',output:null});
      expect(current.jobs.every(job => job.receipt?.execution === 'succeeded' && job.receipt.disclosure === 'released')).toBe(true);
      const version = current.record.version;
      current = await fixture.store.workflows.advance(write()); expect(current.record.version).toBe(version);
    });

    it('keeps 128-node graph events ordered and does not journal waiting or terminal no-ops', async () => {
      await submit(Array.from({length:128},(_,index) => ({kind:'join' as const,id:`join${index}`,dependsOn:[]})));
      current = await fixture.store.workflows.advance(write());
      expect(Object.values(current.record.state['steps'] as Record<string,{status:string}>).every(step => step.status === 'succeeded')).toBe(true);
      current = await fixture.store.workflows.finalize({...write(),validation:'passed',output:null});
      const version = current.record.version;
      const original = await fixture.store.events(key().scope,key().id);
      for (let index = 0; index < 32; index++) {
        current = await fixture.store.workflows.advance(write()); current = await fixture.store.workflows.recover(write()); current = await fixture.store.workflows.cancel(write());
      }
      expect(current.record.version).toBe(version);
      const events = await fixture.store.events(key().scope,key().id);
      expect(events).toEqual(original); expect(events.map(event => event.sequence)).toEqual(events.map((_,index) => index+1));
      expect(events.filter(event => event.type === 'step.completed')).toHaveLength(128);
    });

    it('repeated waiting approval checks preserve review, version and event history', async () => {
      await submit([node('review',true)]);
      current = await fixture.store.workflows.requestApproval({...write(),nodeId:'review',input:null});
      const version = current.record.version; const before = await fixture.store.events(key().scope,key().id);
      for (let index = 0; index < 32; index++) {
        current = await fixture.store.workflows.advance(write()); current = await fixture.store.workflows.recover(write());
        current = await fixture.store.workflows.requestApproval({...write(),nodeId:'review',input:null});
      }
      expect(current.record.version).toBe(version); expect(await fixture.store.events(key().scope,key().id)).toEqual(before);
    });

    it('withholds outputs that cannot fit a 128-node aggregate while preserving every known cost and receipt', async () => {
      const tools = Array.from({length:20},(_,index) => node(`tool${index}`));
      await submit([...tools,...Array.from({length:108},(_,index) => ({kind:'join' as const,id:`join${index}`,dependsOn:[]}))]);
      current = await fixture.store.workflows.advance(write());
      for (const tool of tools) await finish(tool.id,'x'.repeat(60_000));
      current = await fixture.store.workflows.advance(write());
      expect(current.record.state['status']).toBe('blocked');
      expect(current.record.state).toMatchObject({spentMicros:20,reservedMicros:0});
      expect(current.jobs.every(job => job.receipt?.execution === 'succeeded')).toBe(true);
      expect(current.jobs.some(job => job.state === 'blocked' && job.output === null && job.receipt?.disclosure === 'withheld')).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(current.record.state))).toBeLessThanOrEqual(1_048_576);
    },60_000);

    it('fails final output admission rather than trapping already successful steps', async () => {
      await submit([node('first')],16); await finish('first','ok');
      current = await fixture.store.workflows.finalize({...write(),validation:'passed',output:'x'.repeat(20)});
      expect(current.record.state).toMatchObject({status:'failed',output:null,spentMicros:1,reservedMicros:0});
      expect(current.jobs[0]?.receipt).toMatchObject({execution:'succeeded',disclosure:'released'});
    });

    it('fails an individually valid final output when the combined aggregate would overflow', async () => {
      const tools = Array.from({length:17},(_,index) => node(`tool${index}`));
      await submit(tools);
      for (const tool of tools) await finish(tool.id,'x'.repeat(60_000));
      expect(current.jobs.every(job => job.state === 'succeeded')).toBe(true);
      current = await fixture.store.workflows.finalize({...write(),validation:'passed',output:'z'.repeat(60_000)});
      expect(current.record.state).toMatchObject({status:'failed',output:null,spentMicros:17,reservedMicros:0});
      expect(current.jobs.every(job => job.receipt?.execution === 'succeeded' && job.receipt.disclosure === 'released')).toBe(true);
    },60_000);
  });
}
