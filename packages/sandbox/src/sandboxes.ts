import { assertPositiveInteger, MayuraError, sniffMediaType } from '@mayura/core';
import { utf8ByteLength } from '@mayura/core/host';
import {
  SandboxError,
  type SandboxBackend, type SandboxEntry, type SandboxFeatures, type SandboxNetwork, type SandboxNetworkMode, type SandboxProvider,
} from './contracts.js';

export interface SandboxesOptions {
  /** The most sandboxes alive at once, counting those being created. */
  readonly maxSandboxes: number;
  /** The longest lifetime a sandbox may be given, in milliseconds; at most the provider's. */
  readonly maxLifetimeMs: number;
  /**
   * The network kinds sandboxes may be given: `['none']` by default, so sandboxes reach nothing. Listing `'all'` or
   * `'allowlist'` is what permits a sandbox to be created with that network.
   */
  readonly network?: readonly SandboxNetworkMode[];
  /** How long a command may run when the caller does not say; 60 s by default. */
  readonly execTimeoutMs?: number;
  /** The longest a caller may let a command run; 30 minutes by default. */
  readonly maxExecTimeoutMs?: number;
  /** The most bytes of stdout, and of stderr, kept from one command; 1 MiB by default, at most 16 MiB. */
  readonly maxOutputBytes?: number;
  /** The largest file read or written; 16 MiB by default, at most 1 GiB. Files are held in memory. */
  readonly maxFileBytes?: number;
  /** How long any other provider call may take; 120 s by default. */
  readonly callTimeoutMs?: number;
  /** Labels given to every sandbox, merged under each sandbox's own. */
  readonly labels?: Readonly<Record<string, string>>;
}

export interface CreateSandboxOptions {
  /** How long the sandbox may live, in milliseconds; it is ended then, if not released before. */
  readonly lifetimeMs: number;
  /** `'none'` by default. Anything else must be listed in the `network` option of `createSandboxes`. */
  readonly network?: SandboxNetwork;
  /** Environment variables every command sees: up to 100, 128 KiB in all. */
  readonly env?: Readonly<Record<string, string>>;
  /** Ports to serve at a URL, for providers with `ports`; up to 16. */
  readonly ports?: readonly number[];
  readonly cpus?: number;
  readonly memoryMiB?: number;
  /** The provider's image or template, instead of its default. */
  readonly image?: string;
  /** Up to 16 labels: lowercase keys of letters, digits, `.`, `_` and `-`, and printable ASCII values. */
  readonly labels?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface ExecOptions {
  /** The directory to run in: absolute, or relative to the sandbox's `workdir`, which is the default. */
  readonly cwd?: string;
  /** Environment variables for this command, over the sandbox's. */
  readonly env?: Readonly<Record<string, string>>;
  /** Standard input, for providers with `stdin`; at most `maxFileBytes`. */
  readonly stdin?: Uint8Array | string;
  /** Stop the command after this long; the `execTimeoutMs` of `createSandboxes` by default. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** How a command ended. Output is decoded as UTF-8; write binary output to a file and read that instead. */
export interface ExecResult {
  /** The exit code; undefined when the command was stopped at its timeout. */
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** Whether stdout or stderr had more than `maxOutputBytes`, which were dropped. */
  readonly truncated: boolean;
  readonly durationMs: number;
}

/** A sandbox's desktop, checked: coordinates are whole pixels, text and keys bounded. */
export interface Desktop {
  size(options?: { readonly signal?: AbortSignal }): Promise<{ readonly width: number; readonly height: number }>;
  screenshot(options?: { readonly signal?: AbortSignal }): Promise<{ readonly data: Uint8Array; readonly mediaType: 'image/png' | 'image/jpeg' }>;
  click(x: number, y: number, options?: { readonly button?: 'left' | 'right' | 'middle'; readonly double?: boolean; readonly signal?: AbortSignal }): Promise<void>;
  move(x: number, y: number, options?: { readonly signal?: AbortSignal }): Promise<void>;
  scroll(x: number, y: number, options: { readonly dx?: number; readonly dy?: number; readonly signal?: AbortSignal }): Promise<void>;
  type(text: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
  key(keys: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
  /** A URL where a person can watch the desktop; undefined when the provider has none. */
  viewUrl(options?: { readonly signal?: AbortSignal }): Promise<string | undefined>;
}

/** A sandbox: commands and files in an isolated machine, until it is released or its lifetime ends. */
export interface Sandbox {
  readonly id: string;
  /** The provider's id, such as `docker`. */
  readonly provider: string;
  readonly features: SandboxFeatures;
  /** The directory commands run in and relative paths start from. */
  readonly workdir: string;
  readonly network: SandboxNetwork;
  /** When the sandbox's lifetime ends, in Unix milliseconds. */
  readonly expiresAt: number;
  /** Whether it was released or its lifetime ended. */
  readonly ended: boolean;
  /** Runs a command, given as its arguments: `['npm', 'test']`, or `['sh', '-c', 'npm install && npm test']` for a shell. */
  exec(command: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  /** The file, or undefined when there is none. */
  readFile(path: string, options?: { readonly maxBytes?: number; readonly signal?: AbortSignal }): Promise<Uint8Array | undefined>;
  /** Writes a file, creating its directories and replacing any file there. Text is written as UTF-8. */
  writeFile(path: string, data: Uint8Array | string, options?: { readonly signal?: AbortSignal }): Promise<void>;
  /** A directory's entries by name, or undefined when there is no such directory. */
  listFiles(path?: string, options?: { readonly limit?: number; readonly signal?: AbortSignal }): Promise<readonly SandboxEntry[] | undefined>;
  /** Removes a file, or a directory and everything in it with `recursive`. */
  removeFile(path: string, options?: { readonly recursive?: boolean; readonly signal?: AbortSignal }): Promise<void>;
  /** The URL serving one of the sandbox's `ports`. */
  url(port: number, options?: { readonly signal?: AbortSignal }): Promise<string>;
  /** The desktop, for providers with `desktop`. */
  readonly desktop?: Desktop;
  /** Ends the sandbox. Releasing it again does nothing. */
  release(options?: { readonly signal?: AbortSignal }): Promise<void>;
}

/** Sandboxes from one provider, within limits. */
export interface Sandboxes {
  readonly provider: string;
  readonly features: SandboxFeatures;
  readonly workdir: string;
  /** Sandboxes alive now, counting those being created. */
  readonly active: number;
  create(options: CreateSandboxOptions): Promise<Sandbox>;
  /** Releases every sandbox still alive and refuses new ones. */
  close(): Promise<void>;
}

const networkModes: readonly SandboxNetworkMode[] = ['none', 'all', 'allowlist'];
const providerId = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const envName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const labelKey = /^[a-z0-9][a-z0-9._-]{0,62}$/u;
const domain = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/u;
const keysPattern = /^[A-Za-z0-9]+(?:\+[A-Za-z0-9]+){0,4}$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');
const maxScreenshotBytes = 16 * 1_048_576;
/** How long a provider may take to stop a command after its timeout, before the call gives up on it. */
const stopGraceMs = 10_000;

const invalid = () => new SandboxError('invalid_response');
const gone = () => new SandboxError('gone');
const cancelled = () => new MayuraError('CANCELLED', 'The sandbox call was cancelled.');

function features(value: unknown): SandboxFeatures {
  const item = value as Partial<SandboxFeatures> | null;
  if (!item || typeof item !== 'object' || typeof item.stdin !== 'boolean' || typeof item.ports !== 'boolean' || typeof item.desktop !== 'boolean'
    || !Array.isArray(item.network) || item.network.length === 0 || item.network.some(mode => !networkModes.includes(mode))) throw new MayuraError('INVALID_CONFIG', 'The sandbox provider must declare its features.');
  return Object.freeze({ stdin: item.stdin, ports: item.ports, desktop: item.desktop, network: Object.freeze([...new Set(item.network)]) });
}

/** `path` as an absolute, normalized path: relative paths start at `workdir`; `..` cannot climb above `/`. */
export function sandboxPath(path: unknown, workdir: string): string {
  if (typeof path !== 'string' || path === '' || utf8ByteLength(path) > 4_096 || /[\u0000-\u001f\u007f]/u.test(path) || /\p{Cs}/u.test(path)) {
    throw new MayuraError('INVALID_INPUT', 'A sandbox path is text without control characters, at most 4,096 bytes.');
  }
  const parts: string[] = [];
  for (const segment of (path.startsWith('/') ? path : `${workdir}/${path}`).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { if (parts.length === 0) throw new MayuraError('INVALID_INPUT', 'A sandbox path cannot climb above /.'); parts.pop(); continue; }
    parts.push(segment);
  }
  return `/${parts.join('/')}`;
}
function variables(value: unknown, name: string): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MayuraError('INVALID_INPUT', `${name} must be an object of strings.`);
  const entries = Object.entries(value as Record<string, unknown>); let bytes = 0;
  if (entries.length > 100) throw new MayuraError('INVALID_INPUT', `${name} has at most 100 variables.`);
  for (const [key, item] of entries) {
    if (!envName.test(key) || typeof item !== 'string' || item.includes('\u0000')) throw new MayuraError('INVALID_INPUT', `${name}: names are letters, digits and _, not starting with a digit, and values text without NUL.`);
    bytes += key.length + utf8ByteLength(item);
  }
  if (bytes > 131_072) throw new MayuraError('INVALID_INPUT', `${name} is at most 128 KiB.`);
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}
function labels(value: unknown, name = 'labels'): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MayuraError('INVALID_INPUT', `${name} must be an object of strings.`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 16) throw new MayuraError('INVALID_INPUT', `${name} has at most 16 entries.`);
  for (const [key, item] of entries) {
    if (!labelKey.test(key) || typeof item !== 'string' || !/^[ -~]{0,256}$/u.test(item)) throw new MayuraError('INVALID_INPUT', `${name}: keys are lowercase letters, digits, ., _ and -, and values printable ASCII.`);
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}
function network(value: unknown, allowed: readonly SandboxNetworkMode[], provider: SandboxFeatures, id: string): SandboxNetwork {
  if (value === undefined || value === 'none') {
    if (!provider.network.includes('none')) throw new MayuraError('INVALID_INPUT', `The ${id} sandbox provider cannot keep sandboxes off the network: create them with the network 'all'.`);
    return 'none';
  }
  let mode: SandboxNetworkMode; let result: SandboxNetwork;
  if (value === 'all') { mode = 'all'; result = 'all'; } else {
    const allow = (value as { allow?: unknown } | null)?.allow;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(allow) || allow.length === 0 || allow.length > 64
      || allow.some(item => typeof item !== 'string' || item.length > 253 || !domain.test(item))) {
      throw new MayuraError('INVALID_INPUT', "network is 'none', 'all' or { allow: [domains] }, with 1 to 64 lowercase domains such as registry.npmjs.org or *.github.com.");
    }
    mode = 'allowlist'; result = Object.freeze({ allow: Object.freeze([...new Set(allow as string[])]) });
  }
  if (!allowed.includes(mode)) throw new MayuraError('PERMISSION_DENIED', `Sandboxes may not be given the network '${mode}'; list it in the network option of createSandboxes to allow it.`);
  if (!provider.network.includes(mode)) throw new MayuraError('INVALID_INPUT', `The ${id} sandbox provider cannot enforce the network '${mode}'.`);
  return result;
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new MayuraError('INVALID_INPUT', `${name} must be a whole number from ${min} to ${max}.`);
  return value as number;
}
function bound(value: number | undefined, name: string, fallback: number, max: number): number {
  const result = value ?? fallback; assertPositiveInteger(result, name);
  if (result > max) throw new MayuraError('INVALID_CONFIG', `${name} is at most ${max}.`);
  return result;
}
function checkSignal(signal: unknown): AbortSignal | undefined {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new MayuraError('INVALID_INPUT', 'signal must be an AbortSignal.');
  if ((signal as AbortSignal | undefined)?.aborted) throw cancelled();
  return signal as AbortSignal | undefined;
}

/** One call's signal: aborted by the caller's signal or at the timeout. */
function callSignal(timeoutMs: number, caller: AbortSignal | undefined) {
  const controller = new AbortController(); let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  caller?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    failure(error: unknown): never {
      if (timedOut) throw new SandboxError('timeout');
      if (caller?.aborted) throw cancelled();
      if (error instanceof MayuraError) throw error;
      if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) throw new SandboxError('unavailable');
      throw invalid();
    },
    done() { clearTimeout(timer); caller?.removeEventListener('abort', onAbort); },
  };
}

/** Settles with `promise`, or with undefined once `grace` ms pass after `signal` aborts. */
function settleWithin<T>(promise: Promise<T>, signal: AbortSignal, grace: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => { timer = setTimeout(() => resolve(undefined), grace); };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); });
  });
}

function output(value: unknown, max: number): { text: string; truncated: boolean } {
  if (!(value instanceof Uint8Array)) throw invalid();
  return value.byteLength > max ? { text: decoder.decode(value.subarray(0, max)), truncated: true } : { text: decoder.decode(value), truncated: false };
}

/**
 * Sandboxes from a provider, such as `dockerSandboxes(...)` from `mayura/sandbox/docker` or a `@mayurajs/sandbox-*`
 * package's, within limits: how many at once, how long each lives, what network each may reach, how long commands run
 * and how much they return. Every path, size and option is checked before the provider is called.
 */
export function createSandboxes(provider: SandboxProvider, options: SandboxesOptions): Sandboxes {
  if (!provider || typeof provider.id !== 'string' || !providerId.test(provider.id) || typeof provider.create !== 'function') throw new MayuraError('INVALID_CONFIG', 'createSandboxes() needs a sandbox provider.');
  const id = provider.id; const providerFeatures = features(provider.features);
  const workdir = (() => { try { return sandboxPath(provider.workdir, '/'); } catch { throw new MayuraError('INVALID_CONFIG', 'The sandbox provider must name its workdir.'); } })();
  if (provider.workdir !== workdir) throw new MayuraError('INVALID_CONFIG', 'The sandbox provider\'s workdir must be an absolute, normalized path.');
  assertPositiveInteger(provider.maxLifetimeMs, 'provider maxLifetimeMs');
  if (!options) throw new MayuraError('INVALID_CONFIG', 'createSandboxes() needs options with maxSandboxes and maxLifetimeMs.');
  const maxSandboxes = options.maxSandboxes; assertPositiveInteger(maxSandboxes, 'maxSandboxes');
  if (maxSandboxes > 1_000) throw new MayuraError('INVALID_CONFIG', 'maxSandboxes is at most 1,000.');
  const maxLifetimeMs = options.maxLifetimeMs; assertPositiveInteger(maxLifetimeMs, 'maxLifetimeMs');
  if (maxLifetimeMs > provider.maxLifetimeMs) throw new MayuraError('INVALID_CONFIG', `maxLifetimeMs is at most ${provider.maxLifetimeMs} for the ${id} provider.`);
  // Timers fire at most this far ahead.
  if (maxLifetimeMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'maxLifetimeMs is at most 2,147,483,647 (about 24 days).');
  const allowedNetwork = options.network ?? ['none'];
  if (!Array.isArray(allowedNetwork) || allowedNetwork.some(mode => !networkModes.includes(mode))) throw new MayuraError('INVALID_CONFIG', "network lists 'none', 'all' and 'allowlist'.");
  const maxExecTimeoutMs = bound(options.maxExecTimeoutMs, 'maxExecTimeoutMs', 1_800_000, 86_400_000);
  const execTimeoutMs = bound(options.execTimeoutMs, 'execTimeoutMs', Math.min(60_000, maxExecTimeoutMs), maxExecTimeoutMs);
  const maxOutputBytes = bound(options.maxOutputBytes, 'maxOutputBytes', 1_048_576, 16 * 1_048_576);
  const maxFileBytes = bound(options.maxFileBytes, 'maxFileBytes', 16 * 1_048_576, 1_073_741_824);
  const callTimeoutMs = bound(options.callTimeoutMs, 'callTimeoutMs', 120_000, 3_600_000);
  const baseLabels = labels(options.labels);

  const alive = new Set<{ release(): Promise<void> }>();
  let pending = 0; let closed = false;

  const wrap = (backend: SandboxBackend, spec: { network: SandboxNetwork; ports: readonly number[]; lifetimeMs: number }): Sandbox => {
    if (!backend || typeof backend.id !== 'string' || !/^[ -~]{1,256}$/u.test(backend.id)
      || (['exec', 'readFile', 'writeFile', 'listFiles', 'removeFile', 'release'] as const).some(name => typeof backend[name] !== 'function')) throw invalid();
    if (providerFeatures.ports && spec.ports.length > 0 && typeof backend.url !== 'function') throw invalid();
    if (providerFeatures.desktop && (!backend.desktop || (['size', 'screenshot', 'click', 'move', 'scroll', 'type', 'key'] as const).some(name => typeof backend.desktop![name] !== 'function'))) throw invalid();
    const expiresAt = Date.now() + spec.lifetimeMs;
    let ended = false; let released = false; let releasing: Promise<void> | undefined;
    const release = (caller?: AbortSignal): Promise<void> => {
      if (released) return Promise.resolve();
      if (releasing) return releasing;
      ended = true; clearTimeout(expiry);
      const call = callSignal(callTimeoutMs, caller);
      releasing = (async () => {
        try {
          await backend.release({ signal: call.signal });
        } catch (error) {
          // A sandbox that already ended is released. Otherwise it may still be running: it keeps counting, and
          // releasing it again (or closing) tries again.
          if (!(error instanceof SandboxError && error.reason === 'gone')) { releasing = undefined; call.failure(error); }
        } finally { call.done(); }
        released = true; alive.delete(entry);
      })();
      return releasing;
    };
    const entry = { release: () => release() };
    // A backstop: the provider ends the sandbox at its lifetime, and this releases it if the provider did not.
    const expiry = setTimeout(() => { void release().catch(() => undefined); }, spec.lifetimeMs);
    (expiry as { unref?: () => void }).unref?.();
    alive.add(entry);

    const run = async <T>(caller: AbortSignal | undefined, body: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      checkSignal(caller);
      if (ended || Date.now() >= expiresAt) throw gone();
      const call = callSignal(callTimeoutMs, caller);
      try { return await body(call.signal); } catch (error) { return call.failure(error); } finally { call.done(); }
    };
    const path = (value: unknown) => sandboxPath(value, workdir);

    const desktopBackend = providerFeatures.desktop ? backend.desktop! : undefined;
    const coordinate = (value: unknown, name: string) => integer(value, name, 0, 100_000);
    const desktop: Desktop | undefined = desktopBackend && Object.freeze({
      size: async (callOptions: { readonly signal?: AbortSignal } = {}) => run(callOptions.signal, async signal => {
        const size = await desktopBackend.size({ signal });
        if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1 || size.width > 100_000 || size.height > 100_000) throw invalid();
        return Object.freeze({ width: size.width, height: size.height });
      }),
      screenshot: async (callOptions: { readonly signal?: AbortSignal } = {}) => run(callOptions.signal, async signal => {
        const shot = await desktopBackend.screenshot({ signal });
        if (!shot || !(shot.data instanceof Uint8Array) || shot.data.byteLength === 0 || (shot.mediaType !== 'image/png' && shot.mediaType !== 'image/jpeg')) throw invalid();
        // The bytes must be the image they claim to be.
        if (sniffMediaType(shot.data) !== shot.mediaType) throw invalid();
        if (shot.data.byteLength > maxScreenshotBytes) throw new MayuraError('LIMIT_EXCEEDED', 'The screenshot is larger than 16 MiB.');
        return Object.freeze({ data: shot.data, mediaType: shot.mediaType });
      }),
      click: async (x: number, y: number, callOptions: { readonly button?: 'left' | 'right' | 'middle'; readonly double?: boolean; readonly signal?: AbortSignal } = {}) => {
        const at = [coordinate(x, 'x'), coordinate(y, 'y')] as const; const button = callOptions.button ?? 'left';
        if (!['left', 'right', 'middle'].includes(button)) throw new MayuraError('INVALID_INPUT', "button is 'left', 'right' or 'middle'.");
        if (callOptions.double !== undefined && typeof callOptions.double !== 'boolean') throw new MayuraError('INVALID_INPUT', 'double must be a boolean.');
        await run(callOptions.signal, signal => desktopBackend.click(at[0], at[1], { button, double: callOptions.double ?? false, signal }));
      },
      move: async (x: number, y: number, callOptions: { readonly signal?: AbortSignal } = {}) => {
        const at = [coordinate(x, 'x'), coordinate(y, 'y')] as const;
        await run(callOptions.signal, signal => desktopBackend.move(at[0], at[1], { signal }));
      },
      scroll: async (x: number, y: number, callOptions: { readonly dx?: number; readonly dy?: number; readonly signal?: AbortSignal }) => {
        const at = [coordinate(x, 'x'), coordinate(y, 'y')] as const;
        const dx = integer(callOptions?.dx ?? 0, 'dx', -100, 100); const dy = integer(callOptions?.dy ?? 0, 'dy', -100, 100);
        await run(callOptions?.signal, signal => desktopBackend.scroll(at[0], at[1], { dx, dy, signal }));
      },
      type: async (text: string, callOptions: { readonly signal?: AbortSignal } = {}) => {
        if (typeof text !== 'string' || text.length === 0 || text.length > 10_000 || text.includes('\u0000')) throw new MayuraError('INVALID_INPUT', 'text is 1 to 10,000 characters.');
        await run(callOptions.signal, signal => desktopBackend.type(text, { signal }));
      },
      key: async (keys: string, callOptions: { readonly signal?: AbortSignal } = {}) => {
        if (typeof keys !== 'string' || !keysPattern.test(keys)) throw new MayuraError('INVALID_INPUT', 'keys is a key or a chord joined with +, such as Enter or ctrl+c.');
        await run(callOptions.signal, signal => desktopBackend.key(keys, { signal }));
      },
      viewUrl: async (callOptions: { readonly signal?: AbortSignal } = {}) => {
        if (typeof desktopBackend.viewUrl !== 'function') return undefined;
        return run(callOptions.signal, async signal => checkedUrl(await desktopBackend.viewUrl!({ signal })));
      },
    });

    return Object.freeze({
      id: backend.id, provider: id, features: providerFeatures, workdir, network: spec.network, expiresAt,
      get ended() { return ended || Date.now() >= expiresAt; },
      exec: async (command: readonly string[], execOptions: ExecOptions = {}): Promise<ExecResult> => {
        if (!Array.isArray(command) || command.length === 0 || command.length > 4_096 || command.some(item => typeof item !== 'string' || item.includes('\u0000'))
          || typeof command[0] !== 'string' || command[0] === '') throw new MayuraError('INVALID_INPUT', 'command is a non-empty list of arguments without NUL, the program first.');
        if (command.reduce((total, item) => total + utf8ByteLength(item) + 1, 0) > 131_072) throw new MayuraError('INVALID_INPUT', 'command is at most 128 KiB.');
        const cwd = execOptions.cwd === undefined ? workdir : path(execOptions.cwd);
        const env = variables(execOptions.env, 'env');
        let stdin: Uint8Array | undefined;
        if (execOptions.stdin !== undefined) {
          if (!providerFeatures.stdin) throw new MayuraError('INVALID_INPUT', `The ${id} sandbox provider cannot give a command standard input.`);
          if (typeof execOptions.stdin === 'string') stdin = encoder.encode(execOptions.stdin);
          else if (execOptions.stdin instanceof Uint8Array) stdin = execOptions.stdin.slice();
          else throw new MayuraError('INVALID_INPUT', 'stdin is text or a Uint8Array.');
          if (stdin.byteLength > maxFileBytes) throw new MayuraError('LIMIT_EXCEEDED', `stdin is at most ${maxFileBytes} bytes.`);
        }
        const timeoutMs = execOptions.timeoutMs === undefined ? execTimeoutMs : integer(execOptions.timeoutMs, 'timeoutMs', 1, maxExecTimeoutMs);
        const caller = checkSignal(execOptions.signal);
        if (ended || Date.now() >= expiresAt) throw gone();
        const controller = new AbortController(); let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(timeoutMs, Math.max(1, expiresAt - Date.now())));
        const onAbort = () => controller.abort();
        caller?.addEventListener('abort', onAbort, { once: true });
        const started = Date.now();
        try {
          let result;
          try {
            result = await settleWithin(backend.exec([...command], { cwd, env, maxOutputBytes, signal: controller.signal, ...(stdin ? { stdin } : {}) }), controller.signal, stopGraceMs);
          } catch (error) {
            if (caller?.aborted) throw cancelled();
            if (timedOut) result = undefined;
            else if (error instanceof MayuraError) throw error;
            else if (error instanceof TypeError) throw new SandboxError('unavailable');
            else throw invalid();
          }
          if (caller?.aborted) throw cancelled();
          if (result === undefined) {
            if (!timedOut) throw invalid();
            return Object.freeze({ timedOut: true, stdout: '', stderr: '', truncated: false, durationMs: Date.now() - started });
          }
          if (!result || typeof result !== 'object') throw invalid();
          const exitCode = result.exitCode;
          if (exitCode !== undefined && (!Number.isSafeInteger(exitCode) || exitCode < -2_147_483_648 || exitCode > 2_147_483_647)) throw invalid();
          if (exitCode === undefined && !timedOut) throw invalid();
          const out = output(result.stdout, maxOutputBytes); const err = output(result.stderr, maxOutputBytes);
          return Object.freeze({ ...(exitCode === undefined ? {} : { exitCode }), timedOut: exitCode === undefined, stdout: out.text, stderr: err.text,
            truncated: out.truncated || err.truncated || result.truncated === true, durationMs: Date.now() - started });
        } finally { clearTimeout(timer); caller?.removeEventListener('abort', onAbort); }
      },
      readFile: async (file: string, readOptions: { readonly maxBytes?: number; readonly signal?: AbortSignal } = {}) => {
        const target = path(file);
        const maxBytes = readOptions.maxBytes === undefined ? maxFileBytes : integer(readOptions.maxBytes, 'maxBytes', 0, maxFileBytes);
        return run(readOptions.signal, async signal => {
          const data = await backend.readFile(target, { maxBytes, signal });
          if (data === undefined) return undefined;
          if (!(data instanceof Uint8Array)) throw invalid();
          if (data.byteLength > maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxBytes} bytes.`);
          return data;
        });
      },
      writeFile: async (file: string, data: Uint8Array | string, writeOptions: { readonly signal?: AbortSignal } = {}) => {
        const target = path(file);
        if (target === '/') throw new MayuraError('INVALID_INPUT', 'Name a file to write.');
        const bytes = typeof data === 'string' ? encoder.encode(data) : data instanceof Uint8Array ? data.slice() : undefined;
        if (!bytes) throw new MayuraError('INVALID_INPUT', 'data is text or a Uint8Array.');
        if (bytes.byteLength > maxFileBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxFileBytes} bytes.`);
        await run(writeOptions.signal, signal => backend.writeFile(target, bytes, { signal }));
      },
      listFiles: async (directory?: string, listOptions: { readonly limit?: number; readonly signal?: AbortSignal } = {}) => {
        const target = directory === undefined ? workdir : path(directory);
        const limit = listOptions.limit === undefined ? 1_000 : integer(listOptions.limit, 'limit', 1, 10_000);
        return run(listOptions.signal, async signal => {
          const entries = await backend.listFiles(target, { limit, signal });
          if (entries === undefined) return undefined;
          if (!Array.isArray(entries) || entries.length > limit) throw invalid();
          const checked = entries.map((entry: SandboxEntry) => {
            if (!entry || typeof entry.name !== 'string' || entry.name === '' || entry.name === '.' || entry.name === '..' || entry.name.includes('/') || /[\u0000-\u001f\u007f]/u.test(entry.name)
              || !['file', 'directory', 'other'].includes(entry.type) || !Number.isSafeInteger(entry.size) || entry.size < 0
              || (entry.modified !== undefined && !Number.isFinite(entry.modified))) throw invalid();
            return Object.freeze({ name: entry.name, type: entry.type, size: entry.size, ...(entry.modified === undefined ? {} : { modified: entry.modified }) });
          }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
          return Object.freeze(checked);
        });
      },
      removeFile: async (file: string, removeOptions: { readonly recursive?: boolean; readonly signal?: AbortSignal } = {}) => {
        const target = path(file);
        if (target === '/') throw new MayuraError('INVALID_INPUT', 'The root directory cannot be removed.');
        if (removeOptions.recursive !== undefined && typeof removeOptions.recursive !== 'boolean') throw new MayuraError('INVALID_INPUT', 'recursive must be a boolean.');
        await run(removeOptions.signal, signal => backend.removeFile(target, { recursive: removeOptions.recursive ?? false, signal }));
      },
      url: async (port: number, urlOptions: { readonly signal?: AbortSignal } = {}) => {
        if (!providerFeatures.ports) throw new MayuraError('INVALID_INPUT', `The ${id} sandbox provider does not serve ports.`);
        if (!spec.ports.includes(port)) throw new MayuraError('INVALID_INPUT', 'Only a port listed when the sandbox was created has a URL.');
        return run(urlOptions.signal, async signal => checkedUrl(await backend.url!(port, { signal })));
      },
      ...(desktop ? { desktop } : {}),
      release: async (releaseOptions: { readonly signal?: AbortSignal } = {}) => { checkSignal(releaseOptions.signal); await release(releaseOptions.signal); },
    });
  };

  return Object.freeze({
    provider: id, features: providerFeatures, workdir,
    get active() { return alive.size + pending; },
    create: async (createOptions: CreateSandboxOptions): Promise<Sandbox> => {
      if (!createOptions || typeof createOptions !== 'object') throw new MayuraError('INVALID_INPUT', 'create() needs options with lifetimeMs.');
      const lifetimeMs = integer(createOptions.lifetimeMs, 'lifetimeMs', 1_000, maxLifetimeMs);
      const net = network(createOptions.network, allowedNetwork, providerFeatures, id);
      const env = variables(createOptions.env, 'env');
      const ports = createOptions.ports === undefined ? [] : createOptions.ports;
      if (!Array.isArray(ports) || ports.length > 16) throw new MayuraError('INVALID_INPUT', 'ports is a list of at most 16 ports.');
      ports.forEach(port => integer(port, 'port', 1, 65_535));
      if (new Set(ports).size !== ports.length) throw new MayuraError('INVALID_INPUT', 'ports are listed once each.');
      if (ports.length > 0 && !providerFeatures.ports) throw new MayuraError('INVALID_INPUT', `The ${id} sandbox provider does not serve ports.`);
      if (createOptions.cpus !== undefined && (typeof createOptions.cpus !== 'number' || !Number.isFinite(createOptions.cpus) || createOptions.cpus <= 0 || createOptions.cpus > 256)) throw new MayuraError('INVALID_INPUT', 'cpus is a number from above 0 to 256.');
      if (createOptions.memoryMiB !== undefined) integer(createOptions.memoryMiB, 'memoryMiB', 16, 4_194_304);
      if (createOptions.image !== undefined && (typeof createOptions.image !== 'string' || !/^[!-~]{1,512}$/u.test(createOptions.image))) throw new MayuraError('INVALID_INPUT', 'image is printable ASCII without spaces, at most 512 characters.');
      const ownLabels = labels(createOptions.labels); const merged = { ...baseLabels, ...ownLabels };
      if (Object.keys(merged).length > 16) throw new MayuraError('INVALID_INPUT', 'A sandbox has at most 16 labels in all.');
      const caller = checkSignal(createOptions.signal);
      if (closed) throw new MayuraError('INVALID_INPUT', 'These sandboxes were closed.');
      if (alive.size + pending >= maxSandboxes) throw new MayuraError('LIMIT_EXCEEDED', `At most ${maxSandboxes} sandboxes may be alive at once.`);
      pending++;
      const call = callSignal(callTimeoutMs, caller);
      let backend: SandboxBackend | undefined;
      try {
        backend = await provider.create(Object.freeze({ lifetimeMs, network: net, env, ports: Object.freeze([...ports]), labels: Object.freeze(merged),
          ...(createOptions.cpus === undefined ? {} : { cpus: createOptions.cpus }), ...(createOptions.memoryMiB === undefined ? {} : { memoryMiB: createOptions.memoryMiB }),
          ...(createOptions.image === undefined ? {} : { image: createOptions.image }) }), { signal: call.signal });
        if (closed || call.signal.aborted) throw call.timedOut ? new SandboxError('timeout') : closed ? new MayuraError('INVALID_INPUT', 'These sandboxes were closed.') : cancelled();
        return wrap(backend, { network: net, ports, lifetimeMs });
      } catch (error) {
        // A sandbox created but not handed over (cancelled, closed, or not valid) is released, not leaked.
        if (backend && typeof backend.release === 'function') void backend.release({ signal: AbortSignal.timeout(callTimeoutMs) }).catch(() => undefined);
        return call.failure(error);
      } finally { pending--; call.done(); }
    },
    close: async () => {
      closed = true;
      const results = await Promise.allSettled([...alive].map(entry => entry.release()));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw (failed as PromiseRejectedResult).reason;
    },
  });
}

function checkedUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'wss:' && url.protocol !== 'ws:') throw invalid();
  return url.href;
}
