import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MayuraError } from '@mayura/core';
import { applyProjectPlan, approveWorkflow, cancelRun, cancelWorkflow, inspectHumanRequest, inspectHumanRequests, inspectRun, inspectServerHealth,
  inspectServerTools, inspectWorkflow, inspectWorkflows, holdWorkflowFleet, inspectWorkflowFleet, pauseWorkflow, planProject, planStarter, readProject, releaseWorkflowFleet, respondHumanRequest, resumeWorkflow, starters, sweepWorkflowFleet, signalWorkflow, templates, validateProject, waitForRun } from '../src/index.js';

const directories: string[] = [];
async function directory(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'mayura-cli-test-')); directories.push(value); return value; }
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

describe('@mayura/cli initialization', () => {
  it('writes through links above the target to the real directory, but refuses a target that is itself a link', async () => {
    // Directory junctions need no privilege on Windows; elsewhere a directory symlink. macOS /var and /tmp are such links.
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    const real = await directory(); const linked = join(await directory(), 'linked-parent'); await symlink(real, linked, kind);
    const plan = await planProject('basic-agent', join(linked, 'agent'));
    expect(plan.directory).toBe(join(await realpath(real), 'agent'));
    await applyProjectPlan(plan);
    expect(JSON.parse(await readFile(join(real, 'agent', 'mayura.project.json'), 'utf8'))).toMatchObject({ template: 'basic-agent' });
    const linkedTarget = join(await directory(), 'linked-target'); await symlink(await directory(), linkedTarget, kind);
    await expect(planProject('basic-agent', linkedTarget)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

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

describe('@mayura/cli starters', () => {
  const version = async () => (JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;

  it('lists the starters as an immutable catalog', () => {
    expect(starters().map(starter => starter.name)).toEqual(['approval-workflow', 'support-agent', 'event-automation']);
    expect(Object.isFrozen(starters())).toBe(true);
  });

  it('plans a complete multi-file project, pins Mayura to this release and restores dotfile names', async () => {
    const target = join(await directory(), 'refunds'); const plan = await planStarter('approval-workflow', target);
    const paths = plan.changes.map(change => change.path);
    expect(plan.changes.every(change => change.operation === 'create')).toBe(true);
    expect(paths).toEqual(expect.arrayContaining(['package.json', 'mayura.project.json', 'README.md', '.gitignore', '.env.example',
      '.github/workflows/ci.yml', 'src/app.ts', 'src/workflow.ts', 'test/refunds.test.ts']));
    expect(paths.some(path => /(^|\/)(node_modules|dist|\.data)(\/|$)|dot-|tsbuildinfo/u.test(path))).toBe(false);
    await expect(readFile(join(target, 'package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await applyProjectPlan(plan);
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as { name: string; dependencies: Record<string, string> };
    expect(manifest.name).toBe('refunds');
    const release = await version();
    for (const [name, range] of Object.entries(manifest.dependencies)) expect(range).toBe(name.startsWith('@mayura/') ? release : range.replace(/^workspace:.*/u, 'never'));
    expect(JSON.stringify(manifest)).not.toContain('workspace:');
    expect(await readProject(join(target, 'mayura.project.json'))).toMatchObject({ name: 'refunds', template: 'approval-workflow' });
    expect(await readFile(join(target, 'src', 'workflow.ts'), 'utf8')).toContain('defineWorkflowMigration');
  });

  it('requires the plan digest before replacing a changed file, and refuses a linked directory inside the target', async () => {
    const target = join(await directory(), 'refunds'); await applyProjectPlan(await planStarter('approval-workflow', target));
    await writeFile(join(target, 'src', 'auth.ts'), '// local change\n');
    const plan = await planStarter('approval-workflow', target);
    expect(plan.changes.filter(change => change.operation === 'replace').map(change => change.path)).toEqual(['src/auth.ts']);
    await expect(applyProjectPlan(plan)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await readFile(join(target, 'src', 'auth.ts'), 'utf8')).toBe('// local change\n');

    const linked = join(await directory(), 'linked'); await mkdir(linked);
    await symlink(await directory(), join(linked, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(planStarter('approval-workflow', linked)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('accepts exactly one of --template and --starter on the command line', async () => {
    const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url)); const target = join(await directory(), 'x');
    const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const child = spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    expect((await run(['init', '--template', 'basic-agent', '--starter', 'approval-workflow', '--directory', target])).code).toBe(1);
    expect((await run(['init', '--starter', 'unknown', '--directory', target])).code).toBe(1);
    const planned = await run(['init', '--starter', 'approval-workflow', '--directory', target]);
    expect(planned.code).toBe(0); expect(JSON.parse(planned.stdout)).toMatchObject({ status: 'planned', plan: { starter: 'approval-workflow' } });
    expect(JSON.parse((await run(['starters'])).stdout).starters.map((starter: { name: string }) => starter.name)).toEqual(['approval-workflow', 'support-agent', 'event-automation']);
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

  it('inspects, cancels, approves and signals durable workflows without retry', async () => {
    const workflowId = 'a'.repeat(64); const childId = 'b'.repeat(64); const digest = 'd'.repeat(64); const calls: Array<{ path: string; body?: unknown }> = [];
    const workflow = (revision: number, status = 'waiting') => ({ format: 4, definitionId: 'deploy', definitionVersion: '1', runId: workflowId, revision, status,
      nodes: [{ id: 'child', kind: 'child', dependsOn: [] }], steps: [{ id: 'child', kind: 'child', status: status === 'cancelled' ? 'skipped' : 'waiting', childRunId: childId }] });
    const transport = async (input: string | URL | Request, init?: RequestInit) => { const url = new URL(String(input)); const path = url.pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, ...(body === undefined ? {} : { body }) });
      if (path === '/v1/workflow-runs') return new Response(JSON.stringify({ items: [{ format: 4, definitionId: 'deploy', definitionVersion: '1',
        runId: workflowId, revision: 1, status: 'waiting' }], next: null }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ workflow: workflow(path.endsWith('/cancel') ? 2 : path.endsWith('/approvals') ? 3 : path.endsWith('/signals') ? 4 : path.endsWith('/resume') ? 5 : path.endsWith('/pause') ? 6 : 1,
        path.endsWith('/cancel') ? 'cancelled' : 'waiting') }), { headers: { 'content-type': 'application/json' } }); };
    const settings = { baseUrl: 'https://agent.example.test', token: () => 'TOKEN_PRIVATE', fetch: transport };
    expect((await inspectWorkflows(settings, { limit: 5 })).items[0]?.runId).toBe(workflowId);
    expect((await inspectWorkflow(settings, workflowId)).revision).toBe(1);
    expect((await cancelWorkflow(settings, { id: workflowId, revision: 1, commandId: 'cancel-1' })).status).toBe('cancelled');
    expect((await approveWorkflow(settings, { id: workflowId, revision: 2, commandId: 'approve-1', nodeId: 'child', approvalDigest: digest,
      childRunId: childId })).revision).toBe(3);
    expect((await signalWorkflow(settings, { id: workflowId, revision: 3, commandId: 'signal-command-1', signalId: 'ready/1',
      signalName: 'ready', value: { accepted: true } })).revision).toBe(4);
    expect((await resumeWorkflow(settings, { id: workflowId, revision: 4, commandId: 'resume-1' })).revision).toBe(5);
    expect((await pauseWorkflow(settings, { id: workflowId, revision: 5, commandId: 'pause-1' })).revision).toBe(6);
    expect(calls).toEqual([{ path: '/v1/workflow-runs' }, { path: `/v1/workflow-runs/${workflowId}` }, { path: `/v1/workflow-runs/${workflowId}/cancel`,
      body: { commandId: 'cancel-1', revision: 1 } }, { path: `/v1/workflow-runs/${workflowId}/approvals`,
      body: { commandId: 'approve-1', revision: 2, nodeId: 'child', approvalDigest: digest, childRunId: childId } },
    { path: `/v1/workflow-runs/${workflowId}/signals`, body: { commandId: 'signal-command-1', revision: 3,
      signalId: 'ready/1', signalName: 'ready', value: { accepted: true } } },
    { path: `/v1/workflow-runs/${workflowId}/resume`, body: { commandId: 'resume-1', revision: 4 } },
    { path: `/v1/workflow-runs/${workflowId}/pause`, body: { commandId: 'pause-1', revision: 5 } }]);
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

  it('sends one executable workflow signal from a bounded JSON file without printing its value', async () => {
    const workflowId = 'a'.repeat(64); const target = await directory(); const file = join(target, 'signal.json');
    await writeFile(file, '{"secret":"SIGNAL_PRIVATE"}'); let received: unknown;
    const host = createServer(async (request, response) => { expect(request.headers.authorization).toBe('Bearer TOKEN_PRIVATE');
      expect(request.url).toBe(`/v1/workflow-runs/${workflowId}/signals`); let body = ''; for await (const chunk of request) body += String(chunk); received = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ workflow: { format: 3, definitionId: 'deploy',
        definitionVersion: '1', runId: workflowId, revision: 2, status: 'running', nodes: [{ id: 'ready', kind: 'wait', dependsOn: [] }],
        steps: [{ id: 'ready', kind: 'wait', status: 'succeeded' }] } })); });
    await new Promise<void>((resolve, reject) => { host.once('error', reject); host.listen(0, '127.0.0.1', resolve); });
    try { const address = host.address(); if (!address || typeof address === 'string') throw new Error();
      const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'workflow-signal', '--url', `http://127.0.0.1:${address.port}`,
        '--id', workflowId, '--revision', '1', '--command-id', 'signal-command-1', '--signal-id', 'ready/1', '--signal-name', 'ready', '--value-file', file,
        '--token-stdin'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stdin.end('TOKEN_PRIVATE\n'); let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; }); const exitCode = await new Promise<number | null>(resolve => { child.once('exit', resolve); });
      expect(exitCode).toBe(0); expect(stderr).toBe(''); expect(stdout).not.toMatch(/TOKEN_PRIVATE|SIGNAL_PRIVATE|signal-command-1/);
      expect(received).toEqual({ commandId: 'signal-command-1', revision: 1, signalId: 'ready/1', signalName: 'ready', value: { secret: 'SIGNAL_PRIVATE' } });
    } finally { await new Promise<void>(resolve => { host.close(() => { resolve(); }); }); }
  });

  it('sends one executable workflow continuation request with a piped credential', async () => {
    const workflowId = 'a'.repeat(64); let received: unknown; let requests = 0;
    const host = createServer(async (request, response) => { requests += 1; expect(request.headers.authorization).toBe('Bearer TOKEN_PRIVATE');
      expect(request.url).toBe(`/v1/workflow-runs/${workflowId}/resume`); let body = ''; for await (const chunk of request) body += String(chunk); received = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ workflow: { format: 3, definitionId: 'deploy',
        definitionVersion: '1', runId: workflowId, revision: 2, status: 'waiting', nodes: [{ id: 'ready', kind: 'wait', dependsOn: [] }],
        steps: [{ id: 'ready', kind: 'wait', status: 'waiting' }] } })); });
    await new Promise<void>((resolve, reject) => { host.once('error', reject); host.listen(0, '127.0.0.1', resolve); });
    try { const address = host.address(); if (!address || typeof address === 'string') throw new Error();
      const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'workflow-resume', '--url', `http://127.0.0.1:${address.port}`,
        '--id', workflowId, '--revision', '2', '--command-id', 'resume-1', '--token-stdin'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stdin.end('TOKEN_PRIVATE\n'); let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; }); const exitCode = await new Promise<number | null>(resolve => { child.once('exit', resolve); });
      expect(exitCode).toBe(0); expect(stderr).toBe(''); expect(stdout).not.toMatch(/TOKEN_PRIVATE|resume-1/); expect(requests).toBe(1);
      expect(received).toEqual({ commandId: 'resume-1', revision: 2 });
    } finally { await new Promise<void>(resolve => { host.close(() => { resolve(); }); }); }
  });

  it('reads, holds and releases the fleet and validates each acknowledgement', async () => {
    const calls: { path: string; body?: unknown }[] = [];
    const transport: typeof fetch = async (input, init) => { const path = new URL(String(input)).pathname;
      calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const fleet = path.endsWith('/hold') ? { held: true, generation: 2, changedAtMs: 9 } : { held: false, generation: 2, changedAtMs: 10 };
      return new Response(JSON.stringify({ fleet }), { headers: { 'content-type': 'application/json' } }); };
    const settings = { baseUrl: 'https://agent.example.test', token: () => 'TOKEN_PRIVATE', fetch: transport };
    expect(await inspectWorkflowFleet(settings)).toEqual({ held: false, generation: 2, changedAtMs: 10 });
    expect((await holdWorkflowFleet(settings)).held).toBe(true); expect((await releaseWorkflowFleet(settings)).held).toBe(false);
    expect(calls).toEqual([{ path: '/v1/workflow-fleet' }, { path: '/v1/workflow-fleet/hold', body: {} }, { path: '/v1/workflow-fleet/release', body: {} }]);
    const lying = { ...settings, fetch: (async () => new Response(JSON.stringify({ fleet: { held: false, generation: 0, changedAtMs: null } }),
      { headers: { 'content-type': 'application/json' } })) as typeof fetch };
    await expect(holdWorkflowFleet(lying)).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    await expect(sweepWorkflowFleet(settings, { phase: 'pause', cursor: null, limit: 0 })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('follows bounded fleet sweep pages from the executable and resumes from a cursor file', async () => {
    const runId = 'b'.repeat(64); const bodies: unknown[] = [];
    const host = createServer(async (request, response) => { expect(request.headers.authorization).toBe('Bearer TOKEN_PRIVATE');
      expect(request.url).toBe('/v1/workflow-fleet/sweeps/pause'); let body = ''; for await (const chunk of request) body += String(chunk);
      const parsed = JSON.parse(body) as { cursor: unknown }; bodies.push(parsed);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ sweep: { outcomes: [{ target: 'lifecycle', runId, outcome: parsed.cursor === null ? 'paused' : 'busy' }],
        nextCursor: parsed.cursor === null ? { next: 1 } : null } })); });
    await new Promise<void>((resolve, reject) => { host.once('error', reject); host.listen(0, '127.0.0.1', resolve); });
    const run = async (extra: readonly string[]) => {
      const address = host.address(); if (!address || typeof address === 'string') throw new Error();
      const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'fleet-sweep', '--url', `http://127.0.0.1:${address.port}`,
        '--phase', 'pause', ...extra, '--token-stdin'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stdin.end('TOKEN_PRIVATE\n'); let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; }); const exitCode = await new Promise<number | null>(resolve => { child.once('exit', resolve); });
      expect(exitCode).toBe(0); expect(stderr).toBe(''); expect(stdout).not.toContain('TOKEN_PRIVATE'); return JSON.parse(stdout) as Record<string, unknown>;
    };
    try {
      expect(await run(['--max-pages', '8'])).toEqual({ status: 'succeeded', phase: 'pause', pages: 2, nextCursor: null,
        outcomes: [{ target: 'lifecycle', runId, outcome: 'paused' }, { target: 'lifecycle', runId, outcome: 'busy' }] });
      expect(await run(['--max-pages', '1', '--limit', '4'])).toMatchObject({ status: 'incomplete', pages: 1, nextCursor: { next: 1 } });
      const root = await directory(); const cursorFile = join(root, 'cursor.json'); await writeFile(cursorFile, JSON.stringify({ next: 1 }));
      expect(await run(['--cursor-file', cursorFile])).toMatchObject({ status: 'succeeded', pages: 1, outcomes: [{ outcome: 'busy' }] });
      expect(bodies).toEqual([{ cursor: null, limit: 32 }, { cursor: { next: 1 }, limit: 32 }, { cursor: null, limit: 4 }, { cursor: { next: 1 }, limit: 32 }]);
    } finally { await new Promise<void>(resolve => { host.close(() => { resolve(); }); }); }
  });

  it('sends one executable workflow pause request with a piped credential', async () => {
    const workflowId = 'a'.repeat(64); let received: unknown; let requests = 0;
    const host = createServer(async (request, response) => { requests += 1; expect(request.headers.authorization).toBe('Bearer TOKEN_PRIVATE');
      expect(request.url).toBe(`/v1/workflow-runs/${workflowId}/pause`); let body = ''; for await (const chunk of request) body += String(chunk); received = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ workflow: { format: 3, definitionId: 'deploy',
        definitionVersion: '1', runId: workflowId, revision: 2, status: 'paused', nodes: [{ id: 'ready', kind: 'wait', dependsOn: [] }],
        steps: [{ id: 'ready', kind: 'wait', status: 'waiting' }] } })); });
    await new Promise<void>((resolve, reject) => { host.once('error', reject); host.listen(0, '127.0.0.1', resolve); });
    try { const address = host.address(); if (!address || typeof address === 'string') throw new Error();
      const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'workflow-pause', '--url', `http://127.0.0.1:${address.port}`,
        '--id', workflowId, '--revision', '2', '--command-id', 'pause-1', '--token-stdin'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stdin.end('TOKEN_PRIVATE\n'); let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; }); const exitCode = await new Promise<number | null>(resolve => { child.once('exit', resolve); });
      expect(exitCode).toBe(0); expect(stderr).toBe(''); expect(stdout).not.toMatch(/TOKEN_PRIVATE|pause-1/); expect(requests).toBe(1);
      expect(received).toEqual({ commandId: 'pause-1', revision: 2 });
    } finally { await new Promise<void>(resolve => { host.close(() => { resolve(); }); }); }
  });
});
