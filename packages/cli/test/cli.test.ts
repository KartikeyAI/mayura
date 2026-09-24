import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MayuraError } from '@mayura/core';
import { applyProjectPlan, approveWorkflow, cancelRun, cancelWorkflow, inspectHumanRequest, inspectHumanRequests, inspectRun, inspectServerHealth,
  inspectServerTools, inspectWorkflow, planProject, readProject, respondHumanRequest, templates, validateProject, waitForRun } from '../src/index.js';

const directories: string[] = [];
async function directory(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'mayura-cli-test-')); directories.push(value); return value; }
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

describe('@mayura/cli initialization', () => {
  it('publishes exactly the eight required bounded templates', () => {
    expect(templates().map(template => template.name)).toEqual(['typed-tool-runner', 'basic-agent', 'durable-approval', 'parallel-research',
      'native-memory', 'guarded-streaming-app', 'code-mode-workflow', 'capability-policy']);
    expect(Object.isFrozen(templates())).toBe(true);
  });

  it('plans without writing and applies a genuine fresh create-only plan', async () => {
    const target = join(await directory(), 'agent'); const plan = await planProject('basic-agent', target);
    expect(plan.changes.every(change => change.operation === 'create')).toBe(true);
    await expect(readFile(join(target, 'package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await applyProjectPlan(plan); const project = await readProject(join(target, 'mayura.project.json'));
    expect(project).toMatchObject({ format: 'mayura.project.v1', template: 'basic-agent' });
    expect(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).dependencies).toEqual({
      '@mayura/sdk': '0.1.0-dev.0', '@mayura/testing': '0.1.0-dev.0', zod: '4.6.5',
    });
  });

  it('shows a bounded diff and requires exact confirmation before replacement', async () => {
    const target = join(await directory(), 'agent'); const initial = await planProject('basic-agent', target); await applyProjectPlan(initial);
    await writeFile(join(target, 'README.md'), '# local change\n');
    const plan = await planProject('basic-agent', target); const replacement = plan.changes.find(change => change.path === 'README.md');
    expect(replacement).toMatchObject({ operation: 'replace', diff: expect.stringContaining('-# local change') });
    await expect(applyProjectPlan(plan)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await readFile(join(target, 'README.md'), 'utf8')).toBe('# local change\n');
    const confirmed = await planProject('basic-agent', target); await applyProjectPlan(confirmed, { confirmation: confirmed.digest });
    expect(await readFile(join(target, 'README.md'), 'utf8')).toContain('Credential-free structured agent');
  });

  it('rejects a stale plan before any file changes', async () => {
    const target = join(await directory(), 'agent'); const plan = await planProject('basic-agent', target);
    await writeFile(join(target, 'package.json'), '{"external":true}\n', { flag: 'wx' }).catch(async error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const bootstrap = await planProject('basic-agent', target); await applyProjectPlan(bootstrap); await writeFile(join(target, 'package.json'), '{"external":true}\n');
      } else throw error;
    });
    await expect(applyProjectPlan(plan)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(join(target, 'package.json'), 'utf8')).toBe('{"external":true}\n');
  });
});

describe('@mayura/cli catalog validation', () => {
  it('returns immutable inspected records and rejects duplicate identities', () => {
    const base = { format: 'mayura.project.v1', name: 'agent', template: 'basic-agent', tools: [],
      definitions: [{ kind: 'agent', id: 'agent', version: '1', source: 'src/index.ts' }] };
    const project = validateProject(base); expect(Object.isFrozen(project)).toBe(true); expect(Object.isFrozen(project.definitions)).toBe(true);
    expect(() => validateProject({ ...base, definitions: [...base.definitions, ...base.definitions] })).toThrow(MayuraError);
  });

  it('rejects accessor-backed and path-escaping catalogs without invoking source code', () => {
    let reads = 0; const hostile = Object.defineProperty({}, 'format', { enumerable: true, get: () => { reads++; return 'mayura.project.v1'; } });
    expect(() => validateProject(hostile)).toThrow(MayuraError); expect(reads).toBe(0);
    expect(() => validateProject({ format: 'mayura.project.v1', name: 'agent', template: 'basic-agent', tools: [],
      definitions: [{ kind: 'agent', id: 'agent', version: '1', source: 'src/../secret.ts' }] })).toThrow(MayuraError);
  });
});

describe('@mayura/cli authenticated operations', () => {
  it('reads degraded health as sanitized operational state', async () => {
    const transport = async (input: string | URL | Request, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/v1/operations/health');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer TOKEN_PRIVATE');
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
      return new Response(JSON.stringify({ status: 'degraded', checks: [
        { id: 'server', status: 'ready' }, { id: 'database', status: 'unavailable' },
      ] }), { status: 503, headers: { 'content-type': 'application/json' } });
    };
    const result = await inspectServerHealth({ baseUrl: 'https://agent.example.test', token: () => 'TOKEN_PRIVATE', fetch: transport });
    expect(result).toEqual({ status: 'degraded', checks: [{ id: 'server', status: 'ready' }, { id: 'database', status: 'unavailable' }] });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.checks)).toBe(true);
  });

  it('reads one exact tool page without following its cursor or exposing richer fields', async () => {
    const transport = async (input: string | URL | Request) => {
      expect(new URL(String(input)).search).toBe('?after=10&limit=1');
      return new Response(JSON.stringify({ tools: [{ agentId: 'agent', agentVersion: '1', id: 'lookup', version: '2', effects: 'read',
        capabilities: ['network:public'], timeoutMs: 500, costMicros: 7 }], next: 11 }), { headers: { 'content-type': 'application/json' } });
    };
    const result = await inspectServerTools({ baseUrl: 'https://agent.example.test', token: () => 'token', fetch: transport }, { after: 10, limit: 1 });
    expect(result).toMatchObject({ tools: [{ id: 'lookup', effects: 'read' }], next: 11 }); expect(Object.isFrozen(result.tools[0])).toBe(true);
  });

  it('fails closed on hostile destinations, malformed reports and non-cooperative timeouts', async () => {
    await expect(inspectServerHealth({ baseUrl: 'http://public.example.test', token: () => 'PRIVATE' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(inspectServerHealth({ baseUrl: 'https://agent.example.test', token: () => 'PRIVATE',
      fetch: async () => new Response(JSON.stringify({ status: 'ready', checks: [{ id: 'server', status: 'unavailable' }] }), { headers: { 'content-type': 'application/json' } })
    })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    let settle!: () => void; const hanging = new Promise<Response>(resolve => { settle = () => { resolve(new Response('{}')); }; });
    await expect(inspectServerHealth({ baseUrl: 'https://agent.example.test', token: () => 'PRIVATE', fetch: () => hanging, requestTimeoutMs: 10 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
    settle();
  });

  it('lists, inspects and submits digest-bound human responses without selecting an actor', async () => {
    const digest = 'a'.repeat(64); const item = { id: 'review', agentId: 'agent', kind: 'information', schemaId: 'text-v1',
      schemaDigest: 'b'.repeat(64), prompt: 'Provide evidence.', digest, status: 'waiting' };
    const calls: Array<{ path: string; body?: unknown }> = [];
    const transport = async (input: string | URL | Request, init?: RequestInit) => {
      const path = `${new URL(String(input)).pathname}${new URL(String(input)).search}`;
      calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const payload = path.startsWith('/v1/human-requests?') ? { items: [item], next: null }
        : { request: init?.method === 'POST' ? { ...item, status: 'answered' } : item };
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
    };
    const settings = { baseUrl: 'https://agent.example.test', token: () => 'TOKEN_PRIVATE', fetch: transport };
    expect((await inspectHumanRequests(settings, { limit: 1 })).items).toEqual([item]);
    expect(await inspectHumanRequest(settings, 'review')).toEqual(item);
    expect((await respondHumanRequest(settings, { id: 'review', requestDigest: digest, commandId: 'answer-1', value: { evidence: true } })).status).toBe('answered');
    expect(calls[2]).toEqual({ path: '/v1/human-requests/review/responses', body: { commandId: 'answer-1', requestDigest: digest, value: { evidence: true } } });
    expect(JSON.stringify(calls)).not.toContain('actorId');
  });

  it('inspects, waits and cancels runs without disclosing output or retrying commands', async () => {
    const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; let reads = 0; let cancellations = 0;
    const transport = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/cancel')) { cancellations += 1; expect(init?.method).toBe('POST'); expect(init?.body).toBeUndefined();
        return new Response(JSON.stringify({ id: runId, cancellationRequested: true }), { status: 202, headers: { 'content-type': 'application/json' } }); }
      reads += 1; const status = reads === 1 ? 'running' : 'succeeded';
      return new Response(JSON.stringify({ id: runId, status, budget: { spentMicros: '7', reservedMicros: 0, calls: 1 }, evidence: [],
        ...(status === 'succeeded' ? { outcome: { status, output: 'PRIVATE OUTPUT' } } : {}) }), { headers: { 'content-type': 'application/json' } });
    };
    const settings = { baseUrl: 'https://agent.example.test', token: () => 'TOKEN_PRIVATE', fetch: transport };
    expect(await inspectRun(settings, runId)).toMatchObject({ id: runId, status: 'running' });
    const completed = await waitForRun(settings, runId, { pollIntervalMs: 250, maxWaitMs: 1_000 });
    expect(completed.status).toBe('succeeded'); expect(JSON.stringify(completed)).not.toContain('PRIVATE');
    await cancelRun(settings, runId); expect(cancellations).toBe(1);
    await expect(waitForRun(settings, runId, { pollIntervalMs: 249, maxWaitMs: 1_000 })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('does not retry an ambiguously acknowledged run cancellation', async () => {
    const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; let calls = 0;
    const error: unknown = await cancelRun({ baseUrl: 'https://agent.example.test', token: () => 'TOKEN_PRIVATE', fetch: async () => {
      calls += 1; throw new Error('PRIVATE NETWORK DETAIL');
    } }, runId).catch(caught => caught);
    expect(calls).toBe(1); expect(error).toMatchObject({ code: 'TOOL_FAILED' }); expect(String(error)).not.toContain('PRIVATE');
  });

  it('inspects, cancels and exactly approves durable workflows without retry', async () => {
    const workflowId = 'a'.repeat(64); const childId = 'b'.repeat(64); const digest = 'd'.repeat(64); const calls: Array<{ path: string; body?: unknown }> = [];
    const workflow = (revision: number, status = 'waiting') => ({ format: 4, definitionId: 'deploy', definitionVersion: '1', runId: workflowId, revision, status,
      nodes: [{ id: 'child', kind: 'child', dependsOn: [] }], steps: [{ id: 'child', kind: 'child', status: status === 'cancelled' ? 'skipped' : 'waiting', childRunId: childId }] });
    const transport = async (input: string | URL | Request, init?: RequestInit) => { const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, ...(body === undefined ? {} : { body }) });
      return new Response(JSON.stringify({ workflow: workflow(path.endsWith('/cancel') ? 2 : path.endsWith('/approvals') ? 3 : 1,
        path.endsWith('/cancel') ? 'cancelled' : 'waiting') }), { headers: { 'content-type': 'application/json' } }); };
    const settings = { baseUrl: 'https://agent.example.test', token: () => 'TOKEN_PRIVATE', fetch: transport };
    expect((await inspectWorkflow(settings, workflowId)).revision).toBe(1);
    expect((await cancelWorkflow(settings, { id: workflowId, revision: 1, commandId: 'cancel-1' })).status).toBe('cancelled');
    expect((await approveWorkflow(settings, { id: workflowId, revision: 2, commandId: 'approve-1', nodeId: 'child', approvalDigest: digest,
      childRunId: childId })).revision).toBe(3);
    expect(calls).toEqual([{ path: `/v1/workflow-runs/${workflowId}` }, { path: `/v1/workflow-runs/${workflowId}/cancel`,
      body: { commandId: 'cancel-1', revision: 1 } }, { path: `/v1/workflow-runs/${workflowId}/approvals`,
      body: { commandId: 'approve-1', revision: 2, nodeId: 'child', approvalDigest: digest, childRunId: childId } }]);
  });

  it('classifies a workflow revision conflict and performs one command request', async () => {
    let calls = 0; const workflowId = 'a'.repeat(64);
    await expect(cancelWorkflow({ baseUrl: 'https://agent.example.test', token: () => 'TOKEN_PRIVATE', fetch: async () => {
      calls += 1; return new Response(JSON.stringify({ error: { code: 'WORKFLOW_CONFLICT' } }), { status: 409, headers: { 'content-type': 'application/json' } });
    } }, { id: workflowId, revision: 1, commandId: 'cancel-1' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(calls).toBe(1);
  });

  it('accepts a short-lived CLI credential only through piped stdin and never prints it', async () => {
    const host = createServer((request, response) => {
      expect(request.headers.authorization).toBe('Bearer TOKEN_PRIVATE'); expect(request.url).toBe('/v1/operations/health');
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 'ready', checks: [{ id: 'server', status: 'ready' }] }));
    });
    await new Promise<void>((resolve, reject) => { host.once('error', reject); host.listen(0, '127.0.0.1', resolve); });
    try {
      const address = host.address(); if (!address || typeof address === 'string') throw new Error();
      const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'server-health', '--url', `http://127.0.0.1:${address.port}`, '--token-stdin'],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stdin.end('TOKEN_PRIVATE\n'); let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; }); child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      const exitCode = await new Promise<number | null>(resolve => { child.once('exit', resolve); });
      expect(exitCode).toBe(0); expect(stderr).toBe(''); expect(stdout).not.toContain('TOKEN_PRIVATE');
      expect(JSON.parse(stdout)).toEqual({ status: 'succeeded', health: { status: 'ready', checks: [{ id: 'server', status: 'ready' }] } });
    } finally { await new Promise<void>(resolve => { host.close(() => { resolve(); }); }); }
  });

  it('submits a CLI human response from a bounded explicit JSON file', async () => {
    const digest = 'a'.repeat(64); const target = await directory(); const file = join(target, 'response.json'); await writeFile(file, '{"choice":"accept"}');
    let received: unknown;
    const host = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += String(chunk); received = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ request: { id: 'review', agentId: 'agent',
        kind: 'plan_selection', schemaId: 'choice-v1', schemaDigest: 'b'.repeat(64), prompt: 'Choose.', digest, status: 'answered' } }));
    });
    await new Promise<void>((resolve, reject) => { host.once('error', reject); host.listen(0, '127.0.0.1', resolve); });
    try {
      const address = host.address(); if (!address || typeof address === 'string') throw new Error();
      const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'human-respond', '--url', `http://127.0.0.1:${address.port}`,
        '--id', 'review', '--digest', digest, '--command-id', 'answer-1', '--response-file', file, '--token-stdin'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stdin.end('TOKEN_PRIVATE\n'); let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; }); child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      const exitCode = await new Promise<number | null>(resolve => { child.once('exit', resolve); });
      expect(exitCode).toBe(0); expect(stderr).toBe(''); expect(stdout).not.toMatch(/TOKEN_PRIVATE|accept/);
      expect(received).toEqual({ commandId: 'answer-1', requestDigest: digest, value: { choice: 'accept' } });
    } finally { await new Promise<void>(resolve => { host.close(() => { resolve(); }); }); }
  });

  it('sends one executable run cancellation with a piped credential and no body', async () => {
    const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; let requests = 0;
    const host = createServer(async (request, response) => { requests += 1; expect(request.headers.authorization).toBe('Bearer TOKEN_PRIVATE');
      expect(request.url).toBe(`/v1/runs/${runId}/cancel`); let body = ''; for await (const chunk of request) body += String(chunk); expect(body).toBe('');
      response.writeHead(202, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: runId, cancellationRequested: true })); });
    await new Promise<void>((resolve, reject) => { host.once('error', reject); host.listen(0, '127.0.0.1', resolve); });
    try { const address = host.address(); if (!address || typeof address === 'string') throw new Error();
      const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'run-cancel', '--url', `http://127.0.0.1:${address.port}`,
        '--id', runId, '--token-stdin'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stdin.end('TOKEN_PRIVATE\n'); let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; }); child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      const exitCode = await new Promise<number | null>(resolve => { child.once('exit', resolve); });
      expect(exitCode).toBe(0); expect(stderr).toBe(''); expect(stdout).not.toContain('TOKEN_PRIVATE'); expect(requests).toBe(1);
      expect(JSON.parse(stdout)).toEqual({ status: 'succeeded', cancellationRequested: true, id: runId });
    } finally { await new Promise<void>(resolve => { host.close(() => { resolve(); }); }); }
  });

  it('sends one executable digest-bound workflow approval with a piped credential', async () => {
    const workflowId = 'a'.repeat(64); const digest = 'd'.repeat(64); let received: unknown;
    const host = createServer(async (request, response) => { expect(request.headers.authorization).toBe('Bearer TOKEN_PRIVATE');
      expect(request.url).toBe(`/v1/workflow-runs/${workflowId}/approvals`); let body = ''; for await (const chunk of request) body += String(chunk); received = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ workflow: { format: 2, definitionId: 'deploy',
        definitionVersion: '1', runId: workflowId, revision: 2, status: 'running', nodes: [{ id: 'review', kind: 'tool', dependsOn: [] }],
        steps: [{ id: 'review', kind: 'tool', status: 'approved' }] } })); });
    await new Promise<void>((resolve, reject) => { host.once('error', reject); host.listen(0, '127.0.0.1', resolve); });
    try { const address = host.address(); if (!address || typeof address === 'string') throw new Error();
      const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'workflow-approve', '--url', `http://127.0.0.1:${address.port}`,
        '--id', workflowId, '--revision', '1', '--command-id', 'approve-1', '--node', 'review', '--digest', digest, '--token-stdin'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); child.stdin.end('TOKEN_PRIVATE\n'); let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; }); child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      const exitCode = await new Promise<number | null>(resolve => { child.once('exit', resolve); });
      expect(exitCode).toBe(0); expect(stderr).toBe(''); expect(stdout).not.toMatch(/TOKEN_PRIVATE|approve-1|dddddddd/);
      expect(received).toEqual({ commandId: 'approve-1', revision: 1, nodeId: 'review', approvalDigest: digest, childRunId: null });
    } finally { await new Promise<void>(resolve => { host.close(() => { resolve(); }); }); }
  });
});
