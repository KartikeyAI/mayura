import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSRuntime,
} from 'quickjs-emscripten-core';

interface StartMessage {
  readonly v: 1;
  readonly type: 'start';
  readonly source: string;
  readonly input: unknown;
  readonly manifest: {
    readonly language: string;
    readonly approvedImports: readonly string[];
    readonly limits: { readonly cpuMillis: number; readonly memoryBytes: number; readonly maxOutputBytes: number };
  };
}

interface ToolResultMessage { readonly v: 1; readonly type: 'toolResult'; readonly requestId: number; readonly outcome: unknown }
const MAX_LINE_BYTES = 16 * 1_024 * 1_024;
let stdin = '';
let started = false;
let context: QuickJSContext | undefined;
let runtime: QuickJSRuntime | undefined;
let finalPromise: Promise<void> | undefined;
let nextRequestId = 0;
const deferred = new Map<number, QuickJSDeferredPromise>();

function emit(value: unknown): void {
  try {
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error();
    process.stdout.write(line);
  } catch { process.exitCode = 1; }
}

function fail(): void {
  emit({ v: 1, type: 'result', status: 'failed' });
  process.exitCode = 1;
}

function dataRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function start(message: StartMessage): void {
  if (started || message.manifest.language !== 'javascript' || message.manifest.approvedImports.length !== 0) { fail(); return; }
  started = true;
  finalPromise = (async () => {
    try {
      const quickjs = await newQuickJSWASMModuleFromVariant(import('@jitl/quickjs-wasmfile-release-sync'));
      runtime = quickjs.newRuntime();
      runtime.setMemoryLimit(message.manifest.limits.memoryBytes);
      runtime.setMaxStackSize(Math.max(64 * 1_024, Math.min(512 * 1_024, Math.floor(message.manifest.limits.memoryBytes / 4))));
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + message.manifest.limits.cpuMillis));
      context = runtime.newContext();
      const bridge = context.newFunction('__mayuraToolCall', payload => {
        try {
          const decoded: unknown = JSON.parse(context!.getString(payload));
          if (!dataRecord(decoded) || typeof decoded['toolId'] !== 'string' || !Object.hasOwn(decoded, 'input')) throw new Error();
          const requestId = ++nextRequestId;
          const pending = context!.newPromise();
          deferred.set(requestId, pending);
          emit({ v: 1, type: 'tool', requestId, toolId: decoded['toolId'], input: decoded['input'] });
          return pending.handle;
        } catch { return context!.undefined; }
      });
      context.setProp(context.global, '__mayuraToolCall', bridge);
      bridge.dispose();
      const input = JSON.stringify(message.input);
      if (input === undefined) throw new Error();
      const wrapped = `(async () => {
        "use strict";
        const input = JSON.parse(${JSON.stringify(input)});
        const tools = Object.freeze({ call: async (toolId, value) => JSON.parse(await __mayuraToolCall(JSON.stringify({ toolId, input: value }))) });
        const program = (${message.source});
        if (typeof program !== "function") throw new Error("invalid program");
        return JSON.stringify(await program(input, tools));
      })()`;
      const evaluated = context.evalCode(wrapped, 'mayura-code.js');
      if (evaluated.error) { evaluated.error.dispose(); throw new Error(); }
      const promiseHandle = evaluated.value;
      const resolution = context.resolvePromise(promiseHandle);
      runtime.executePendingJobs();
      const result = await resolution;
      promiseHandle.dispose();
      if (result.error) { result.error.dispose(); throw new Error(); }
      const serialized = context.getString(result.value);
      result.value.dispose();
      if (Buffer.byteLength(serialized) > message.manifest.limits.maxOutputBytes * 6 + 2) throw new Error();
      const output: unknown = JSON.parse(serialized);
      emit({ v: 1, type: 'result', status: 'succeeded', output });
    } catch { fail(); }
    finally {
      for (const pending of deferred.values()) pending.dispose();
      deferred.clear();
      context?.dispose();
      runtime?.dispose();
    }
  })();
}

function toolResult(message: ToolResultMessage): void {
  const pending = deferred.get(message.requestId);
  if (!pending || !context || !runtime) { fail(); return; }
  deferred.delete(message.requestId);
  try {
    const serialized = JSON.stringify(message.outcome);
    if (serialized === undefined || Buffer.byteLength(serialized) > MAX_LINE_BYTES) throw new Error();
    const handle = context.newString(serialized);
    pending.resolve(handle);
    handle.dispose();
    const jobs = runtime.executePendingJobs();
    if (jobs.error) { jobs.error.dispose(); fail(); }
  } catch { pending.dispose(); fail(); }
}

function receive(line: string): void {
  try {
    const message: unknown = JSON.parse(line);
    if (!dataRecord(message) || message['v'] !== 1 || typeof message['type'] !== 'string') throw new Error();
    if (message['type'] === 'start') start(message as unknown as StartMessage);
    else if (message['type'] === 'toolResult' && Number.isSafeInteger(message['requestId']) && Object.hasOwn(message, 'outcome')) {
      toolResult(message as unknown as ToolResultMessage);
    } else throw new Error();
  } catch { fail(); }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  stdin += chunk;
  if (Buffer.byteLength(stdin) > MAX_LINE_BYTES) { fail(); process.stdin.destroy(); return; }
  for (;;) {
    const newline = stdin.indexOf('\n');
    if (newline < 0) break;
    const line = stdin.slice(0, newline); stdin = stdin.slice(newline + 1);
    receive(line);
  }
});
process.stdin.once('end', () => { if (!finalPromise) fail(); });
