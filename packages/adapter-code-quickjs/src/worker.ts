// Disposable QuickJS worker: one process runs exactly one program, then the host kills it.
// Guest code runs only inside the QuickJS WebAssembly interpreter. This file is the trusted glue around it: it owns
// the metering, the tool bridge and the result encoding, and never evaluates guest text with the host engine.
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSSyncVariant,
} from 'quickjs-emscripten-core';

type FailureReason = 'program_error' | 'cpu_limit' | 'memory_limit' | 'invalid_output' | 'unsupported_program' | 'sandbox_error';

interface Limits {
  readonly cpuMillis: number;
  readonly wallTimeMillis: number;
  readonly memoryBytes: number;
  readonly maxOutputBytes: number;
  readonly maxToolInputBytes: number;
  readonly maxToolCalls: number;
}

interface StartMessage {
  readonly v: 1;
  readonly type: 'start';
  readonly source: string;
  readonly input: unknown;
  readonly manifest: { readonly language: string; readonly approvedImports: readonly string[]; readonly limits: Limits };
}

interface ToolResultMessage { readonly v: 1; readonly type: 'toolResult'; readonly requestId: number; readonly outcome: unknown }

/** The start line carries up to 1 MiB of source and 16 MiB of input; JSON escaping can grow both. */
const MAX_INBOUND_LINE = 64 * 1_024 * 1_024;
/** Unsent protocol output the worker will hold while the host is not reading. */
const MAX_OUTBOUND_BACKLOG = 64 * 1_024 * 1_024;
/** Room for the `{"toolId":…,"input":…}` envelope around a tool input. */
const TOOL_ENVELOPE = 1_024;
const WASM_PAGE = 65_536;
/**
 * The interpreter's own WebAssembly memory before any program runs: static data, its C stack and runtime state.
 * The program's heap may grow the memory by `memoryBytes` beyond this and no further.
 */
const INTERPRETER_PAGES = 256;
const MAX_WASM_PAGES = 32_768;
/**
 * QuickJS checks its recursion depth against its own stack, but QuickJS's C recursion also uses the host engine's
 * native stack. 256 KiB of QuickJS stack (about 1,500 plain JavaScript frames) stays below the interpreter's real
 * C stack; a deep native recursion that exhausts the host stack first is caught below as a stack overflow.
 */
const MAX_STACK_BYTES = 256 * 1_024;

// The prelude runs before any program code, so the intrinsics it captures cannot be replaced by the program.
// It removes the host bridge from the global object; the program reaches tools only through `tools.call`.
const PRELUDE = `(() => {
  "use strict";
  const bridge = globalThis.__mayuraToolCall;
  delete globalThis.__mayuraToolCall;
  const { stringify, parse } = JSON;
  const freeze = Object.freeze;
  const StringValue = String;
  const cut = Function.prototype.call.bind(String.prototype.slice);
  const text = (value, max) => typeof value === "string" ? cut(value, 0, max) : undefined;
  const tools = freeze({ call: freeze(async (toolId, input) => parse(await bridge(stringify({ toolId, input })))) });
  const run = async (program, inputText) => {
    if (typeof program !== "function") throw new TypeError("The program source must be a function expression, such as (input, tools) => output.");
    const result = await program(parse(inputText), tools);
    let output;
    try { output = stringify(result); } catch { return undefined; }
    return output;
  };
  const describe = error => {
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      let name; let message;
      try { name = text(error.name, 128); } catch {}
      try { message = text(error.message, 1024); } catch {}
      return stringify({ name: name ?? "Error", message: message ?? "" });
    }
    let message = "";
    try { message = cut(StringValue(error), 0, 1024); } catch {}
    return stringify({ name: "Error", message });
  };
  return freeze([run, describe]);
})()`;

let inbound = '';
let started = false;
let finished = false;
let context: QuickJSContext | undefined;
let runtime: QuickJSRuntime | undefined;
let run: QuickJSHandle | undefined;
let describe: QuickJSHandle | undefined;
let programPromise: QuickJSHandle | undefined;
let limits: Limits | undefined;
let nextRequestId = 0;
let toolCalls = 0;
const deferred = new Map<number, QuickJSDeferredPromise>();

/**
 * Set when the interpreter was unwound by the host engine itself, for example a native stack overflow or a
 * WebAssembly trap. Its memory may then be inconsistent, so it is never entered or torn down again.
 */
let crash: 'stack' | 'trap' | undefined;
class InterpreterCrash extends Error {}

// Metering. `cpuMillis` counts only time spent inside the interpreter (monotonic clock), not time waiting for
// tool calls. The wall deadline also stops a process whose host has gone away.
let usedMillis = 0;
let sliceStart: number | undefined;
let stopped: 'cpu' | 'wall' | undefined;
let wallDeadline = Number.POSITIVE_INFINITY;

function interrupt(): boolean {
  if (stopped) return true;
  const now = performance.now();
  if (now >= wallDeadline) stopped = 'wall';
  else if (sliceStart !== undefined && usedMillis + (now - sliceStart) > limits!.cpuMillis) stopped = 'cpu';
  return stopped !== undefined;
}

/** Every entry into the interpreter goes through here: it meters CPU time and contains host-level unwinding. */
function guest<T>(work: () => T): T {
  if (crash) throw new InterpreterCrash();
  if (sliceStart !== undefined) return work();
  sliceStart = performance.now();
  try { return work(); }
  catch (error) {
    // QuickJS reports program errors as results, never as host exceptions. A host exception here means the
    // interpreter itself was unwound.
    crash = error instanceof RangeError ? 'stack' : 'trap';
    throw new InterpreterCrash();
  } finally { usedMillis += performance.now() - sliceStart; sliceStart = undefined; }
}

/** Set when the interpreter asked for more WebAssembly memory than memoryBytes allows: the program hit its limit. */
let growthRefused = false;
const memoryExhausted = (): boolean => growthRefused;

function emit(value: unknown): boolean {
  try {
    const line = `${JSON.stringify(value)}\n`;
    if (process.stdout.writableLength + Buffer.byteLength(line) > MAX_OUTBOUND_BACKLOG) return false;
    process.stdout.write(line);
    return true;
  } catch { return false; }
}

function dispose(): void {
  if (crash) { context = undefined; runtime = undefined; return; }
  for (const pending of deferred.values()) { try { pending.dispose(); } catch { /* Runtime teardown follows. */ } }
  deferred.clear();
  for (const handle of [programPromise, run, describe]) { try { if (handle?.alive) handle.dispose(); } catch { /* Teardown only. */ } }
  try { context?.dispose(); } catch { /* A failed teardown still ends with process exit. */ }
  try { runtime?.dispose(); } catch { /* A failed teardown still ends with process exit. */ }
  context = undefined; runtime = undefined;
}

function finish(result: { readonly status: 'succeeded'; readonly output: unknown } | { readonly status: 'failed'; readonly reason: FailureReason; readonly programError?: unknown }): void {
  if (finished) return;
  finished = true;
  if (!emit({ v: 1, type: 'result', ...result })) process.exitCode = 1;
  if (result.status === 'failed') process.exitCode = 1;
  dispose();
}

const fail = (reason: FailureReason, programError?: unknown): void => finish({ status: 'failed', reason, ...(programError ? { programError } : {}) });

/** Reports an execution whose interpreter can no longer be entered. */
function abandon(): void {
  if (stopped === 'cpu') { fail('cpu_limit'); return; }
  if (crash === 'stack') { fail('program_error', { name: 'InternalError', message: 'stack overflow' }); return; }
  fail(memoryExhausted() ? 'memory_limit' : 'sandbox_error');
}

/** Classifies a thrown guest value. The metering flags are authoritative; the program can only choose its own error text. */
function failWith(error: QuickJSHandle | undefined): void {
  if (stopped === 'cpu') { error?.dispose(); fail('cpu_limit'); return; }
  if (stopped === 'wall') { error?.dispose(); fail('sandbox_error'); return; }
  let described: { name: string; message: string } | undefined;
  if (error && context && describe) {
    try {
      const result = guest(() => context!.callFunction(describe!, context!.undefined, error));
      if (result.error) result.error.dispose();
      else {
        if (context.typeof(result.value) === 'string') {
          const parsed: unknown = JSON.parse(context.getString(result.value));
          if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>)['name'] === 'string'
            && typeof (parsed as Record<string, unknown>)['message'] === 'string') described = parsed as { name: string; message: string };
        }
        result.value.dispose();
      }
    } catch { /* The error stays undescribed. */ }
  }
  if (crash) { abandon(); return; }
  error?.dispose();
  if (stopped === 'cpu') { fail('cpu_limit'); return; }
  // A refused memory growth is authoritative: whatever the program then threw (QuickJS may even throw null when it
  // cannot allocate the error), it failed after reaching memoryBytes.
  if (memoryExhausted()) {
    fail('memory_limit'); return;
  }
  fail('program_error', described);
}

/** Runs queued guest jobs, then settles the execution if the program finished, stalled or was stopped. */
function pump(): void {
  try { settle(); } catch { abandon(); }
}

function settle(): void {
  if (finished || !runtime || !context || !programPromise) return;
  const jobs = guest(() => runtime!.executePendingJobs());
  if (jobs.error) { failWith(jobs.error); return; }
  const state = context.getPromiseState(programPromise);
  if (state.type === 'fulfilled') {
    const value = state.value;
    try {
      if (context.typeof(value) !== 'string') { fail('invalid_output'); return; }
      // UTF-8 is never shorter than the UTF-16 length, so an oversized string is rejected before it is copied out.
      const lengthHandle = context.getProp(value, 'length');
      const length = context.getNumber(lengthHandle); lengthHandle.dispose();
      if (!(length <= limits!.maxOutputBytes)) { fail('invalid_output'); return; }
      const serialized = context.getString(value);
      if (Buffer.byteLength(serialized) > limits!.maxOutputBytes) { fail('invalid_output'); return; }
      finish({ status: 'succeeded', output: JSON.parse(serialized) as unknown });
    } catch { fail('invalid_output'); }
    finally { if (value.alive) value.dispose(); }
    return;
  }
  if (state.type === 'rejected') { failWith(state.error); return; }
  if (stopped) { failWith(undefined); return; }
  // Nothing queued and no tool call outstanding: the program's promise can never settle.
  if (deferred.size === 0 && !runtime.hasPendingJob()) fail('program_error');
}

function resolveLocally(pending: QuickJSDeferredPromise, outcome: unknown): void {
  guest(() => {
    const handle = context!.newString(JSON.stringify(outcome));
    try { pending.resolve(handle); } finally { handle.dispose(); }
  });
}

function refused(code: 'INVALID_INPUT' | 'LIMIT_EXCEEDED'): unknown {
  return code === 'INVALID_INPUT'
    ? { status: 'failed', error: { code, message: 'The tool input was rejected: it is not plain JSON within maxToolInputBytes, or it does not match the tool schema.' } }
    : { status: 'failed', error: { code, message: 'The tool call exceeded a limit, such as the program\'s maxToolCalls or maxToolConcurrency.' } };
}

/** Host function behind `tools.call`. It never throws into the guest; every call returns a promise. */
function toolCall(payload: QuickJSHandle): QuickJSHandle {
  const pending = context!.newPromise();
  try {
    if (finished) { resolveLocally(pending, refused('LIMIT_EXCEEDED')); return pending.handle; }
    if (context!.typeof(payload) !== 'string') { resolveLocally(pending, refused('INVALID_INPUT')); return pending.handle; }
    const lengthHandle = context!.getProp(payload, 'length');
    const length = context!.getNumber(lengthHandle); lengthHandle.dispose();
    if (!(length <= limits!.maxToolInputBytes + TOOL_ENVELOPE)) { resolveLocally(pending, refused('INVALID_INPUT')); return pending.handle; }
    // The host enforces the same bound; answering here keeps a runaway loop from flooding the protocol.
    if (toolCalls >= limits!.maxToolCalls) { resolveLocally(pending, refused('LIMIT_EXCEEDED')); return pending.handle; }
    const decoded: unknown = JSON.parse(context!.getString(payload));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || typeof (decoded as Record<string, unknown>)['toolId'] !== 'string') {
      resolveLocally(pending, refused('INVALID_INPUT')); return pending.handle;
    }
    toolCalls++;
    const requestId = ++nextRequestId;
    deferred.set(requestId, pending);
    const input = (decoded as Record<string, unknown>)['input'];
    if (!emit({ v: 1, type: 'tool', requestId, toolId: (decoded as Record<string, unknown>)['toolId'], input: input === undefined ? null : input })) {
      deferred.delete(requestId);
      resolveLocally(pending, refused('LIMIT_EXCEEDED'));
      setImmediate(() => fail('sandbox_error'));
    }
    return pending.handle;
  } catch {
    try { resolveLocally(pending, refused('INVALID_INPUT')); } catch { /* Interrupted: the metering flag reports it. */ }
    return pending.handle;
  }
}

async function start(message: StartMessage): Promise<void> {
  limits = message.manifest.limits;
  wallDeadline = performance.now() + limits.wallTimeMillis;
  // A worker whose host vanished stops itself at the wall deadline even while waiting for a tool result.
  setTimeout(() => { stopped ??= 'wall'; process.exit(1); }, limits.wallTimeMillis + 1_000).unref();
  if (message.manifest.language !== 'javascript' || message.manifest.approvedImports.length !== 0) { fail('unsupported_program'); return; }
  // This QuickJS build cannot measure allocation sizes (no malloc_usable_size), so its own memory limit would count
  // allocations rather than bytes: it would fail programs with many small objects and not bound large ones. It is
  // left unset. The hard bound is the WebAssembly memory itself: it cannot grow past the interpreter's base plus
  // memoryBytes, and an allocation beyond that fails inside QuickJS as "out of memory".
  const maximumPages = Math.min(MAX_WASM_PAGES, INTERPRETER_PAGES + Math.ceil(limits.memoryBytes / WASM_PAGE));
  const memory = new WebAssembly.Memory({ initial: INTERPRETER_PAGES, maximum: maximumPages });
  // Emscripten grows the heap through this method; a refusal is the authoritative sign of an exhausted limit.
  const grow = memory.grow.bind(memory);
  Object.defineProperty(memory, 'grow', { value: (delta: number): number => {
    try { return grow(delta); } catch (error) { growthRefused = true; throw error; }
  } });
  const variant = (await import('@jitl/quickjs-wasmfile-release-sync')).default as unknown as QuickJSSyncVariant;
  const quickjs = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmMemory: memory }));
  runtime = quickjs.newRuntime();
  runtime.setMaxStackSize(Math.max(64 * 1_024, Math.min(MAX_STACK_BYTES, Math.floor(limits.memoryBytes / 4))));
  runtime.setInterruptHandler(interrupt);
  context = runtime.newContext();
  const bridge = context.newFunction('__mayuraToolCall', toolCall);
  context.setProp(context.global, '__mayuraToolCall', bridge);
  bridge.dispose();
  const prelude = guest(() => context!.evalCode(PRELUDE, 'mayura-prelude.js', { type: 'global', strict: true }));
  if (prelude.error) { prelude.error.dispose(); fail(stopped === 'cpu' ? 'cpu_limit' : 'sandbox_error'); return; }
  run = context.getProp(prelude.value, 0);
  describe = context.getProp(prelude.value, 1);
  prelude.value.dispose();
  // The trailing newline keeps a final line comment in the source from swallowing the closing parenthesis.
  const compiled = guest(() => context!.evalCode(`(${message.source}\n)`, 'program.js', { type: 'global', strict: true }));
  if (compiled.error) { failWith(compiled.error); return; }
  const inputText = context.newString(JSON.stringify(message.input) ?? 'null');
  const called = guest(() => context!.callFunction(run!, context!.undefined, compiled.value, inputText));
  compiled.value.dispose(); inputText.dispose();
  if (called.error) { failWith(called.error); return; }
  programPromise = called.value;
  pump();
}

function toolResult(message: ToolResultMessage): void {
  if (finished) return;
  const pending = deferred.get(message.requestId);
  if (!pending || !context) { fail('sandbox_error'); return; }
  deferred.delete(message.requestId);
  try {
    const serialized = JSON.stringify(message.outcome);
    if (serialized === undefined || Buffer.byteLength(serialized) > MAX_INBOUND_LINE) throw new Error('invalid outcome');
    resolveLocally(pending, message.outcome);
  } catch {
    if (crash) abandon();
    else { pending.dispose(); fail('sandbox_error'); }
    return;
  }
  pump();
}

function receive(line: string): void {
  try {
    const message: unknown = JSON.parse(line);
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid message');
    const record = message as Record<string, unknown>;
    if (record['v'] !== 1) throw new Error('invalid message');
    if (record['type'] === 'start' && !started) {
      started = true;
      void start(message as StartMessage).catch(() => abandon());
    } else if (record['type'] === 'toolResult' && started && Number.isSafeInteger(record['requestId']) && Object.hasOwn(record, 'outcome')) {
      toolResult(message as ToolResultMessage);
    } else throw new Error('invalid message');
  } catch { fail('sandbox_error'); }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  inbound += chunk;
  if (inbound.length > MAX_INBOUND_LINE) { fail('sandbox_error'); process.stdin.destroy(); return; }
  for (;;) {
    const newline = inbound.indexOf('\n');
    if (newline < 0) break;
    const line = inbound.slice(0, newline); inbound = inbound.slice(newline + 1);
    receive(line);
  }
});
// The host closes stdin when it is done or gone; either way nothing can use this process any more.
process.stdin.once('end', () => { process.exit(finished ? process.exitCode ?? 0 : 1); });
