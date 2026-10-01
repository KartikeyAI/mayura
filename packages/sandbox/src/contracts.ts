import { MayuraError } from '@mayura/core';

/**
 * What a sandbox may reach on the network: nothing (`'none'`, the default), anything (`'all'`), or only the listed
 * domains (`{ allow }`, such as `['registry.npmjs.org', '*.github.com']`) on providers that filter by domain.
 */
export type SandboxNetwork = 'none' | 'all' | { readonly allow: readonly string[] };
/** The network kinds a provider can enforce. */
export type SandboxNetworkMode = 'none' | 'all' | 'allowlist';

/** What a provider's sandboxes can do beyond running commands and handling files. */
export interface SandboxFeatures {
  /** Whether `exec` accepts `stdin`. */
  readonly stdin: boolean;
  /** Whether a sandbox can serve ports at a URL (`url(port)`). */
  readonly ports: boolean;
  /** Whether sandboxes have a desktop to see and control (`desktop`). */
  readonly desktop: boolean;
  /**
   * The network kinds the provider enforces. A provider that cannot keep sandboxes off the network leaves out
   * `'none'`: its sandboxes are then created only when the network `'all'` is both allowed and asked for.
   */
  readonly network: readonly SandboxNetworkMode[];
}

/** One entry of a directory listing. */
export interface SandboxEntry {
  /** Its name in the directory, without a path. */
  readonly name: string;
  readonly type: 'file' | 'directory' | 'other';
  /** Its size in bytes; 0 for a directory. */
  readonly size: number;
  /** When it last changed, in Unix milliseconds, when the provider reports it. */
  readonly modified?: number;
}

/** What a provider is asked to create, after `createSandboxes` checked it against its limits. */
export interface ProviderSandboxSpec {
  /** How long the sandbox may live, in milliseconds; the provider ends it then, or earlier when released. */
  readonly lifetimeMs: number;
  readonly network: SandboxNetwork;
  /** Environment variables every command sees. */
  readonly env: Readonly<Record<string, string>>;
  /** Ports to serve at a URL; empty unless the provider has `ports`. */
  readonly ports: readonly number[];
  readonly cpus?: number;
  readonly memoryMiB?: number;
  /** The provider's image or template, when the caller chose one. */
  readonly image?: string;
  /** Labels to tag the sandbox with, to find it in the provider's console. */
  readonly labels: Readonly<Record<string, string>>;
}

export interface BackendExecOptions {
  /** The absolute directory to run in. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Bytes to give the command on standard input; never set unless the provider has `stdin`. */
  readonly stdin?: Uint8Array;
  /** Keep at most this many bytes of each of stdout and stderr, and set `truncated` when there was more. */
  readonly maxOutputBytes: number;
  /** Ends the command: stop it and every process it started, then settle. */
  readonly signal: AbortSignal;
}
export interface BackendExecResult {
  /** The exit code; undefined when the command was stopped by `signal`. */
  readonly exitCode?: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly truncated?: boolean;
}

/** A sandbox's desktop, as a provider implements it. Coordinates are screen pixels from the top left. */
export interface SandboxDesktop {
  size(options: { readonly signal: AbortSignal }): Promise<{ readonly width: number; readonly height: number }>;
  screenshot(options: { readonly signal: AbortSignal }): Promise<{ readonly data: Uint8Array; readonly mediaType: 'image/png' | 'image/jpeg' }>;
  click(x: number, y: number, options: { readonly button: 'left' | 'right' | 'middle'; readonly double: boolean; readonly signal: AbortSignal }): Promise<void>;
  move(x: number, y: number, options: { readonly signal: AbortSignal }): Promise<void>;
  scroll(x: number, y: number, options: { readonly dx: number; readonly dy: number; readonly signal: AbortSignal }): Promise<void>;
  /** Types text as if from a keyboard. */
  type(text: string, options: { readonly signal: AbortSignal }): Promise<void>;
  /** Presses a key or a chord, such as `Enter` or `ctrl+c`. */
  key(keys: string, options: { readonly signal: AbortSignal }): Promise<void>;
  /** A URL where a person can watch (and on some providers use) the desktop, when the provider has one. */
  viewUrl?(options: { readonly signal: AbortSignal }): Promise<string>;
}

/**
 * One sandbox, as a provider implements it. `createSandboxes` checks every path, size and option before calling it,
 * and everything it returns before the caller sees it. Paths are absolute. Map failures to {@link SandboxError}
 * without the provider's text.
 */
export interface SandboxBackend {
  /** The provider's id for the sandbox. */
  readonly id: string;
  exec(command: readonly string[], options: BackendExecOptions): Promise<BackendExecResult>;
  /** The file's bytes, or undefined when there is none. Refuse (`LIMIT_EXCEEDED`) a file larger than `maxBytes`. */
  readFile(path: string, options: { readonly maxBytes: number; readonly signal: AbortSignal }): Promise<Uint8Array | undefined>;
  /** Writes the file, creating its parent directories and replacing a file already there. */
  writeFile(path: string, data: Uint8Array, options: { readonly signal: AbortSignal }): Promise<void>;
  /** The directory's entries, at most `limit` of them; undefined when there is no such directory. */
  listFiles(path: string, options: { readonly limit: number; readonly signal: AbortSignal }): Promise<readonly SandboxEntry[] | undefined>;
  /** Removes a file, or a directory with everything in it when `recursive`; removing nothing succeeds. */
  removeFile(path: string, options: { readonly recursive: boolean; readonly signal: AbortSignal }): Promise<void>;
  /** The URL serving a port listed at creation; for providers with `ports`. */
  url?(port: number, options: { readonly signal: AbortSignal }): Promise<string>;
  /** For providers with `desktop`. */
  readonly desktop?: SandboxDesktop;
  /** Ends the sandbox and frees what it holds; releasing one that already ended succeeds. */
  release(options: { readonly signal: AbortSignal }): Promise<void>;
}

/** What a sandbox provider implements, as the `@mayurajs/sandbox-*` packages and `mayura/sandbox/docker` export it. */
export interface SandboxProvider {
  /** Lowercase letters, digits and `-`, such as `docker` or `e2b`. */
  readonly id: string;
  readonly features: SandboxFeatures;
  /** The directory commands run in by default, such as `/workspace`. */
  readonly workdir: string;
  /** The longest lifetime the provider allows, in milliseconds. */
  readonly maxLifetimeMs: number;
  create(spec: ProviderSandboxSpec, options: { readonly signal: AbortSignal }): Promise<SandboxBackend>;
}

/** Why a sandbox call failed. */
export type SandboxFailureReason = 'authentication' | 'rate_limited' | 'quota' | 'unavailable' | 'timeout' | 'rejected' | 'gone' | 'invalid_response';

const messages: Readonly<Record<SandboxFailureReason, string>> = {
  authentication: 'The sandbox provider refused the credentials.',
  rate_limited: 'The sandbox provider is rate limiting requests.',
  quota: 'The sandbox provider refused for a plan or quota limit.',
  unavailable: 'The sandbox provider is unavailable.',
  timeout: 'The sandbox provider did not answer in time.',
  rejected: 'The sandbox provider rejected the request.',
  gone: 'The sandbox has ended.',
  invalid_response: 'The sandbox provider returned a response that is not valid.',
};

/** A sandbox failure, with a fixed message: nothing the provider wrote reaches it. */
export class SandboxError extends MayuraError {
  readonly reason: SandboxFailureReason;
  declare readonly httpStatus?: number;
  constructor(reason: SandboxFailureReason, httpStatus?: number) {
    if (!Object.hasOwn(messages, reason)) throw new MayuraError('INVALID_CONFIG', 'Unknown sandbox failure reason.');
    if (httpStatus !== undefined && (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) throw new MayuraError('INVALID_CONFIG', 'An HTTP status must be between 100 and 599.');
    super('TOOL_FAILED', httpStatus === undefined ? messages[reason] : `${messages[reason]} (HTTP ${httpStatus})`);
    this.reason = reason;
    if (httpStatus !== undefined) Object.defineProperty(this, 'httpStatus', { value: httpStatus, enumerable: true });
    Object.freeze(this);
  }
}

/** For providers: an HTTP error status as its failure. 404 and 410 mean the sandbox has ended. */
export function sandboxHttpFailure(status: number): SandboxError {
  if (status === 401 || status === 403) return new SandboxError('authentication', status);
  if (status === 404 || status === 410) return new SandboxError('gone', status);
  if (status === 402) return new SandboxError('quota', status);
  if (status === 429) return new SandboxError('rate_limited', status);
  if (status === 408 || status === 504) return new SandboxError('timeout', status);
  if (status >= 500) return new SandboxError('unavailable', status);
  return new SandboxError('rejected', status);
}

/** For HTTP providers: a non-2xx response as its failure, without reading the provider's text. */
export function sandboxResponseFailure(response: Response): SandboxError {
  void response.body?.cancel().catch(() => undefined);
  return sandboxHttpFailure(response.status);
}
