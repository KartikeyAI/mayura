import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineSandboxAdapter, type CodeToolOutcome, type SandboxAdapter, type SandboxExecutionRequest, type SandboxExecutionResult } from '@mayura/code-mode';

interface ToolMessage { readonly v: 1; readonly type: 'tool'; readonly requestId: number; readonly toolId: string; readonly input: unknown }
interface ResultMessage { readonly v: 1; readonly type: 'result'; readonly status: 'succeeded' | 'failed'; readonly output?: unknown }

const adjacentWorker = fileURLToPath(new URL('./worker.js', import.meta.url));
const workerPath = existsSync(adjacentWorker) ? adjacentWorker : fileURLToPath(new URL('../dist/worker.js', import.meta.url));
const MAX_PROTOCOL_BYTES = 16 * 1_024 * 1_024;

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

function write(child: ChildProcessWithoutNullStreams, value: unknown): boolean {
  try {
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > MAX_PROTOCOL_BYTES || child.stdin.destroyed) return false;
    child.stdin.write(line);
    return true;
  } catch { return false; }
}

function terminate(child: ChildProcessWithoutNullStreams): void {
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
      killer.unref();
    }
  }
}

function run(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
  if (request.manifest.language !== 'javascript' || request.manifest.approvedImports.length !== 0) {
    return Promise.resolve(Object.freeze({ status: 'failed' }));
  }
  return new Promise(resolve => {
    let settled = false;
    let stdout = '';
    let stderrBytes = 0;
    const requestIds = new Set<number>();
    const child = spawn(process.execPath, [workerPath], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      env: Object.freeze({}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (result: SandboxExecutionResult): void => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener('abort', abort);
      terminate(child);
      resolve(Object.freeze(result));
    };
    const abort = (): void => finish({ status: 'failed' });
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) { abort(); return; }
    child.once('error', () => finish({ status: 'failed' }));
    child.once('exit', () => finish({ status: 'failed' }));
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 64 * 1_024) finish({ status: 'failed' });
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_PROTOCOL_BYTES) { finish({ status: 'failed' }); return; }
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) break;
        const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
        const message = parseMessage(line);
        if (!message) { finish({ status: 'failed' }); return; }
        if (message.type === 'result') {
          if (message.status === 'succeeded' && Object.hasOwn(message, 'output')) finish({ status: 'succeeded', output: message.output });
          else finish({ status: 'failed' });
          return;
        }
        if (requestIds.has(message.requestId)) { finish({ status: 'failed' }); return; }
        requestIds.add(message.requestId);
        void request.tools.call(message.toolId, message.input).then(
          outcome => { if (!settled && !write(child, { v: 1, type: 'toolResult', requestId: message.requestId, outcome })) finish({ status: 'failed' }); },
          () => { if (!settled && !write(child, { v: 1, type: 'toolResult', requestId: message.requestId,
            outcome: { status: 'failed', error: { code: 'TOOL_FAILED', message: 'Tool execution failed.' } } satisfies CodeToolOutcome })) finish({ status: 'failed' }); },
        );
      }
    });
    if (!write(child, { v: 1, type: 'start', executionId: request.executionId, manifest: request.manifest,
      source: request.source, input: request.input })) finish({ status: 'failed' });
  });
}

/**
 * Creates the disposable QuickJS/WASM inner-interpreter adapter.
 * It is intentionally unqualified for hostile production code until wrapped by a qualified outer sandbox.
 */
export function createQuickJsSandboxAdapter(): SandboxAdapter {
  return defineSandboxAdapter({
    id: 'mayura.quickjs-child',
    version: '0.1.0',
    qualification: 'test',
    isAvailable: () => true,
    execute: run,
  });
}
