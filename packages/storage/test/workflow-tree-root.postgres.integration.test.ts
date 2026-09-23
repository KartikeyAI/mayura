import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { SchedulerDatabase, WorkflowTreeDatabase, type SchedulerBackend, type SchedulerSession } from '@mayura/storage-sql/host';
import type { WorkflowTreeManifest, WorkflowTreePolicyManifest } from '@mayura/storage-contracts';

const connectionString=process.env['MAYURA_TEST_POSTGRES_URL'];
const suite=connectionString?describe:describe.skip;
const manifest:WorkflowTreeManifest={format:4,id:'root',version:'1',graph:[{kind:'child',id:'child',dependsOn:[],workflow:{id:'leaf',version:'1',graph:[{kind:'tool',id:'work',dependsOn:[],tool:'fixture/tool',toolVersion:'1',effects:'none',capabilities:[],costMicros:2,approval:false,input:{kind:'input',path:[]}}],result:{kind:'step',stepId:'work',path:[]}},policy:{permissions:['tool:fixture/tool'],maxCostMicros:2,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:1_000},resources:{work:[]},input:{kind:'input',path:[]}}],result:{kind:'step',stepId:'child',path:[]}};
const policy:WorkflowTreePolicyManifest={scope:{principalId:'owner',projectId:'project'},permissions:['tool:fixture/tool'],policyVersion:'1',maxCostMicros:2,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:1_000};

function session(client:PoolClient):SchedulerSession{return{query:async<T>(sql:string,parameters:readonly unknown[]=[])=>{let ordinal=0;const result=await client.query(sql.replace(/\?/g,()=>`$${++ordinal}`),[...parameters]);return result.rows as T[];}};}

suite('workflow-tree PostgreSQL root enrollment',()=>{
  it('atomically creates and reopens the fixed profile-3 root',async()=>{
    const schema=`mayura_tree_${randomUUID().replaceAll('-','')}`;const pool=new Pool({connectionString:connectionString!,max:4});
    const transaction=async<T>(body:(tx:SchedulerSession)=>Promise<T>):Promise<T>=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await body(session(client));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
    const prefix=`"${schema}".`;const backend:SchedulerBackend={dialect:'postgres',prefix,transaction};
    try{
      await pool.query(`CREATE SCHEMA "${schema}"`);await pool.query(`CREATE TABLE ${prefix}mayura_aggregates (scope TEXT NOT NULL,id TEXT NOT NULL,idempotency_key TEXT NOT NULL,definition_hash TEXT NOT NULL,submission_digest TEXT NOT NULL,version BIGINT NOT NULL,event_sequence BIGINT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(scope,id),UNIQUE(scope,idempotency_key))`);await pool.query(`CREATE TABLE ${prefix}mayura_events (scope TEXT NOT NULL,aggregate_id TEXT NOT NULL,sequence BIGINT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(scope,aggregate_id,sequence),FOREIGN KEY(scope,aggregate_id) REFERENCES ${prefix}mayura_aggregates(scope,id))`);await pool.query(`CREATE TABLE ${prefix}mayura_workflow_owners (scope TEXT NOT NULL,aggregate_id TEXT NOT NULL,profile INTEGER NOT NULL,aggregate_version BIGINT NOT NULL,definition_hash TEXT NOT NULL,policy_hash TEXT NOT NULL,resource_hash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,aggregate_id),FOREIGN KEY(scope,aggregate_id) REFERENCES ${prefix}mayura_aggregates(scope,id))`);
      const trees=new WorkflowTreeDatabase(backend,new SchedulerDatabase(backend));await trees.initialize();const first=await trees.submit({manifest,policy,resources:{},input:null,idempotencyKey:'root'});expect(first.created).toBe(true);
      const reopened=new WorkflowTreeDatabase(backend,new SchedulerDatabase(backend));await reopened.initialize();const command={scope:first.snapshot.record.scope,rootId:first.snapshot.rootId,rootPolicyHash:first.snapshot.policyHash,parentId:first.snapshot.rootId,nodeId:'child',expectedVersion:1,input:null};
      const raced=await Promise.all([trees.admitChild(command),reopened.admitChild(command)]);expect(raced.filter(item=>item.created)).toHaveLength(1);expect(new Set(raced.map(item=>item.childId))).toHaveLength(1);const admitted=raced[0]!;
      const retry=await reopened.submit({manifest,policy,resources:{},input:null,idempotencyKey:'root'});expect(retry.created).toBe(false);expect(retry.snapshot.record.version).toBe(2);
      const childRetry=await reopened.admitChild({scope:first.snapshot.record.scope,rootId:first.snapshot.rootId,rootPolicyHash:first.snapshot.policyHash,parentId:first.snapshot.rootId,nodeId:'child',expectedVersion:1,input:null});expect(childRetry.created).toBe(false);expect(childRetry.childId).toBe(admitted.childId);
      const counts=await pool.query(`SELECT (SELECT COUNT(*) FROM ${prefix}mayura_workflow_tree_budgets)::int AS budgets,(SELECT COUNT(*) FROM ${prefix}mayura_workflow_tree_members)::int AS members`);expect(counts.rows[0]).toEqual({budgets:1,members:2});
    }finally{await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await pool.end();}
  });
});
