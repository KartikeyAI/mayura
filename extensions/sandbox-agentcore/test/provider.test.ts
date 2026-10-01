import { describe, expect, it } from 'vitest';
import { MayuraError } from 'mayura';
import { createSandboxes } from 'mayura/sandbox';
import { agentCoreSandboxes } from '../src/index.js';
import { exceptionEvent, fakeAgentCore, resultEvent } from './fake.js';

const credentials = { accessKeyId: 'AKIDTESTEXAMPLE', secretAccessKey: 'test-secret-not-real' };
const limits = { maxSandboxes: 3, maxLifetimeMs: 600_000 };

describe('agentCoreSandboxes', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => agentCoreSandboxes({ region: 'mars', credentials })).toThrow(/region/u);
    expect(() => agentCoreSandboxes({ region: 'us-east-1', credentials: { accessKeyId: '', secretAccessKey: 'x' } })).toThrow(/credentials/u);
    expect(() => agentCoreSandboxes({ region: 'us-east-1', credentials, codeInterpreter: 'has space' })).toThrow(/codeInterpreter/u);
    expect(() => agentCoreSandboxes({ region: 'us-east-1', credentials, network: 'allowlist' as never })).toThrow(/network/u);
    expect(() => agentCoreSandboxes({ region: 'us-east-1', credentials, maxLifetimeMs: 28_800_001 })).toThrow(/maxLifetimeMs/u);
    expect(agentCoreSandboxes({ region: 'us-east-1', credentials })).toMatchObject({ id: 'agentcore', workdir: '/tmp/workspace', maxLifetimeMs: 28_800_000,
      features: { stdin: true, ports: false, desktop: false, network: ['none'] } });
    expect(agentCoreSandboxes({ region: 'us-east-1', credentials, network: 'all' }).features.network).toEqual(['all']);
  });

  it('starts a signed session for the lifetime on AWS\'s Code Interpreter, and makes the working directory', async () => {
    const fake = fakeAgentCore(() => ({ exitCode: 0 }));
    const box = await createSandboxes(agentCoreSandboxes({ region: 'us-east-1', credentials, fetch: fake.fetch }), limits).create({ lifetimeMs: 90_500 });
    expect(box.id).toBe('sess-1');
    const start = fake.seen[0]!;
    expect([start.method, start.url.origin, start.url.pathname]).toEqual(['PUT', 'https://bedrock-agentcore.us-east-1.amazonaws.com', '/code-interpreters/aws.codeinterpreter.v1/sessions/start']);
    expect(start.json).toMatchObject({ name: expect.stringMatching(/^mayura-[a-f0-9]{24}$/u), sessionTimeoutSeconds: 91 });
    expect(start.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTESTEXAMPLE\/\d{8}\/us-east-1\/bedrock-agentcore\/aws4_request, SignedHeaders=.+, Signature=[a-f0-9]{64}$/u);
    expect(fake.commands[0]).toBe("'mkdir' '-p' '/tmp/workspace'");
    const invoke = fake.seen[1]!;
    expect(invoke.url.pathname).toBe('/code-interpreters/aws.codeinterpreter.v1/tools/invoke');
    expect(invoke.headers.get('x-amzn-code-interpreter-session-id')).toBe('sess-1');
    expect(invoke.json).toMatchObject({ name: 'executeCommand' });
  });

  it('starts on another Code Interpreter when a sandbox names one as its image, and refuses resources', async () => {
    const fake = fakeAgentCore(() => ({ exitCode: 0 })); const sandboxes = createSandboxes(agentCoreSandboxes({ region: 'eu-west-1', credentials, fetch: fake.fetch }), limits);
    await (await sandboxes.create({ lifetimeMs: 60_000, image: 'my-interpreter-abc123' })).release();
    expect(fake.seen[0]!.url.pathname).toBe('/code-interpreters/my-interpreter-abc123/sessions/start');
    expect(await sandboxes.create({ lifetimeMs: 60_000, cpus: 2 }).catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('cannot be given a network its Code Interpreter does not have', async () => {
    const fake = fakeAgentCore(() => ({ exitCode: 0 }));
    expect(await createSandboxes(agentCoreSandboxes({ region: 'us-east-1', credentials, fetch: fake.fetch }), { ...limits, network: ['none', 'all'] })
      .create({ lifetimeMs: 60_000, network: 'all' }).catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await createSandboxes(agentCoreSandboxes({ region: 'us-east-1', credentials, fetch: fake.fetch, network: 'all' }), limits)
      .create({ lifetimeMs: 60_000 }).catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('off the network') });
    expect(fake.seen).toHaveLength(0);
  });

  it('maps AWS errors to fixed ones without AWS\'s text, from replies and from within the stream', async () => {
    for (const [type, status, reason] of [['AccessDeniedException', 403, 'authentication'], ['ThrottlingException', 429, 'rate_limited'], ['ServiceQuotaExceededException', 402, 'quota'],
      ['ValidationException', 400, 'rejected'], ['InternalServerException', 500, 'unavailable']] as const) {
      const fake = fakeAgentCore(() => ({ exitCode: 0 }), { start: () => Response.json({ message: 'secret detail from aws' }, { status, headers: { 'x-amzn-errortype': type } }) });
      const error = await createSandboxes(agentCoreSandboxes({ region: 'us-east-1', credentials, fetch: fake.fetch }), limits).create({ lifetimeMs: 60_000 })
        .then(() => undefined, (caught: unknown) => caught as MayuraError);
      expect(error).toMatchObject({ reason }); expect(error!.message).not.toContain('secret');
    }
    let stream: Uint8Array[] = [exceptionEvent('throttlingException')];
    const fake = fakeAgentCore(command => command.includes('mkdir') ? { exitCode: 0 } : stream);
    const box = await createSandboxes(agentCoreSandboxes({ region: 'us-east-1', credentials, fetch: fake.fetch }), limits).create({ lifetimeMs: 60_000 });
    const error = await box.listFiles().then(() => undefined, (caught: unknown) => caught as MayuraError);
    expect(error).toMatchObject({ reason: 'rate_limited' }); expect(error!.message).not.toContain('secret');
    stream = [resultEvent({ content: [], isError: true })];
    expect(await box.listFiles().catch(caught => caught)).toMatchObject({ reason: 'rejected' });
    stream = [];
    expect(await box.listFiles().catch(caught => caught)).toMatchObject({ reason: 'invalid_response' });
  });

  it('stops the session when its working directory cannot be made, and on release; one already gone counts as released', async () => {
    const failing = fakeAgentCore(() => ({ exitCode: 1 }));
    expect(await createSandboxes(agentCoreSandboxes({ region: 'us-east-1', credentials, fetch: failing.fetch }), limits).create({ lifetimeMs: 60_000 }).catch(caught => caught)).toMatchObject({ reason: 'rejected' });
    expect(failing.seen.at(-1)!.url.pathname).toBe('/code-interpreters/aws.codeinterpreter.v1/sessions/stop');
    let stop = (): Response => Response.json({ sessionId: 'sess-1' });
    const fake = fakeAgentCore(() => ({ exitCode: 0 }), { stop: () => stop() }); const sandboxes = createSandboxes(agentCoreSandboxes({ region: 'us-east-1', credentials, fetch: fake.fetch }), limits);
    await (await sandboxes.create({ lifetimeMs: 60_000 })).release();
    expect(fake.seen.at(-1)!.url.searchParams.get('sessionId')).toBe('sess-1');
    stop = () => Response.json({ message: 'gone' }, { status: 404, headers: { 'x-amzn-errortype': 'ResourceNotFoundException' } });
    await (await sandboxes.create({ lifetimeMs: 60_000 })).release();
    stop = () => Response.json({ message: 'x' }, { status: 500, headers: { 'x-amzn-errortype': 'InternalServerException' } });
    expect(await (await sandboxes.create({ lifetimeMs: 60_000 })).release().catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
  });

  it('works with a client you own', async () => {
    const fake = fakeAgentCore(() => ({ exitCode: 0 }));
    const { agentCoreClient } = await import('../src/index.js');
    const client = agentCoreClient({ region: 'us-west-2', credentials: async () => credentials, fetch: fake.fetch });
    await createSandboxes(agentCoreSandboxes({ client }), limits).create({ lifetimeMs: 60_000 });
    expect(fake.seen[0]!.url.origin).toBe('https://bedrock-agentcore.us-west-2.amazonaws.com');
    expect(() => agentCoreSandboxes({ client: {} as never })).toThrow(/client/u);
  });
});
