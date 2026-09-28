import { createHash } from 'node:crypto';
import {
  MayuraError,
  assertPositiveInteger,
  assertSchema,
  freezeJson,
  jsonValue,
  validate,
  type ErrorCode,
  type ExecutionEvidence,
  type ExecutionReceipt,
  type InferInput,
  type InferOutput,
  type JsonObject,
  type JsonValue,
  type Outcome,
  type Schema,
  type Scope,
} from '@mayura/core';
import { assertTool, type AnyTool } from '@mayura/tools';

export type CodeLanguage = 'javascript' | 'typescript';
export type SandboxQualification = 'test' | 'production';

export interface CodeLimits {
  readonly cpuMillis: number;
  readonly wallTimeMillis: number;
  readonly memoryBytes: number;
  readonly scratchBytes: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxToolInputBytes: number;
  readonly maxToolCalls: number;
  readonly maxToolConcurrency: number;
}

export interface CodeToolManifest {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly effects: AnyTool['effects'];
  readonly capabilities: readonly string[];
  readonly costMicros: number;
  readonly inputJsonSchema?: JsonObject;
}

export interface CodeProgramManifest {
  readonly format: 1;
  readonly id: string;
  readonly version: string;
  readonly intent: string;
  readonly language: CodeLanguage;
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  readonly approvedImports: readonly string[];
  readonly tools: readonly CodeToolManifest[];
  readonly limits: CodeLimits;
  readonly sourceBytes: number;
  readonly digest: string;
}

export interface CodeProgramOptions<I extends Schema, O extends Schema> {
  readonly id: string;
  readonly version: string;
  readonly intent: string;
  readonly language: CodeLanguage;
  readonly source: string;
  readonly input: I;
  readonly output: O;
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  readonly tools?: readonly AnyTool[];
  readonly approvedImports?: readonly string[];
  readonly limits: CodeLimits;
}

export interface CodeProgramDefinition<I extends Schema = Schema, O extends Schema = Schema> {
  readonly manifest: CodeProgramManifest;
  readonly input: Schema<InferInput<I>, InferOutput<I>>;
  readonly output: Schema<InferInput<O>, InferOutput<O>>;
}

export interface CodeToolOutcome {
  readonly status: Outcome<JsonValue>['status'];
  readonly output?: JsonValue;
  readonly error?: { readonly code: ErrorCode; readonly message: string };
}

export interface CodeToolBridge {
  call(toolId: string, input: unknown): Promise<CodeToolOutcome>;
}

export interface SandboxExecutionRequest {
  readonly executionId: string;
  readonly manifest: CodeProgramManifest;
  readonly source: string;
  readonly input: JsonValue;
  readonly signal: AbortSignal;
  readonly tools: CodeToolBridge;
}

/**
 * Why a sandbox execution failed. Code Mode maps each reason to a public error code and message:
 * `program_error` (the program threw, did not compile or can never settle) and `sandbox_error` to `TOOL_FAILED`,
 * `cpu_limit` and `memory_limit` to `LIMIT_EXCEEDED`, `invalid_output` to `INVALID_OUTPUT`, and
 * `unsupported_program` (a language or import the sandbox cannot run) to `UNSUPPORTED_PROFILE`.
 */
export type SandboxFailureReason =
  | 'program_error' | 'cpu_limit' | 'memory_limit' | 'invalid_output' | 'unsupported_program' | 'sandbox_error';

/**
 * The error a program threw, for showing to the model that wrote it. The program chooses this text, so treat it
 * like the program's output: untrusted, and possibly containing tool data. It is never copied into `error.message`.
 */
export interface CodeProgramError {
  /** The thrown error's `name`, such as `TypeError`; at most 128 characters. */
  readonly name: string;
  /** The thrown error's `message`; at most 1,024 characters. */
  readonly message: string;
}

export type SandboxExecutionResult =
  | { readonly status: 'succeeded'; readonly output: unknown }
  | { readonly status: 'failed'; readonly reason?: SandboxFailureReason; readonly programError?: CodeProgramError };

export interface SandboxAdapterOptions {
  readonly id: string;
  readonly version: string;
  /**
   * `production` when the adapter meets its documented isolation guarantees; `test` for fixtures and experiments,
   * which `createCodeMode` refuses unless the caller passes `allowTestAdapter: true`.
   */
  readonly qualification: SandboxQualification;
  readonly isAvailable: () => boolean | Promise<boolean>;
  readonly execute: (request: SandboxExecutionRequest) => Promise<SandboxExecutionResult>;
}

/** Metadata-only handle. Its registered callbacks remain private to this package instance. */
export interface SandboxAdapter {
  readonly id: string;
  readonly version: string;
  readonly qualification: SandboxQualification;
}

export interface CodeToolInvocationContext {
  readonly runId: string;
  readonly executionId: string;
  readonly callId: string;
  readonly programDigest: string;
  readonly scope: Scope;
  readonly signal: AbortSignal;
}

export interface CreateCodeModeOptions {
  readonly adapter: SandboxAdapter;
  /**
   * Accept an adapter whose qualification is `test`. Without it, `createCodeMode` throws `UNSUPPORTED_PROFILE` for
   * such an adapter. It has no effect on `production` adapters.
   */
  readonly allowTestAdapter?: boolean;
  readonly invokeTool: (
    tool: AnyTool,
    input: JsonValue,
    context: CodeToolInvocationContext,
  ) => Promise<Outcome<JsonValue>>;
}

export interface ExecuteCodeOptions {
  readonly runId: string;
  readonly executionId: string;
  readonly scope: Scope;
  readonly signal: AbortSignal;
}

/** Host-derived nested-tool accounting. Unknown cost remains reserved for reconciliation. */
export interface CodeExecutionUsage {
  readonly toolCalls: number;
  readonly unknownCalls: number;
  readonly knownCostMicros: number;
  readonly unknownCostMicros: number;
  readonly maximumCostMicros: number;
}

/**
 * The outcome plus host-derived usage. `programError` is present only when the program itself threw
 * (`failed` with `TOOL_FAILED`) and the sandbox could report what it threw.
 */
export type CodeExecutionOutcome<T> = Outcome<T> & { readonly usage: CodeExecutionUsage; readonly programError?: CodeProgramError };

export interface CodeMode {
  execute<I extends Schema, O extends Schema>(
    program: CodeProgramDefinition<I, O>,
    input: InferInput<I>,
    options: ExecuteCodeOptions,
  ): Promise<CodeExecutionOutcome<InferOutput<O>>>;
}

interface ProgramRegistration {
  readonly source: string;
  readonly tools: ReadonlyMap<string, AnyTool>;
}

interface AdapterRegistration {
  readonly isAvailable: SandboxAdapterOptions['isAvailable'];
  readonly execute: SandboxAdapterOptions['execute'];
}

const programs = new WeakMap<object, ProgramRegistration>();
const adapters = new WeakMap<object, AdapterRegistration>();
const modes = new WeakSet<object>();
const identifier = /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/;
const digest = /^[a-f0-9]{64}$/;
const MAX_SOURCE_BYTES = 1_048_576;
const MAX_TOOLS = 128;
const MAX_IMPORTS = 64;
/** Recently finished execution ids stay reserved, so a retry with a stale id fails instead of reusing call ids. */
const RECENT_EXECUTION_IDS = 100_000;
const PROGRAM_ERROR_NAME = 128;
const PROGRAM_ERROR_MESSAGE = 1_024;

/** Fixed per-code text for tool outcomes shown to the program; broker messages never reach the sandbox. */
const messages: Readonly<Record<ErrorCode, string>> = Object.freeze({
  INVALID_CONFIG: 'The tool call was not configured correctly.',
  INVALID_INPUT: 'The tool input was rejected: it is not plain JSON within maxToolInputBytes, or it does not match the tool schema.',
  INVALID_OUTPUT: 'The tool output was rejected.',
  INVALID_JSON: 'The tool data must be bounded plain JSON.',
  PERMISSION_DENIED: 'The tool call was not permitted.',
  BUDGET_EXCEEDED: 'The tool call did not fit the remaining budget.',
  LIMIT_EXCEEDED: 'The tool call exceeded a limit, such as the program\'s maxToolCalls or maxToolConcurrency.',
  CANCELLED: 'The tool call was cancelled.',
  TIMEOUT: 'The tool call ran out of time.',
  TOOL_FAILED: 'The tool call failed.',
  MODEL_FAILED: 'A model call failed.',
  GUARD_BLOCKED: 'A guard blocked the tool call.',
  GUARD_UNAVAILABLE: 'A required guard could not decide on the tool call.',
  OUTCOME_UNKNOWN: 'The tool call may or may not have taken effect.',
  UNSUPPORTED_PROFILE: 'The tool call is not supported here.',
  NOT_FOUND: 'The tool call referred to something that does not exist.',
  CONFLICT: 'The execution has finished; it accepts no more tool calls.',
  STORAGE_UNAVAILABLE: 'Storage needed by the tool call is unavailable.',
  INTEGRITY_VIOLATION: 'The tool call failed an integrity check.',
});

const failureReasons: ReadonlySet<string> = new Set<SandboxFailureReason>(['program_error', 'cpu_limit', 'memory_limit',
  'invalid_output', 'unsupported_program', 'sandbox_error']);
const reasonFailures: Readonly<Record<SandboxFailureReason, readonly [ErrorCode, string]>> = Object.freeze({
  program_error: ['TOOL_FAILED', 'The program threw an error, did not compile, or returned a promise that can never settle. programError holds what it threw, when the sandbox could report it.'],
  cpu_limit: ['LIMIT_EXCEEDED', 'The program ran longer than its cpuMillis limit.'],
  memory_limit: ['LIMIT_EXCEEDED', 'The program needed more memory than its memoryBytes limit.'],
  invalid_output: ['INVALID_OUTPUT', 'The program\'s result is not plain JSON within maxOutputBytes.'],
  unsupported_program: ['UNSUPPORTED_PROFILE', 'This sandbox cannot run the program\'s language or approved imports.'],
  sandbox_error: ['TOOL_FAILED', 'The sandbox failed before the program finished; its details are withheld.'],
});

function text(value: unknown, name: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new MayuraError('INVALID_CONFIG', `${name} must be a nonempty string of at most ${maxLength} characters.`);
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Object.getOwnPropertySymbols(value).length === 0;
}

function exactData(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!plainRecord(value)) throw new MayuraError('INVALID_CONFIG', 'Code Mode options must be a plain object.');
  const fields = Object.getOwnPropertyDescriptors(value);
  const unknown = Reflect.ownKeys(fields).find(key => typeof key !== 'string' || ![...required, ...optional].includes(key));
  if (unknown !== undefined) {
    throw new MayuraError('INVALID_CONFIG', typeof unknown === 'string' && unknown.length <= 64 ? `Unknown Code Mode option "${unknown}".` : 'Code Mode options contain an unknown key.');
  }
  const missing = required.find(key => !fields[key]);
  if (missing !== undefined) throw new MayuraError('INVALID_CONFIG', `The Code Mode option "${missing}" is required.`);
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(fields)) {
    if (!descriptor.enumerable || !('value' in descriptor)) throw new MayuraError('INVALID_CONFIG', `The Code Mode option "${key}" must be a plain data property.`);
    if (descriptor.value !== undefined || required.includes(key)) snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotSchema<S extends Schema>(schema: S): Schema<InferInput<S>, InferOutput<S>> {
  assertSchema(schema);
  const standard = schema['~standard'];
  return Object.freeze({
    '~standard': Object.freeze({ version: 1 as const, vendor: standard.vendor, validate: standard.validate.bind(standard) }),
  }) as Schema<InferInput<S>, InferOutput<S>>;
}

function limits(value: unknown): CodeLimits {
  const data = exactData(value, ['cpuMillis', 'wallTimeMillis', 'memoryBytes', 'scratchBytes', 'maxInputBytes',
    'maxOutputBytes', 'maxToolInputBytes', 'maxToolCalls', 'maxToolConcurrency']);
  for (const [name, item] of Object.entries(data)) assertPositiveInteger(item as number, `limits.${name}`);
  if ((data['maxToolConcurrency'] as number) > (data['maxToolCalls'] as number)) {
    throw new MayuraError('INVALID_CONFIG', 'limits.maxToolConcurrency cannot be greater than limits.maxToolCalls.');
  }
  const ceilings: Readonly<Record<keyof CodeLimits, number>> = Object.freeze({
    cpuMillis: 3_600_000,
    wallTimeMillis: 3_600_000,
    memoryBytes: 2_147_483_648,
    scratchBytes: 2_147_483_648,
    maxInputBytes: 16_777_216,
    maxOutputBytes: 16_777_216,
    maxToolInputBytes: 16_777_216,
    maxToolCalls: 10_000,
    maxToolConcurrency: 128,
  });
  for (const [name, ceiling] of Object.entries(ceilings) as [keyof CodeLimits, number][]) {
    if ((data[name] as number) > ceiling) throw new MayuraError('INVALID_CONFIG', `limits.${name} exceeds the supported maximum of ${ceiling}.`);
  }
  return Object.freeze({
    cpuMillis: data['cpuMillis'] as number,
    wallTimeMillis: data['wallTimeMillis'] as number,
    memoryBytes: data['memoryBytes'] as number,
    scratchBytes: data['scratchBytes'] as number,
    maxInputBytes: data['maxInputBytes'] as number,
    maxOutputBytes: data['maxOutputBytes'] as number,
    maxToolInputBytes: data['maxToolInputBytes'] as number,
    maxToolCalls: data['maxToolCalls'] as number,
    maxToolConcurrency: data['maxToolConcurrency'] as number,
  });
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function freezeTool(tool: AnyTool): CodeToolManifest {
  const inputJsonSchema = tool.inputJsonSchema === undefined ? undefined : freezeJson(jsonValue(tool.inputJsonSchema)) as JsonObject;
  return Object.freeze({
    id: tool.id,
    version: tool.version,
    description: tool.description,
    effects: tool.effects,
    capabilities: Object.freeze([...tool.capabilities]),
    costMicros: tool.costMicros,
    ...(inputJsonSchema === undefined ? {} : { inputJsonSchema }),
  });
}

/** Creates an immutable, content-addressed program definition without compiling or executing source. */
export function defineCodeProgram<I extends Schema, O extends Schema>(options: CodeProgramOptions<I, O>): CodeProgramDefinition<I, O> {
  const data = exactData(options, ['id', 'version', 'intent', 'language', 'source', 'input', 'output', 'inputSchemaId',
    'outputSchemaId', 'limits'], ['tools', 'approvedImports']);
  if (!identifier.test(String(data['id']))) throw new MayuraError('INVALID_CONFIG', 'Program id must start with a letter and contain at most 128 letters, digits, ".", "_", "/" or "-".');
  text(data['version'], 'version', 128);
  text(data['intent'], 'intent', 4_096);
  text(data['inputSchemaId'], 'inputSchemaId', 256);
  text(data['outputSchemaId'], 'outputSchemaId', 256);
  if (data['language'] !== 'javascript' && data['language'] !== 'typescript') throw new MayuraError('INVALID_CONFIG', 'Program language must be "javascript" or "typescript".');
  if (typeof data['source'] !== 'string' || data['source'].trim().length === 0) throw new MayuraError('INVALID_CONFIG', 'Program source must be a nonempty string.');
  const sourceBytes = Buffer.byteLength(data['source'], 'utf8');
  if (sourceBytes > MAX_SOURCE_BYTES) throw new MayuraError('LIMIT_EXCEEDED', 'Program source is larger than 1 MiB.');
  const input = snapshotSchema(data['input'] as I);
  const output = snapshotSchema(data['output'] as O);
  const codeLimits = limits(data['limits']);
  const suppliedTools = data['tools'] ?? [];
  if (!Array.isArray(suppliedTools) || suppliedTools.length > MAX_TOOLS) throw new MayuraError('INVALID_CONFIG', 'Program tools must be an array of at most 128 tools.');
  const toolMap = new Map<string, AnyTool>();
  const toolManifest = suppliedTools.map(item => {
    assertTool(item as AnyTool);
    const tool = item as AnyTool;
    if (toolMap.has(tool.id)) throw new MayuraError('CONFLICT', `Program tools contain "${tool.id}" twice; tool ids must be unique.`);
    toolMap.set(tool.id, tool);
    return freezeTool(tool);
  });
  const maximumToolCost = toolManifest.reduce((maximum, tool) => Math.max(maximum, tool.costMicros), 0);
  if (!Number.isSafeInteger(maximumToolCost * codeLimits.maxToolCalls)) {
    throw new MayuraError('LIMIT_EXCEEDED', 'The program\'s maximum tool cost (the highest tool costMicros times limits.maxToolCalls) is larger than Number.MAX_SAFE_INTEGER.');
  }
  const suppliedImports = data['approvedImports'] ?? [];
  if (!Array.isArray(suppliedImports) || suppliedImports.length > MAX_IMPORTS) throw new MayuraError('INVALID_CONFIG', 'approvedImports must be an array of at most 64 specifiers.');
  const approvedImports = suppliedImports.map(item => {
    text(item, 'approved import', 256);
    if (item.includes(':') || item.includes('\\') || item.startsWith('/')) throw new MayuraError('INVALID_CONFIG', 'approvedImports entries must be bare package specifiers, without ":", "\\" or a leading "/".');
    return item;
  });
  if (new Set(approvedImports).size !== approvedImports.length) throw new MayuraError('CONFLICT', 'approvedImports entries must be unique.');
  const unsigned = freezeJson(jsonValue({
    format: 1,
    id: data['id'],
    version: data['version'],
    intent: data['intent'],
    language: data['language'],
    inputSchemaId: data['inputSchemaId'],
    outputSchemaId: data['outputSchemaId'],
    approvedImports,
    tools: toolManifest,
    limits: codeLimits,
    sourceBytes,
  })) as JsonObject;
  const programDigest = sha256(`${canonical(unsigned)}\n${data['source']}`);
  const manifest = Object.freeze({ ...unsigned, digest: programDigest }) as unknown as CodeProgramManifest;
  const definition = Object.freeze({ manifest, input, output });
  programs.set(definition, Object.freeze({ source: data['source'], tools: toolMap }));
  return definition;
}

/** Rejects forged or foreign-instance program metadata before durable composition. */
export function assertCodeProgram(program: CodeProgramDefinition): void {
  if (!programs.has(program)) throw new MayuraError('INVALID_CONFIG', 'The program was not created by defineCodeProgram from this package instance.');
}

/** Registers trusted adapter callbacks behind an immutable metadata-only handle. */
export function defineSandboxAdapter(options: SandboxAdapterOptions): SandboxAdapter {
  const data = exactData(options, ['id', 'version', 'qualification', 'isAvailable', 'execute']);
  if (!identifier.test(String(data['id']))) throw new MayuraError('INVALID_CONFIG', 'Sandbox adapter id must start with a letter and contain at most 128 letters, digits, ".", "_", "/" or "-".');
  text(data['version'], 'version', 128);
  if (data['qualification'] !== 'test' && data['qualification'] !== 'production') throw new MayuraError('INVALID_CONFIG', 'Sandbox adapter qualification must be "production" or "test".');
  if (typeof data['isAvailable'] !== 'function' || typeof data['execute'] !== 'function') throw new MayuraError('INVALID_CONFIG', 'Sandbox adapter isAvailable and execute must be functions.');
  const adapter = Object.freeze({ id: data['id'], version: data['version'], qualification: data['qualification'] }) as SandboxAdapter;
  adapters.set(adapter, Object.freeze({
    isAvailable: data['isAvailable'] as SandboxAdapterOptions['isAvailable'],
    execute: data['execute'] as SandboxAdapterOptions['execute'],
  }));
  return adapter;
}

function statusOf(code: ErrorCode): Exclude<Outcome<never>['status'], 'succeeded'> {
  return code === 'CANCELLED' ? 'cancelled' : code === 'OUTCOME_UNKNOWN' ? 'outcome_unknown'
    : ['PERMISSION_DENIED', 'BUDGET_EXCEEDED', 'GUARD_BLOCKED', 'GUARD_UNAVAILABLE'].includes(code) ? 'blocked' : 'failed';
}

/** Host-authored outcome errors: each message names the limit or rule involved and never carries program or tool data. */
function failure(code: ErrorCode, message: string): Exclude<Outcome<never>, { status: 'succeeded' }> {
  return Object.freeze({ status: statusOf(code), error: Object.freeze({ code, message }) });
}

const zeroUsage = Object.freeze<CodeExecutionUsage>({ toolCalls: 0, unknownCalls: 0, knownCostMicros: 0, unknownCostMicros: 0, maximumCostMicros: 0 });

function codeOutcome<T>(outcome: Outcome<T>, usage: CodeExecutionUsage = zeroUsage, programError?: CodeProgramError): CodeExecutionOutcome<T> {
  return Object.freeze({ ...outcome, usage: Object.freeze({ ...usage }), ...(programError ? { programError } : {}) }) as CodeExecutionOutcome<T>;
}

function bridgeFailure(code: ErrorCode): CodeToolOutcome {
  return Object.freeze({ status: statusOf(code), error: Object.freeze({ code, message: messages[code] }) });
}

const abortMessages: Readonly<Record<'CANCELLED' | 'TIMEOUT', string>> = Object.freeze({
  CANCELLED: 'The execution was cancelled by its signal.',
  TIMEOUT: 'The execution ran longer than the program\'s wallTimeMillis limit.',
});
const UNKNOWN_MESSAGE = 'A tool call may or may not have taken effect, so the program\'s result was discarded. Reconcile the effect (see evidence) before retrying.';

function errorCode(value: unknown): ErrorCode {
  return typeof value === 'string' && Object.hasOwn(messages, value) ? value as ErrorCode : 'TOOL_FAILED';
}

function snapshotReceipt(value: unknown, callId: string, toolId: string): ExecutionReceipt | undefined {
  if (value === undefined) return undefined;
  try {
    const receipt = jsonValue(value, { maxBytes: 4_096 });
    if (!plainRecord(receipt) || Object.keys(receipt).length !== 4 || receipt['callId'] !== callId || receipt['toolId'] !== toolId
      || !['not_started', 'succeeded', 'failed', 'unknown'].includes(String(receipt['execution']))
      || !['released', 'withheld'].includes(String(receipt['disclosure']))) return undefined;
    return Object.freeze(receipt) as unknown as ExecutionReceipt;
  } catch { return undefined; }
}

function snapshotToolOutcome(value: unknown, maxBytes: number, callId: string, toolId: string): {
  readonly exposed: CodeToolOutcome;
  readonly receipt?: ExecutionReceipt;
} {
  try {
    if (!plainRecord(value)) throw new Error();
    const status = value['status'];
    const receipt = snapshotReceipt(value['receipt'], callId, toolId);
    if (status === 'succeeded') {
      const output = freezeJson(jsonValue(value['output'], { maxBytes }));
      return Object.freeze({ exposed: Object.freeze({ status, output }), ...(receipt ? { receipt } : {}) });
    }
    if (!['failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(String(status)) || !plainRecord(value['error'])) throw new Error();
    const code = errorCode(value['error']['code']);
    const failedStatus = status as 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
    return Object.freeze({ exposed: Object.freeze({ status: failedStatus, error: Object.freeze({ code, message: messages[code] }) }), ...(receipt ? { receipt } : {}) });
  } catch { return Object.freeze({ exposed: bridgeFailure('TOOL_FAILED') }); }
}

function snapshotExecutionOptions(value: ExecuteCodeOptions): ExecuteCodeOptions {
  const data = exactData(value, ['runId', 'executionId', 'scope', 'signal']);
  text(data['runId'], 'runId', 256);
  text(data['executionId'], 'executionId', 256);
  if (!(data['signal'] instanceof AbortSignal)) throw new MayuraError('INVALID_CONFIG', 'execute options need signal to be an AbortSignal.');
  const scope = freezeJson(jsonValue(data['scope'], { maxBytes: 2_048 }));
  if (!plainRecord(scope) || Object.keys(scope).length !== 2 || !Object.hasOwn(scope, 'principalId') || !Object.hasOwn(scope, 'projectId')) {
    throw new MayuraError('INVALID_CONFIG', 'execute options need scope to be exactly { principalId, projectId }.');
  }
  text(scope['principalId'], 'scope.principalId', 256);
  text(scope['projectId'], 'scope.projectId', 256);
  return Object.freeze({ runId: data['runId'], executionId: data['executionId'], scope: scope as unknown as Scope, signal: data['signal'] as AbortSignal });
}

type AdmittedResult =
  | { readonly status: 'succeeded'; readonly output: JsonValue }
  | { readonly status: 'failed'; readonly reason?: SandboxFailureReason; readonly programError?: CodeProgramError };

const sandboxError: AdmittedResult = Object.freeze({ status: 'failed', reason: 'sandbox_error' });

function snapshotProgramError(value: unknown): CodeProgramError | undefined {
  if (!plainRecord(value)) return undefined;
  const fields = Object.getOwnPropertyDescriptors(value);
  const name = fields['name']; const message = fields['message'];
  if (Reflect.ownKeys(fields).length !== 2 || !name || !message || !('value' in name) || !('value' in message)
    || typeof name.value !== 'string' || typeof message.value !== 'string') return undefined;
  return Object.freeze({ name: name.value.slice(0, PROGRAM_ERROR_NAME), message: message.value.slice(0, PROGRAM_ERROR_MESSAGE) });
}

/** Admits only exact plain result data; accessors, extra fields and unknown reasons are sandbox failures. */
function snapshotSandboxResult(value: unknown, maxOutputBytes: number): AdmittedResult {
  try {
    if (!plainRecord(value)) return sandboxError;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.values(fields).some(field => !field.enumerable || !('value' in field))) return sandboxError;
    const keys = Reflect.ownKeys(fields) as string[];
    if (fields['status']?.value === 'failed') {
      if (keys.some(key => !['status', 'reason', 'programError'].includes(key))) return sandboxError;
      const reason: unknown = fields['reason']?.value;
      if (reason === undefined) return Object.freeze({ status: 'failed' });
      if (typeof reason !== 'string' || !failureReasons.has(reason)) return sandboxError;
      const programError = reason === 'program_error' ? snapshotProgramError(fields['programError']?.value) : undefined;
      return Object.freeze({ status: 'failed', reason: reason as SandboxFailureReason, ...(programError ? { programError } : {}) });
    }
    if (fields['status']?.value !== 'succeeded' || keys.length !== 2 || !fields['output']) return sandboxError;
    try { return Object.freeze({ status: 'succeeded', output: freezeJson(jsonValue(fields['output'].value, { maxBytes: maxOutputBytes })) }); }
    catch { return Object.freeze({ status: 'failed', reason: 'invalid_output' }); }
  } catch { return sandboxError; }
}

/** Creates an ephemeral Code Mode executor. It never evaluates source outside the supplied adapter. */
export function createCodeMode(options: CreateCodeModeOptions): CodeMode {
  const data = exactData(options, ['adapter', 'invokeTool'], ['allowTestAdapter']);
  const adapter = data['adapter'] as SandboxAdapter;
  const registration = adapters.get(adapter);
  if (!registration) throw new MayuraError('INVALID_CONFIG', 'The sandbox adapter was not created by defineSandboxAdapter from this package instance.');
  if (typeof data['invokeTool'] !== 'function') throw new MayuraError('INVALID_CONFIG', 'invokeTool must be a function that brokers each tool call.');
  if (data['allowTestAdapter'] !== undefined && typeof data['allowTestAdapter'] !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'allowTestAdapter must be a boolean.');
  if (adapter.qualification !== 'production' && data['allowTestAdapter'] !== true) {
    throw new MayuraError('UNSUPPORTED_PROFILE', `Sandbox adapter "${adapter.id}" is qualified for tests only. Use a production adapter, or pass allowTestAdapter: true to accept its isolation.`);
  }
  const invoke = data['invokeTool'] as CreateCodeModeOptions['invokeTool'];
  const active = new Set<string>();
  const recent = new Set<string>();
  const release = (id: string): void => {
    active.delete(id);
    recent.add(id);
    // Set iteration is insertion order, so this evicts the oldest finished id.
    if (recent.size > RECENT_EXECUTION_IDS) recent.delete(recent.values().next().value!);
  };

  const mode = Object.freeze({
    async execute<I extends Schema, O extends Schema>(program: CodeProgramDefinition<I, O>, rawInput: InferInput<I>, rawOptions: ExecuteCodeOptions): Promise<CodeExecutionOutcome<InferOutput<O>>> {
      type Result = CodeExecutionOutcome<InferOutput<O>>;
      const registered = programs.get(program);
      if (!registered) return codeOutcome(failure('INVALID_CONFIG', 'The program was not created by defineCodeProgram from this package instance.')) as Result;
      const maximumToolCost = program.manifest.tools.reduce((maximum, tool) => Math.max(maximum, tool.costMicros), 0);
      const maximumCostMicros = maximumToolCost * program.manifest.limits.maxToolCalls;
      const early = (code: ErrorCode, message: string): Result => codeOutcome(failure(code, message), { ...zeroUsage, maximumCostMicros }) as Result;
      let execution: ExecuteCodeOptions;
      try { execution = snapshotExecutionOptions(rawOptions); }
      catch (error) { return early('INVALID_CONFIG', error instanceof MayuraError ? error.message : 'The execute options are invalid.'); }
      if (active.has(execution.executionId) || recent.has(execution.executionId)) {
        return early('CONFLICT', 'This executionId is running or was used recently by this executor. Pass a new executionId for each execution.');
      }
      active.add(execution.executionId);
      try {
        return await run(program, registered, rawInput, execution, maximumCostMicros) as Result;
      } finally { release(execution.executionId); }
    },
  });

  async function run<I extends Schema, O extends Schema>(program: CodeProgramDefinition<I, O>, registered: ProgramRegistration, rawInput: InferInput<I>,
    execution: ExecuteCodeOptions, maximumCostMicros: number): Promise<CodeExecutionOutcome<InferOutput<O>>> {
    type Result = CodeExecutionOutcome<InferOutput<O>>;
    const limits = program.manifest.limits;
    const early = (code: ErrorCode, message: string): Result => codeOutcome(failure(code, message), { ...zeroUsage, maximumCostMicros }) as Result;
    let inputSnapshot: JsonValue;
    try { inputSnapshot = freezeJson(jsonValue(rawInput, { maxBytes: limits.maxInputBytes })); }
    catch { return early('INVALID_INPUT', 'The input is not plain JSON within the program\'s maxInputBytes limit.'); }
    let available = false;
    try { available = await registration!.isAvailable() === true; }
    catch { /* Availability errors reveal no adapter details. */ }
    if (!available) {
      return early('UNSUPPORTED_PROFILE', `Sandbox adapter "${adapter.id}" is not available on this host, for example because its runtime or image is missing. Code Mode never runs a program outside its sandbox.`);
    }

    const controller = new AbortController();
    let abortCode: 'CANCELLED' | 'TIMEOUT' = 'CANCELLED';
    const relay = (): void => { if (!controller.signal.aborted) { abortCode = 'CANCELLED'; controller.abort(); } };
    execution.signal.addEventListener('abort', relay, { once: true });
    if (execution.signal.aborted) relay();
    const timer = setTimeout(() => { if (!controller.signal.aborted) { abortCode = 'TIMEOUT'; controller.abort(); } }, limits.wallTimeMillis);
    const evidence: ExecutionEvidence[] = [];
    const pending = new Set<Promise<CodeToolOutcome>>();
    let startedCalls = 0;
    let activeCalls = 0;
    let accountedCalls = 0;
    let unknownCalls = 0;
    let knownCostMicros = 0;
    let unknownCostMicros = 0;
    const usage = (): CodeExecutionUsage => Object.freeze({ toolCalls: accountedCalls, unknownCalls, knownCostMicros, unknownCostMicros, maximumCostMicros });
    const withEvidence = <T extends object>(outcome: T): T => Object.freeze({ ...outcome, ...(evidence.length ? { evidence: Object.freeze([...evidence]) } : {}) });
    const account = (tool: AnyTool, receipt?: ExecutionReceipt): void => {
      accountedCalls++;
      if (!receipt || receipt.execution === 'unknown') { unknownCalls++; unknownCostMicros += tool.costMicros; }
      else if (receipt.execution !== 'not_started') knownCostMicros += tool.costMicros;
      if (!Number.isSafeInteger(knownCostMicros) || !Number.isSafeInteger(unknownCostMicros)
        || knownCostMicros + unknownCostMicros > maximumCostMicros) {
        throw new MayuraError('LIMIT_EXCEEDED', 'Nested-tool usage exceeded the admitted accounting bound.');
      }
    };
    let bridgeOpen = true;
    let bridgeCloseCode: 'CONFLICT' | 'CANCELLED' | 'TIMEOUT' = 'CONFLICT';
    const bridge: CodeToolBridge = Object.freeze({
      call(toolId: string, untrustedInput: unknown): Promise<CodeToolOutcome> {
        const operation = (async (): Promise<CodeToolOutcome> => {
          if (!bridgeOpen) return bridgeFailure(bridgeCloseCode);
          if (controller.signal.aborted) return bridgeFailure(abortCode);
          if (typeof toolId !== 'string' || !registered.tools.has(toolId)) return bridgeFailure('PERMISSION_DENIED');
          if (startedCalls >= limits.maxToolCalls || activeCalls >= limits.maxToolConcurrency) return bridgeFailure('LIMIT_EXCEEDED');
          const sequence = ++startedCalls;
          activeCalls++;
          try {
            let input: JsonValue;
            try { input = freezeJson(jsonValue(untrustedInput, { maxBytes: limits.maxToolInputBytes })); }
            catch { return bridgeFailure('INVALID_INPUT'); }
            if (controller.signal.aborted) return bridgeFailure(abortCode);
            const tool = registered.tools.get(toolId)!;
            const callId = `${execution.executionId}:code:${sequence}`;
            let outcome: Outcome<JsonValue>;
            try {
              outcome = await invoke(tool, input, Object.freeze({ runId: execution.runId, executionId: execution.executionId,
                callId, programDigest: program.manifest.digest, scope: execution.scope, signal: controller.signal }));
            } catch { account(tool); return bridgeFailure('TOOL_FAILED'); }
            const snapshot = snapshotToolOutcome(outcome, limits.maxOutputBytes, callId, toolId);
            account(tool, snapshot.receipt);
            if (snapshot.receipt) evidence.push(Object.freeze({ runId: execution.runId, receipt: snapshot.receipt }));
            return snapshot.exposed;
          } finally { activeCalls--; }
        })();
        pending.add(operation);
        void operation.finally(() => pending.delete(operation));
        return operation;
      },
    });

    try {
      let input: JsonValue;
      try {
        input = freezeJson(jsonValue(await validate(program.input, inputSnapshot, 'input', { maxBytes: limits.maxInputBytes }),
          { maxBytes: limits.maxInputBytes }));
      } catch { return codeOutcome(failure('INVALID_INPUT', 'The input does not match the program\'s input schema.'), usage()) as Result; }
      if (controller.signal.aborted) return codeOutcome(failure(abortCode, abortMessages[abortCode]), usage()) as Result;
      const request = Object.freeze({ executionId: execution.executionId, manifest: program.manifest, source: registered.source,
        input, signal: controller.signal, tools: bridge });
      let sandboxResult: AdmittedResult = sandboxError;
      const adapterWork = Promise.resolve().then(() => registration!.execute(request));
      void adapterWork.catch(() => undefined);
      await Promise.race([
        adapterWork.then(result => { sandboxResult = snapshotSandboxResult(result, limits.maxOutputBytes); }, () => undefined),
        new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true })),
      ]);
      bridgeCloseCode = controller.signal.aborted ? abortCode : 'CONFLICT';
      bridgeOpen = false;
      // Admitted broker calls always settle before the outcome, so usage and evidence are complete.
      await Promise.allSettled([...pending]);
      if (unknownCalls > 0) return codeOutcome(withEvidence(failure('OUTCOME_UNKNOWN', UNKNOWN_MESSAGE)), usage()) as Result;
      if (controller.signal.aborted) return codeOutcome(withEvidence(failure(abortCode, abortMessages[abortCode])), usage()) as Result;
      const admitted = sandboxResult as AdmittedResult;
      if (admitted.status === 'failed') {
        const [code, message] = admitted.reason ? reasonFailures[admitted.reason]
          : ['TOOL_FAILED', 'The program or its sandbox failed; the adapter did not report why.'] as const;
        return codeOutcome(withEvidence(failure(code, message)), usage(), admitted.programError) as Result;
      }
      try {
        const output = freezeJson(jsonValue(await validate(program.output, admitted.output, 'output', { maxBytes: limits.maxOutputBytes }),
          { maxBytes: limits.maxOutputBytes })) as InferOutput<O>;
        return codeOutcome(withEvidence({ status: 'succeeded' as const, output }), usage());
      } catch {
        return codeOutcome(withEvidence(failure('INVALID_OUTPUT', 'The program\'s result does not match its output schema.')), usage()) as Result;
      }
    } finally {
      if (controller.signal.aborted) bridgeCloseCode = abortCode;
      bridgeOpen = false;
      clearTimeout(timer);
      execution.signal.removeEventListener('abort', relay);
      if (!controller.signal.aborted) controller.abort();
    }
  }

  modes.add(mode);
  return mode;
}

/** Rejects forged executors before they are captured by a durable phase tool. */
export function assertCodeMode(mode: CodeMode): void {
  if (!modes.has(mode)) throw new MayuraError('INVALID_CONFIG', 'The Code Mode executor was not created by createCodeMode from this package instance.');
}

/** Runtime assertion for callers that persist or compare program digests. */
export function isCodeProgramDigest(value: string): boolean {
  return digest.test(value);
}
