import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import { createSqliteStore } from '@mayura/storage';
import { defineWorkflow } from '@mayura/workflows';
import { createWorkflowTreeRuntime, defineWorkflowTree } from '@mayura/workflows/children';

// This fixture intentionally reaches real crash boundaries. It is never a production example.
const [scenario, action, directory, existingRunId, reviewedDigest] = process.argv.slice(2);
if (!['approval', 'dispatch', 'receipt', 'child-approval', 'child-dispatch', 'child-receipt'].includes(scenario) || !['start', 'recover'].includes(action) || !directory) throw new Error('Invalid workflow-tree recovery fixture arguments.');
const childScenario=scenario.startsWith('child-');
const approvalScenario=scenario.endsWith('approval');
const receiptScenario=scenario.endsWith('receipt');
const fixtureDirectory = resolve(directory);
if (!basename(fixtureDirectory).startsWith('mayura-tree-process-recovery-')) throw new Error('Unexpected fixture directory.');
const filename = join(fixtureDirectory, 'workflow-tree.sqlite');
const effectFile = join(fixtureDirectory, 'effects.ndjson');
if (dirname(effectFile) !== fixtureDirectory || dirname(filename) !== fixtureDirectory) throw new Error('Fixture path escaped its directory.');

function notify(message) {
  return new Promise((resolveMessage, reject) => {
    if (!process.send) return reject(new Error('The fixture requires an IPC parent.'));
    process.send(message, error => error ? reject(error) : resolveMessage());
  });
}

function recordEffect(context) {
  const descriptor = openSync(effectFile, 'a');
  try { writeSync(descriptor, `${JSON.stringify({ runId: context.runId, callId: context.callId })}\n`); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

const value = z.object({ value: z.number() });
const store = createSqliteStore({ filename });
let rootRunId;
const tool = defineTool({
  id: 'tree-process.write', version: '1', description: 'Append once to a test-owned artifact.',
  input: value, output: value, effects: 'write', capabilities: [], costMicros: 1, timeoutMs: 120_000,
  execute: async (input, context) => {
    recordEffect(context);
    if (!approvalScenario && !receiptScenario) { await notify({ kind: 'dispatched', runId: rootRunId, childId: childScenario ? context.runId : undefined }); return await new Promise(() => {}); }
    return input;
  },
  ...(receiptScenario ? {
    guards: { output: [{ id: 'pause-after-receipt', check: async (_output, context) => {
      // The broker has committed the durable receipt before output guards run.
      await notify({ kind: 'receipt_pending', runId: rootRunId, childId: childScenario ? context.runId : undefined });
      return await new Promise(() => {});
    } }] },
  } : {}),
});
const leaf=defineWorkflow({id:`tree-process.leaf.${scenario}`,version:'1',input:value,output:value,nodes:[{kind:'tool',id:'write',tool,input:{kind:'input',path:[]},approval:approvalScenario}],result:{kind:'step',stepId:'write',path:[]}});
const definition = childScenario ? defineWorkflowTree({
  id:`tree-process.${scenario}`,version:'1',input:value,output:value,nodes:[{kind:'child',id:'child',workflow:leaf,input:{kind:'input',path:[]},policy:{permissions:['tool:tree-process.write','effect:write'],maxCostMicros:1,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:120_000},resources:{write:[]}}],result:{kind:'step',stepId:'child',path:[]},
}) : defineWorkflowTree({id:`tree-process.${scenario}`,version:'1',input:value,output:value,nodes:[{kind:'tool',id:'write',tool,input:{kind:'input',path:[]},approval:approvalScenario}],result:{kind:'step',stepId:'write',path:[]}});
const runtime = createWorkflowTreeRuntime({
  store, scope: { principalId: 'test-operator', projectId: 'tree-process-recovery' },
  permissions: { allow: ['tool:tree-process.write', 'effect:write'] }, policyVersion: 'tree-process-policy-1',
  maxCostMicros: 10, maxCalls: 1, workerId: `tree-process-${action}`, leaseMs: 1_000, approvalTtlMs: 120_000,
  verifyHuman: async credential => {
    if (credential !== 'fixture-human-credential') throw new Error('Invalid fixture human.');
    return { id: 'verified-reviewer', projectId: 'tree-process-recovery', canApprove: true };
  },
});

let phase='initialize';
try {
  await store.initialize();
  if (action === 'start') {
    phase='submit';
    const run = await runtime.submit(definition, { input: { value: 7 }, idempotencyKey: `tree-process-${scenario}` });
    rootRunId=run.id;
    const state = await runtime.runUntilSettled(definition, run.id);
    if (!approvalScenario || state.status !== 'waiting') throw new Error('Unexpected pre-crash state.');
    if(childScenario){const link=state.steps.child?.child;if(!link)throw new Error('Missing admitted child.');const child=await runtime.inspectChild(run.id,link.runId);await notify({kind:'waiting',runId:run.id,childId:link.runId,digest:child.steps.write.approval.digest,snapshot:state});}
    else await notify({ kind: 'waiting', runId: run.id, digest: state.steps.write.approval.digest, snapshot: state });
    await new Promise(() => {});
  } else {
    phase='inspect';
    if (!existingRunId) throw new Error('Recovery requires the original run identifier.');
    rootRunId=existingRunId;
    const before = await runtime.inspect(existingRunId);
    const childLink=childScenario?before.steps.child?.child:undefined;
    if(childScenario&&!childLink)throw new Error('Missing persisted child.');
    const memberBefore=childLink?await runtime.inspectChild(existingRunId,childLink.runId):undefined;
    if (approvalScenario) {
      phase='approve';
      if(childScenario){if(memberBefore.steps.write.approval?.digest!==reviewedDigest)throw new Error('The persisted review digest changed.');await runtime.approve({id:existingRunId,childId:childLink.runId,nodeId:'write',digest:reviewedDigest,credential:'fixture-human-credential'});}
      else {if (before.steps.write.approval?.digest !== reviewedDigest) throw new Error('The persisted review digest changed.');await runtime.approve({ id: existingRunId, nodeId: 'write', digest: reviewedDigest, credential: 'fixture-human-credential' });}
    } else {
      phase='recover-wait';
      await new Promise(resolveTimeout => setTimeout(resolveTimeout, 1_100));
      phase='recover-expired';
      await runtime.recoverExpired(existingRunId);
    }
    phase='continue';
    const snapshot = await runtime.runUntilSettled(definition, existingRunId);
    const repeated = await runtime.runUntilSettled(definition, existingRunId);
    const member=childLink?await runtime.inspectChild(existingRunId,childLink.runId):undefined;
    const events = await runtime.events(existingRunId);
    await notify({ kind: 'completed', runId: existingRunId, before, memberBefore, snapshot, member, repeated, events });
    await runtime.close(); await store.close(); process.disconnect();
  }
} catch (error) {
  await notify({ kind: 'fixture_error', code: error?.code ?? 'FIXTURE_FAILED', phase }).catch(() => {});
  await runtime.close().catch(() => {}); await store.close().catch(() => {}); process.exitCode = 1;
  if (process.connected) process.disconnect();
}
