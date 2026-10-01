import { MayuraError } from 'mayura';
import {
  commandSandboxBackend, SandboxError,
  type ProviderSandboxSpec, type SandboxBackend, type SandboxFailureReason, type SandboxProvider,
} from 'mayura/sandbox';
import {
  BedrockAgentCoreClient, InvokeCodeInterpreterCommand, StartCodeInterpreterSessionCommand, StopCodeInterpreterSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';

/** AWS credentials, or a function that returns fresh ones (for example from your own STS call). */
export type AgentCoreAwsCredentials =
  | { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string }
  | (() => Promise<{ readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string }>);

export interface AgentCoreSandboxOptions {
  /** The AWS region, such as `us-east-1`. Required with `credentials`: nothing is read from the environment or AWS config files. */
  readonly region?: string;
  /** Signs requests (SigV4). Give these and `region`, or `client`. */
  readonly credentials?: AgentCoreAwsCredentials;
  /** A BedrockAgentCoreClient you create and own, instead of `region` and `credentials`. It is never destroyed here. */
  readonly client?: BedrockAgentCoreClient;
  /** The Code Interpreter sessions start on: AWS's own `aws.codeinterpreter.v1` by default, or one you created. A sandbox's `image` overrides it. */
  readonly codeInterpreter?: string;
  /**
   * What the Code Interpreter's network mode lets sandboxes reach, set when it was created: `'none'` for the sandbox
   * mode (AWS's own interpreter, which reaches only S3), `'all'` for the public mode. Mayura cannot change it.
   */
  readonly network?: 'none' | 'all';
  /** The working directory, made when the session starts; `/tmp/workspace` by default. */
  readonly workdir?: string;
  /** The longest lifetime; 8 hours by default, AWS's most. */
  readonly maxLifetimeMs?: number;
  /** The most bytes of a command line AgentCore takes, used to size pieces of files; 60,000 by default. */
  readonly maxCommandBytes?: number;
  /** For tests and proxies: the fetch to use, with `region` and `credentials`. */
  readonly fetch?: typeof fetch;
}

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The SDK's HTTP handler, over fetch. */
function fetchHandler(transport: () => typeof globalThis.fetch) {
  return {
    metadata: { handlerProtocol: 'http/1.1' },
    async handle(request: { method: string; protocol: string; hostname: string; port?: number; path: string; query?: Record<string, string | string[] | null>; headers: Record<string, string>; body?: unknown },
      options: { abortSignal?: AbortSignal } = {}) {
      const query = new URLSearchParams();
      for (const [name, value] of Object.entries(request.query ?? {})) for (const item of Array.isArray(value) ? value : [value]) query.append(name, item ?? '');
      const url = `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ''}${request.path}${query.size ? `?${query}` : ''}`;
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !['host', 'content-length'].includes(name.toLowerCase())));
      const response = await transport()(url, { method: request.method, headers, redirect: 'error',
        ...(request.body === undefined || request.body === null ? {} : { body: request.body as BodyInit }), ...(options.abortSignal ? { signal: options.abortSignal } : {}) });
      const responseHeaders: Record<string, string> = {}; response.headers.forEach((value, name) => { responseHeaders[name] = value; });
      return { response: { statusCode: response.status, reason: response.statusText, headers: responseHeaders,
        body: response.body ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }) } };
    },
    updateHttpClientConfig() { /* nothing to configure */ },
    httpHandlerConfigs() { return {}; },
    destroy() { /* nothing to release */ },
  };
}

/**
 * A BedrockAgentCoreClient configured only from these options: nothing is read from the environment, AWS config files
 * or instance metadata. Requests go through `fetch`.
 */
export function agentCoreClient(options: { readonly region: string; readonly credentials: AgentCoreAwsCredentials; readonly fetch?: typeof globalThis.fetch }): BedrockAgentCoreClient {
  if (typeof options.region !== 'string' || !/^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/u.test(options.region)) throw new MayuraError('INVALID_CONFIG', 'AgentCore needs a region, such as us-east-1.');
  const credentials = options.credentials;
  if (typeof credentials !== 'function' && (!credentials || typeof credentials.accessKeyId !== 'string' || !credentials.accessKeyId || typeof credentials.secretAccessKey !== 'string' || !credentials.secretAccessKey)) {
    throw new MayuraError('INVALID_CONFIG', 'AgentCore credentials need an accessKeyId and a secretAccessKey.');
  }
  return new BedrockAgentCoreClient({
    // Every setting the SDK would otherwise look up in the environment, AWS config files or instance metadata.
    region: options.region, useFipsEndpoint: false, useDualstackEndpoint: false, defaultsMode: 'standard', maxAttempts: 3, retryMode: 'standard',
    userAgentAppId: 'mayura', credentials, authSchemePreference: ['sigv4'],
    requestHandler: fetchHandler(() => options.fetch ?? globalThis.fetch) as never,
  } as never);
}

/** An AgentCore failure as a sandbox failure, without AWS's text. */
function failure(error: unknown): SandboxError | MayuraError {
  if (error instanceof MayuraError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
  const reasons: Readonly<Record<string, SandboxFailureReason>> = {
    AccessDeniedException: 'authentication', UnauthorizedException: 'authentication', ThrottlingException: 'rate_limited', ServiceQuotaExceededException: 'quota',
    ResourceNotFoundException: 'gone', ValidationException: 'rejected', ConflictException: 'rejected', InternalServerException: 'unavailable',
  };
  if (typeof name === 'string' && reasons[name]) return new SandboxError(reasons[name]!, Number.isSafeInteger(status) && (status as number) >= 100 && (status as number) <= 599 ? status as number : undefined);
  if (error instanceof TypeError || name === 'AbortError' || name === 'TimeoutError') return new SandboxError('unavailable');
  return new SandboxError('invalid_response');
}

/**
 * Amazon Bedrock AgentCore Code Interpreter sessions as sandboxes: a microVM per session, through the official AWS SDK.
 * Give the result to `createSandboxes` from `mayura/sandbox`.
 */
export function agentCoreSandboxes(options: AgentCoreSandboxOptions): SandboxProvider {
  if (!options || typeof options !== 'object') throw new MayuraError('INVALID_CONFIG', 'agentCoreSandboxes() needs options.');
  const client = options.client ?? agentCoreClient({ region: options.region as string, credentials: options.credentials as AgentCoreAwsCredentials, ...(options.fetch ? { fetch: options.fetch } : {}) });
  if (options.client !== undefined && (typeof options.client !== 'object' || typeof (options.client as { send?: unknown }).send !== 'function')) throw new MayuraError('INVALID_CONFIG', 'agentCoreSandboxes(): client must be a BedrockAgentCoreClient.');
  const interpreterPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
  const codeInterpreter = options.codeInterpreter ?? 'aws.codeinterpreter.v1';
  if (typeof codeInterpreter !== 'string' || !interpreterPattern.test(codeInterpreter)) throw new MayuraError('INVALID_CONFIG', 'agentCoreSandboxes(): codeInterpreter must be a Code Interpreter id.');
  const network = options.network ?? 'none';
  if (network !== 'none' && network !== 'all') throw new MayuraError('INVALID_CONFIG', "agentCoreSandboxes(): network is 'none' or 'all', as the Code Interpreter was created.");
  const workdir = options.workdir ?? '/tmp/workspace';
  if (typeof workdir !== 'string' || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(workdir) || workdir.split('/').some(part => part === '.' || part === '..')) {
    throw new MayuraError('INVALID_CONFIG', 'agentCoreSandboxes(): workdir must be an absolute, normalized path.');
  }
  const maxLifetimeMs = options.maxLifetimeMs ?? 28_800_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000 || maxLifetimeMs > 28_800_000) throw new MayuraError('INVALID_CONFIG', 'agentCoreSandboxes(): maxLifetimeMs is 1 s to 8 hours.');
  const maxCommandBytes = options.maxCommandBytes ?? 60_000;
  if (!Number.isSafeInteger(maxCommandBytes) || maxCommandBytes < 8_192) throw new MayuraError('INVALID_CONFIG', 'agentCoreSandboxes(): maxCommandBytes is at least 8 KiB.');

  const create = async (spec: ProviderSandboxSpec, { signal }: { readonly signal: AbortSignal }): Promise<SandboxBackend> => {
    if (spec.cpus !== undefined || spec.memoryMiB !== undefined) throw new MayuraError('INVALID_INPUT', 'AgentCore sessions have fixed resources.');
    const interpreter = spec.image ?? codeInterpreter;
    if (!interpreterPattern.test(interpreter)) throw new MayuraError('INVALID_INPUT', 'image must be a Code Interpreter id.');
    let sessionId: string | undefined;
    try {
      const started = await client.send(new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: interpreter, name: `mayura-${randomHex(12)}`, sessionTimeoutSeconds: Math.max(1, Math.ceil(spec.lifetimeMs / 1_000)),
      }), { abortSignal: signal });
      sessionId = started.sessionId;
    } catch (error) { throw failure(error); }
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) throw new SandboxError('invalid_response');
    const session = sessionId;
    const release = async (callSignal: AbortSignal) => {
      // A session that already ended fails as gone, which createSandboxes counts as released.
      try { await client.send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: interpreter, sessionId: session }), { abortSignal: callSignal }); }
      catch (error) { throw failure(error); }
    };
    /** Runs a short shell command line with AgentCore's executeCommand; its exit code and stdout. */
    const run = async (command: readonly string[], runOptions: { readonly signal: AbortSignal }) => {
      try {
        const reply = await client.send(new InvokeCodeInterpreterCommand({ codeInterpreterIdentifier: interpreter, sessionId: session, name: 'executeCommand',
          arguments: { command: command.map(quote).join(' ') } }), { abortSignal: runOptions.signal });
        if (!reply.stream) throw new SandboxError('invalid_response');
        for await (const event of reply.stream) {
          if ('result' in event && event.result) {
            const content = event.result.structuredContent;
            if (!content || !Number.isSafeInteger(content.exitCode)) throw new SandboxError(event.result.isError ? 'rejected' : 'invalid_response');
            return { exitCode: content.exitCode as number, stdout: content.stdout ?? '' };
          }
          // Errors AWS sends within the stream are thrown by the SDK as exceptions; anything else is not valid.
        }
        throw new SandboxError('invalid_response');
      } catch (error) { throw failure(error); }
    };
    try {
      const made = await run(['mkdir', '-p', workdir], { signal });
      if (made.exitCode !== 0) throw new SandboxError('rejected');
    } catch (error) {
      await release(AbortSignal.timeout(30_000)).catch(() => undefined);
      throw error;
    }
    const backend = commandSandboxBackend(session, { stdin: false, maxCommandBytes, run }, release);
    // AgentCore sessions have no environment of their own: the sandbox's goes with every command.
    return { ...backend, exec: (command, execOptions) => backend.exec(command, { ...execOptions, env: { ...spec.env, ...execOptions.env } }) };
  };

  return Object.freeze({
    id: 'agentcore', workdir, maxLifetimeMs,
    features: Object.freeze({ stdin: true, ports: false, desktop: false, network: Object.freeze([network]) }),
    create,
  });
}
