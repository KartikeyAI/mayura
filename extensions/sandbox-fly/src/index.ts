import { MayuraError } from 'mayura';
import {
  commandSandboxBackend, SandboxError, sandboxHttpFailure, sandboxResponseFailure,
  type ProviderSandboxSpec, type SandboxBackend, type SandboxProvider,
} from 'mayura/sandbox';

export interface FlySandboxOptions {
  /** A Fly.io API token for the app (`fly tokens create deploy`). Nothing is read from the environment. */
  readonly token: string;
  /** The Fly app sandboxes are Machines of; create it first (`fly apps create`). */
  readonly app: string;
  /**
   * The image Machines run, such as `docker.io/library/alpine:3.22`. It needs a POSIX shell, `sleep`, `base64`,
   * `setsid` and the usual tools.
   */
  readonly image: string;
  /** The region, such as `iad`; Fly's choice by default. */
  readonly region?: string;
  /** `shared` (the default) or `performance` CPUs. */
  readonly cpuKind?: 'shared' | 'performance';
  /** The working directory, made when the sandbox starts; `/workspace` by default. */
  readonly workdir?: string;
  /** The longest lifetime; 24 hours by default. */
  readonly maxLifetimeMs?: number;
  /** The Machines API; `https://api.machines.dev` by default. */
  readonly apiUrl?: string;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
}

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
/**
 * Fly.io Machines as sandboxes: a Firecracker VM per sandbox in one of your apps, over the Machines API with fetch and
 * no dependencies. Machines reach the internet, so sandboxes are created only with the network `'all'`, allowed in
 * `createSandboxes` and asked for. Give the result to `createSandboxes` from `mayura/sandbox`.
 */
export function flySandboxes(options: FlySandboxOptions): SandboxProvider {
  if (!options || typeof options.token !== 'string' || !/^[!-~ ]{8,8192}$/u.test(options.token)) throw new MayuraError('INVALID_CONFIG', 'flySandboxes(): token must be a Fly.io API token.');
  const token = options.token.startsWith('FlyV1 ') || options.token.startsWith('Bearer ') ? options.token : `Bearer ${options.token}`;
  if (typeof options.app !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(options.app)) throw new MayuraError('INVALID_CONFIG', 'flySandboxes(): app must be a Fly app name.');
  if (typeof options.image !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/u.test(options.image)) throw new MayuraError('INVALID_CONFIG', 'flySandboxes(): image must be an image reference.');
  if (options.region !== undefined && (typeof options.region !== 'string' || !/^[a-z]{3}$/u.test(options.region))) throw new MayuraError('INVALID_CONFIG', 'flySandboxes(): region must be a Fly region code, such as iad.');
  const cpuKind = options.cpuKind ?? 'shared';
  if (cpuKind !== 'shared' && cpuKind !== 'performance') throw new MayuraError('INVALID_CONFIG', "flySandboxes(): cpuKind is 'shared' or 'performance'.");
  const workdir = options.workdir ?? '/workspace';
  if (typeof workdir !== 'string' || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(workdir) || workdir.split('/').some(part => part === '.' || part === '..')) {
    throw new MayuraError('INVALID_CONFIG', 'flySandboxes(): workdir must be an absolute, normalized path.');
  }
  const maxLifetimeMs = options.maxLifetimeMs ?? 86_400_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000 || maxLifetimeMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'flySandboxes(): maxLifetimeMs is 1 s to about 24 days.');
  const apiUrl = (() => {
    try { const url = new URL(options.apiUrl ?? 'https://api.machines.dev'); if (url.protocol !== 'https:') throw new Error(); return url.origin; }
    catch { throw new MayuraError('INVALID_CONFIG', 'flySandboxes(): apiUrl must be an https URL.'); }
  })();
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'flySandboxes(): fetch must be a function.');
  const fetcher = options.fetch ?? globalThis.fetch;
  const app = `${apiUrl}/v1/apps/${options.app}/machines`;
  const headers = (extra: Record<string, string> = {}) => ({ authorization: token, ...extra });

  const create = async (spec: ProviderSandboxSpec, { signal }: { readonly signal: AbortSignal }): Promise<SandboxBackend> => {
    // flySandboxes declares only 'all', so createSandboxes asks for nothing else.
    if (spec.memoryMiB !== undefined && (spec.memoryMiB < 256 || spec.memoryMiB % 256 !== 0)) throw new MayuraError('INVALID_INPUT', 'Fly gives memory in multiples of 256 MiB.');
    if (spec.cpus !== undefined && !Number.isSafeInteger(spec.cpus)) throw new MayuraError('INVALID_INPUT', 'Fly gives whole CPUs.');
    if (spec.image !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/u.test(spec.image)) throw new MayuraError('INVALID_INPUT', 'image must be an image reference.');
    const name = `mayura-${randomHex(12)}`;
    const response = await fetcher(app, { method: 'POST', signal, headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({
      name, ...(options.region ? { region: options.region } : {}),
      config: {
        image: spec.image ?? options.image, env: spec.env, metadata: spec.labels,
        guest: { cpu_kind: cpuKind, cpus: spec.cpus ?? 1, memory_mb: spec.memoryMiB ?? 1_024 },
        // The Machine's only process sleeps for the lifetime; when it ends, the Machine is destroyed.
        init: { exec: ['sleep', String(Math.ceil(spec.lifetimeMs / 1_000) + 5)] },
        auto_destroy: true, restart: { policy: 'no' },
      },
    }) });
    if (response.status === 404) { void response.body?.cancel().catch(() => undefined); throw new SandboxError('rejected', 404); }
    if (response.status !== 200 && response.status !== 201) throw sandboxResponseFailure(response);
    const machine = await response.json().catch(() => undefined) as { id?: unknown; instance_id?: unknown } | undefined;
    const id = machine?.id;
    if (typeof id !== 'string' || !/^[a-z0-9]{1,64}$/u.test(id)) throw new SandboxError('invalid_response');
    const machineUrl = `${app}/${id}`;
    const release = async (callSignal: AbortSignal) => {
      const reply = await fetcher(`${machineUrl}?force=true`, { method: 'DELETE', signal: callSignal, headers: headers() });
      void reply.body?.cancel().catch(() => undefined);
      if (reply.status !== 200 && reply.status !== 204 && reply.status !== 404) throw sandboxHttpFailure(reply.status);
    };

    /** Runs a short command through Fly's exec, which runs at most 60 s and answers with text. */
    const exec = async (command: readonly string[], callSignal: AbortSignal, stdin?: string) => {
      const reply = await fetcher(`${machineUrl}/exec`, { method: 'POST', signal: callSignal, headers: headers({ 'content-type': 'application/json', accept: 'application/json' }),
        body: JSON.stringify({ command, timeout: 55, ...(stdin === undefined ? {} : { stdin }) }) });
      if (reply.status !== 200) throw sandboxResponseFailure(reply);
      const result = await reply.json().catch(() => undefined) as { exit_code?: unknown; stdout?: unknown } | undefined;
      if (!result || !Number.isSafeInteger(result.exit_code ?? 0)) throw new SandboxError('invalid_response');
      return { exitCode: (result.exit_code ?? 0) as number, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
    };

    try {
      // Fly starts the Machine; wait for it, then make the working directory.
      for (;;) {
        const reply = await fetcher(`${machineUrl}/wait?state=started&timeout=30`, { signal, headers: headers() });
        void reply.body?.cancel().catch(() => undefined);
        if (reply.status === 200) break;
        if (reply.status !== 408) throw sandboxHttpFailure(reply.status);
      }
      const made = await exec(['mkdir', '-p', workdir], signal);
      if (made.exitCode !== 0) throw new SandboxError('rejected');
    } catch (error) {
      await release(AbortSignal.timeout(30_000)).catch(() => undefined);
      throw error;
    }

    // Commands run in the background and are polled, and output and files move as base64 in chunks of 1 MiB.
    return commandSandboxBackend(id, { stdin: true, run: (command, runOptions) => exec(command, runOptions.signal, runOptions.stdin) }, release);
  };

  return Object.freeze({
    id: 'fly', workdir, maxLifetimeMs,
    // Fly Machines reach the internet, and Fly has no way to stop them: 'none' cannot be enforced.
    features: Object.freeze({ stdin: true, ports: false, desktop: false, network: Object.freeze(['all'] as const) }),
    create,
  });
}
