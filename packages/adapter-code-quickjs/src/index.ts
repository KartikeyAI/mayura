import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MayuraError } from '@mayura/core';
import {
  defineSandboxAdapter,
  type CodeToolOutcome,
  type SandboxAdapter,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxFailureReason,
  type SandboxQualification,
} from '@mayura/code-mode';
import { workerCommand, workerReadRoots } from './worker-command.js';

/** Minimal transport contract so outer adapters do not expose Node types to consumers. */
export interface QuickJsChildProcess {
  readonly stdin: { readonly destroyed: boolean; write(value: string): boolean; destroy(): void };
  readonly stdout: { setEncoding(value: 'utf8'): void; on(event: 'data', listener: (chunk: string) => void): unknown; destroy(): void };
  readonly stderr: { on(event: 'data', listener: (chunk: Uint8Array) => void): unknown; destroy(): void };
  readonly exitCode: number | null;
  readonly pid?: number;
  once(event: 'error' | 'exit', listener: () => void): unknown;
  kill(signal: 'SIGKILL'): boolean;
}

export interface QuickJsWorkerProcess {
  readonly child: QuickJsChildProcess;
  /** Stops the worker and releases everything it holds. Called exactly once per execution, however it ends. */
  terminate(): void;
}

export interface QuickJsProtocolAdapterOptions {
  readonly id: string;
  readonly version: string;
  /**
   * The isolation your `launch` provides. Defaults to `test`, which `createCodeMode` accepts only with
   * `allowTestAdapter: true`. Declare `production` only when the launched worker meets the guarantees you document.
   */
  readonly qualification?: SandboxQualification;
  readonly isAvailable?: () => boolean | Promise<boolean>;
  /** Starts one worker running the QuickJS worker protocol for this request. */
  readonly launch: (request: SandboxExecutionRequest) => QuickJsWorkerProcess;
}

interface ToolMessage { readonly v: 1; readonly type: 'tool'; readonly requestId: number; readonly toolId: string; readonly input: unknown }
interface ResultMessage { readonly v: 1; readonly type: 'result'; readonly status: 'succeeded' | 'failed'; readonly output?: unknown; readonly reason?: unknown; readonly programError?: unknown }

/** Envelope, tool id and escaped program-error text around the largest payload a line may carry. */
const PROTOCOL_OVERHEAD = 64 * 1_024;
const MAX_STDERR_BYTES = 64 * 1_024;
const MIB = 1_024 * 1_024;
const reasons: ReadonlySet<string> = new Set<SandboxFailureReason>(['program_error', 'cpu_limit', 'memory_limit', 'invalid_output',
  'unsupported_program', 'sandbox_error']);
const failed = (reason: SandboxFailureReason): SandboxExecutionResult => Object.freeze({ status: 'failed', reason });

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function parseMessage(line: string): ToolMessage | ResultMessage | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (!record(value) || value['v'] !== 1) return undefined;
    if (value['type'] === 'tool' && Number.isSafeInteger(value['requestId']) && (value['requestId'] as number) > 0
      && typeof value['toolId'] === 'string' && Object.hasOwn(value, 'input')) {
      return value as unknown as ToolMessage;
    }
    if (value['type'] === 'result' && (value['status'] === 'succeeded' || value['status'] === 'failed')) {
      return value as unknown as ResultMessage;
    }
  } catch { /* Protocol errors are fixed failures. */ }
  return undefined;
}

function resultOf(message: ResultMessage): SandboxExecutionResult {
  if (message.status === 'succeeded') return Object.hasOwn(message, 'output') ? Object.freeze({ status: 'succeeded', output: message.output }) : failed('sandbox_error');
  if (typeof message.reason !== 'string' || !reasons.has(message.reason)) return failed('sandbox_error');
  const programError = message.reason === 'program_error' && record(message.programError)
    && typeof message.programError['name'] === 'string' && typeof message.programError['message'] === 'string'
    ? Object.freeze({ name: message.programError['name'], message: message.programError['message'] }) : undefined;
  return Object.freeze({ status: 'failed', reason: message.reason as SandboxFailureReason, ...(programError ? { programError } : {}) });
}

function write(child: QuickJsChildProcess, value: unknown, maxBytes: number): boolean {
  try {
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > maxBytes || child.stdin.destroyed) return false;
    child.stdin.write(line);
    return true;
  } catch { return false; }
}

function terminate(child: QuickJsChildProcess): void {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  if (child.exitCode !== null || child.pid === undefined) return;
  child.kill('SIGKILL');
  // Node maps signals to TerminateProcess on Windows, but a WebAssembly allocation
  // failure can leave that request unobserved. taskkill is an exact-PID fallback for
  // this adapter-owned child and its descendants; no shell or generated value is used.
  if (process.platform === 'win32') {
    const systemRoot = process.env['SystemRoot'] ?? process.env['WINDIR'] ?? 'C:\\Windows';
    const taskkill = join(systemRoot, 'System32', 'taskkill.exe');
    if (existsSync(taskkill)) {
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => undefined);
      killer.unref();
    }
  }
}

function run(request: SandboxExecutionRequest, launch: QuickJsProtocolAdapterOptions['launch']): Promise<SandboxExecutionResult> {
  if (request.manifest.language !== 'javascript' || request.manifest.approvedImports.length !== 0) {
    return Promise.resolve(failed('unsupported_program'));
  }
  const limits = request.manifest.limits;
  const maxInboundLine = Math.max(limits.maxOutputBytes, limits.maxToolInputBytes) + PROTOCOL_OVERHEAD;
  const maxOutboundLine = 4 * (limits.maxInputBytes + limits.maxOutputBytes + 2 * MIB) + PROTOCOL_OVERHEAD;
  return new Promise(resolve => {
    let settled = false;
    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const requestIds = new Set<number>();
    let worker: QuickJsWorkerProcess;
    const finish = (result: SandboxExecutionResult): void => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener('abort', abort);
      try { worker?.terminate(); } catch { /* Termination is best effort; the worker also stops at its own deadline. */ }
      resolve(result);
    };
    const abort = (): void => finish(failed('sandbox_error'));
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) { abort(); return; }
    try { worker = launch(request); } catch { finish(failed('sandbox_error')); return; }
    const child = worker.child;
    child.once('error', () => finish(failed('sandbox_error')));
    child.once('exit', () => finish(failed('sandbox_error')));
    child.stderr.on('data', (chunk: Uint8Array) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_STDERR_BYTES) finish(failed('sandbox_error'));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      stdout += chunk;
      stdoutBytes += Buffer.byteLength(chunk);
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) break;
        const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
        stdoutBytes = Buffer.byteLength(stdout);
        if (Buffer.byteLength(line) > maxInboundLine) { finish(failed('sandbox_error')); return; }
        const message = parseMessage(line);
        if (!message) { finish(failed('sandbox_error')); return; }
        if (message.type === 'result') { finish(resultOf(message)); return; }
        // The worker answers calls beyond maxToolCalls itself, so more requests than that mean a broken worker.
        if (requestIds.has(message.requestId) || requestIds.size >= limits.maxToolCalls) { finish(failed('sandbox_error')); return; }
        requestIds.add(message.requestId);
        void request.tools.call(message.toolId, message.input).then(
          outcome => { if (!settled && !write(child, { v: 1, type: 'toolResult', requestId: message.requestId, outcome }, maxOutboundLine)) finish(failed('sandbox_error')); },
          () => { if (!settled && !write(child, { v: 1, type: 'toolResult', requestId: message.requestId,
            outcome: { status: 'failed', error: { code: 'TOOL_FAILED', message: 'The tool call failed.' } } satisfies CodeToolOutcome }, maxOutboundLine)) finish(failed('sandbox_error')); },
        );
      }
      if (stdoutBytes > maxInboundLine) finish(failed('sandbox_error'));
    });
    if (!write(child, { v: 1, type: 'start', executionId: request.executionId, manifest: request.manifest,
      source: request.source, input: request.input }, 64 * MIB)) finish(failed('sandbox_error'));
  });
}

function configError(message: string): MayuraError { return new MayuraError('INVALID_CONFIG', message); }

/**
 * Builds an adapter that speaks the QuickJS worker protocol to a worker your `launch` starts, for example inside an
 * outer sandbox. `mayura/adapter-code-docker` is built on it.
 */
export function createQuickJsProtocolAdapter(options: QuickJsProtocolAdapterOptions): SandboxAdapter {
  if (!options || typeof options !== 'object') throw configError('QuickJS protocol adapter options must be an object.');
  if (typeof options.launch !== 'function') throw configError('QuickJS protocol adapter launch must be a function.');
  if (options.isAvailable !== undefined && typeof options.isAvailable !== 'function') throw configError('QuickJS protocol adapter isAvailable must be a function.');
  if (options.qualification !== undefined && options.qualification !== 'test' && options.qualification !== 'production') {
    throw configError('QuickJS protocol adapter qualification must be "production" or "test".');
  }
  const launch = options.launch;
  return defineSandboxAdapter({
    id: options.id,
    version: options.version,
    qualification: options.qualification ?? 'test',
    isAvailable: options.isAvailable ?? (() => true),
    execute: request => run(request, launch),
  });
}

/**
 * Creates the QuickJS sandbox adapter. Each execution runs in a new Node.js child process with an empty environment,
 * the Node.js permission model (read-only access to the QuickJS packages; no file writes, child processes, worker
 * threads, native addons or WASI) and a fresh QuickJS WebAssembly interpreter with the program's CPU, memory and
 * stack limits. The program itself sees only standard JavaScript and `tools.call`.
 */
export function createQuickJsSandboxAdapter(): SandboxAdapter {
  return createQuickJsProtocolAdapter({
    id: 'mayura.quickjs-child',
    version: '1.0.0',
    qualification: 'production',
    isAvailable: () => workerReadRoots() !== null,
    launch: request => {
      const command = workerCommand(request.manifest.limits);
      if (!command) throw new Error('QuickJS packages are unavailable.');
      const child = spawn(command.command, [...command.args], { ...command.options, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as QuickJsChildProcess;
      return Object.freeze({ child, terminate: () => terminate(child) });
    },
  });
}
