import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { graphPostgresFixture } from '../../workflows/test/graph-fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];

describe.skipIf(!connectionString)('PostgreSQL discovery index snapshot eligibility', () => {
  it('accepts a valid HOT-built index whose indcheckxmin flag remains set after an older reader ends', async () => {
    const fixture = await graphPostgresFixture(connectionString!);
    const readers = new Pool({connectionString:connectionString!,max:1});
    let release: (() => Promise<void>) | undefined;
    try {
      const {store} = fixture; await store.initialize(); await store.workflowGraphs.initialize();
      const policy = {scope:{principalId:'hot-reader',projectId:'discovery'},permissions:[],policyVersion:'1',
        maxCostMicros:0,maxOutputBytes:65_536,approvalTtlMs:60_000};
      const before = (await store.workflowGraphs.submit({
        manifest:{format:3,id:'hot.graph',version:'1',graph:[{kind:'join',id:'done',dependsOn:[]}],result:{kind:'literal',value:null}},
        policy,resources:{},input:null,idempotencyKey:'hot-before-index',
      })).snapshot;
      const client = await readers.connect();
      release = async () => { try { await client.query('ROLLBACK'); } finally { client.release(); } };
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      // Preserve the old owner tuple while the ordinary reducer updates its
      // unindexed version/data fields. No system catalog values are changed.
      await client.query(`SELECT aggregate_version FROM ${fixture.prefix}mayura_workflow_owners WHERE scope = $1 AND aggregate_id = $2`,
        [before.record.scope,before.record.id]);
      const after = await store.workflowGraphs.advance({scope:before.record.scope,id:before.record.id,policyHash:before.policyHash,
        expectedVersion:before.record.version,commandId:'hot-advance'});
      expect(after.record.version).toBe(before.record.version + 1);
      await fixture.query(`CREATE INDEX mayura_workflow_owners_discovery ON ${fixture.prefix}mayura_workflow_owners
        (scope,policy_hash,profile,aggregate_id COLLATE "C")`);
      const flags = async () => fixture.query(`SELECT i.indcheckxmin,i.indisvalid,i.indisready,i.indislive
        FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = pg_catalog.to_regclass(?) AND c.relname = ?`,
      [`${fixture.prefix}mayura_workflow_owners`,'mayura_workflow_owners_discovery']);
      const expected = [{indcheckxmin:true,indisvalid:true,indisready:true,indislive:true}];
      expect(await flags()).toEqual(expected);
      await release(); release = undefined;
      // This is a snapshot-horizon flag, not a flag that is automatically cleared
      // when the older transaction ends or proof of an incompatible index.
      expect(await flags()).toEqual(expected);
      await expect(store.workflowGraphDiscovery.initialize()).resolves.toBeUndefined();
      expect(await store.workflowGraphDiscovery.scan({scope:before.record.scope,policyHash:before.policyHash,cursor:null,limit:2}))
        .toEqual({candidates:[{reference:{kind:'scheduled-workflow',runId:before.record.id,definitionHash:before.manifestHash,
          policyHash:before.policyHash},version:after.record.version,status:'running'}],examined:1,nextCursor:null});
      expect(await flags()).toEqual(expected);
    } finally {
      await release?.(); await readers.end(); await fixture.store.close(); await fixture.cleanup();
    }
  });
});
