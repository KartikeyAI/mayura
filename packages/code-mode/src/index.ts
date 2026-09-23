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

export type SandboxExecutionResult =
  | { readonly status: 'succeeded'; readonly output: unknown }
  | { readonly status: 'failed' };

export interface SandboxAdapterOptions {
  readonly id: string;
  readonly version: string;
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
  /** Explicit test-only escape hatch; production callers fail closed for unqualified adapters. */
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

export interface CodeMode {
  execute<I extends Schema, O extends Schema>(
    program: CodeProgramDefinition<I, O>,
    input: InferInput<I>,
    options: ExecuteCodeOptions,
  ): Promise<Outcome<InferOutput<O>>>;
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
const identifier = /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/;
const digest = /^[a-f0-9]{64}$/;
const MAX_SOURCE_BYTES = 1_048_576;
const MAX_TOOLS = 128;
const MAX_IMPORTS = 64;
const MAX_EXECUTIONS_PER_RUNTIME = 100_000;

const messages: Readonly<Record<ErrorCode, string>> = Object.freeze({
  INVALID_CONFIG: 'Code Mode configuration is invalid.',
  INVALID_INPUT: 'Code Mode input did not pass its admission boundary.',
  INVALID_OUTPUT: 'Code Mode output did not pass its disclosure boundary.',
  INVALID_JSON: 'Code Mode data must be bounded plain JSON.',
  PERMISSION_DENIED: 'The Code Mode operation was not authorized.',
  BUDGET_EXCEEDED: 'The execution budget could not admit this Code Mode operation.',
  LIMIT_EXCEEDED: 'A Code Mode execution limit was reached.',
  CANCELLED: 'Code Mode execution was cancelled.',
  TIMEOUT: 'Code Mode execution exceeded its deadline.',
  TOOL_FAILED: 'Code Mode execution failed; raw adapter details are withheld.',
  MODEL_FAILED: 'A model operation failed.',
  GUARD_BLOCKED: 'A required guard withheld this Code Mode operation.',
  GUARD_UNAVAILABLE: 'A required guard could not establish a verdict.',
  OUTCOME_UNKNOWN: 'An external operation may have occurred and requires reconciliation.',
  UNSUPPORTED_PROFILE: 'A qualified Code Mode sandbox is unavailable.',
  NOT_FOUND: 'The requested Code Mode resource was not found.',
  CONFLICT: 'The Code Mode execution identity is no longer available.',
  STORAGE_UNAVAILABLE: 'Required Code Mode storage is unavailable.',
});

function text(value: unknown, name: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new MayuraError('INVALID_CONFIG', `${name} must be a bounded nonempty string.`);
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Object.getOwnPropertySymbols(value).length === 0;
}

function exactData(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!plainRecord(value)) throw new MayuraError('INVALID_CONFIG', 'Code Mode configuration must be plain data.');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
    || required.some(key => !fields[key])) throw new MayuraError('INVALID_CONFIG', 'Code Mode configuration fields are invalid.');
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(fields)) {
    if (!descriptor.enumerable || !('value' in descriptor)) throw new MayuraError('INVALID_CONFIG', 'Code Mode configuration fields must be data properties.');
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
  if ((data['wallTimeMillis'] as number) > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'wallTimeMillis exceeds the host timer range.');
  if ((data['maxToolConcurrency'] as number) > (data['maxToolCalls'] as number)) {
    throw new MayuraError('INVALID_CONFIG', 'maxToolConcurrency cannot exceed maxToolCalls.');
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
    if ((data[name] as number) > ceiling) throw new MayuraError('INVALID_CONFIG', `limits.${name} exceeds the supported maximum.`);
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
  if (!identifier.test(String(data['id']))) throw new MayuraError('INVALID_CONFIG', 'Program id must be a bounded identifier.');
  text(data['version'], 'version', 128);
  text(data['intent'], 'intent', 4_096);
  text(data['inputSchemaId'], 'inputSchemaId', 256);
  text(data['outputSchemaId'], 'outputSchemaId', 256);
  if (data['language'] !== 'javascript' && data['language'] !== 'typescript') throw new MayuraError('INVALID_CONFIG', 'Program language is unsupported.');
  if (typeof data['source'] !== 'string' || data['source'].trim().length === 0) throw new MayuraError('INVALID_CONFIG', 'Program source must be nonempty text.');
  const sourceBytes = Buffer.byteLength(data['source'], 'utf8');
  if (sourceBytes > MAX_SOURCE_BYTES) throw new MayuraError('LIMIT_EXCEEDED', 'Program source exceeds the definition limit.');
  const input = snapshotSchema(data['input'] as I);
  const output = snapshotSchema(data['output'] as O);
  const codeLimits = limits(data['limits']);
  const suppliedTools = data['tools'] ?? [];
  if (!Array.isArray(suppliedTools) || suppliedTools.length > MAX_TOOLS) throw new MayuraError('INVALID_CONFIG', 'Program tools must be a bounded array.');
  const toolMap = new Map<string, AnyTool>();
  const toolManifest = suppliedTools.map(item => {
    assertTool(item as AnyTool);
    const tool = item as AnyTool;
    if (toolMap.has(tool.id)) throw new MayuraError('CONFLICT', 'Program tool ids must be unique.');
    toolMap.set(tool.id, tool);
    return freezeTool(tool);
  });
  const suppliedImports = data['approvedImports'] ?? [];
  if (!Array.isArray(suppliedImports) || suppliedImports.length > MAX_IMPORTS) throw new MayuraError('INVALID_CONFIG', 'Approved imports must be a bounded array.');
  const approvedImports = suppliedImports.map(item => {
    text(item, 'approved import', 256);
    if (item.includes(':') || item.includes('\\') || item.startsWith('/')) throw new MayuraError('INVALID_CONFIG', 'Approved import specifier is invalid.');
    return item;
  });
  if (new Set(approvedImports).size !== approvedImports.length) throw new MayuraError('CONFLICT', 'Approved imports must be unique.');
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

/** Registers trusted adapter callbacks behind an immutable metadata-only handle. */
export function defineSandboxAdapter(options: SandboxAdapterOptions): SandboxAdapter {
  const data = exactData(options, ['id', 'version', 'qualification', 'isAvailable', 'execute']);
  if (!identifier.test(String(data['id']))) throw new MayuraError('INVALID_CONFIG', 'Sandbox adapter id must be a bounded identifier.');
  text(data['version'], 'version', 128);
  if (data['qualification'] !== 'test' && data['qualification'] !== 'production') throw new MayuraError('INVALID_CONFIG', 'Sandbox qualification is invalid.');
  if (typeof data['isAvailable'] !== 'function' || typeof data['execute'] !== 'function') throw new MayuraError('INVALID_CONFIG', 'Sandbox adapter callbacks are required.');
  const adapter = Object.freeze({ id: data['id'], version: data['version'], qualification: data['qualification'] }) as SandboxAdapter;
  adapters.set(adapter, Object.freeze({
    isAvailable: data['isAvailable'] as SandboxAdapterOptions['isAvailable'],
    execute: data['execute'] as SandboxAdapterOptions['execute'],
  }));
  return adapter;
}

function failure(code: ErrorCode): Exclude<Outcome<never>, { status: 'succeeded' }> {
  const status = code === 'CANCELLED' ? 'cancelled' : code === 'OUTCOME_UNKNOWN' ? 'outcome_unknown'
    : ['PERMISSION_DENIED', 'BUDGET_EXCEEDED', 'GUARD_BLOCKED', 'GUARD_UNAVAILABLE'].includes(code) ? 'blocked' : 'failed';
  return Object.freeze({ status, error: Object.freeze({ code, message: messages[code] }) });
}

function bridgeFailure(code: ErrorCode): CodeToolOutcome {
  return Object.freeze({ status: code === 'CANCELLED' ? 'cancelled' : code === 'OUTCOME_UNKNOWN' ? 'outcome_unknown'
    : ['PERMISSION_DENIED', 'BUDGET_EXCEEDED', 'GUARD_BLOCKED', 'GUARD_UNAVAILABLE'].includes(code) ? 'blocked' : 'failed',
  error: Object.freeze({ code, message: messages[code] }) });
}

function errorCode(value: unknown): ErrorCode {
  return typeof value === 'string' && Object.hasOwn(messages, value) ? value as ErrorCode : 'TOOL_FAILED';
}

function snapshotReceipt(value: unknown, callId: string, toolId: string): ExecutionReceipt | undefined {
  if (value === undefined) return undefined;
  try {
    const receipt = jsonValue(value, { maxBytes: 4_096 });
    if (!plainRecord(receipt) || receipt['callId'] !== callId || receipt['toolId'] !== toolId
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
  if (!(data['signal'] instanceof AbortSignal)) throw new MayuraError('INVALID_CONFIG', 'An AbortSignal is required.');
  const scope = freezeJson(jsonValue(data['scope'], { maxBytes: 2_048 }));
  if (!plainRecord(scope) || Object.keys(scope).length !== 2 || !Object.hasOwn(scope, 'principalId') || !Object.hasOwn(scope, 'projectId')) {
    throw new MayuraError('INVALID_CONFIG', 'A bounded execution scope is required.');
  }
  text(scope['principalId'], 'scope.principalId', 256);
  text(scope['projectId'], 'scope.projectId', 256);
  return Object.freeze({ runId: data['runId'], executionId: data['executionId'], scope: scope as unknown as Scope, signal: data['signal'] as AbortSignal });
}

function snapshotSandboxResult(value: unknown, maxOutputBytes: number): SandboxExecutionResult | undefined {
  try {
    if (!plainRecord(value)) return undefined;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (!fields['status'] || !fields['status'].enumerable || !('value' in fields['status'])) return undefined;
    if (fields['status'].value === 'failed' && Reflect.ownKeys(fields).length === 1) return Object.freeze({ status: 'failed' });
    if (fields['status'].value !== 'succeeded' || Reflect.ownKeys(fields).length !== 2) return undefined;
    const output = fields['output'];
    if (!output || !output.enumerable || !('value' in output)) return undefined;
    return Object.freeze({ status: 'succeeded', output: freezeJson(jsonValue(output.value, { maxBytes: maxOutputBytes })) });
  } catch { return undefined; }
}

/** Creates an ephemeral Code Mode executor. It never evaluates source outside the supplied adapter. */
export function createCodeMode(options: CreateCodeModeOptions): CodeMode {
  const data = exactData(options, ['adapter', 'invokeTool'], ['allowTestAdapter']);
  const adapter = data['adapter'] as SandboxAdapter;
  const registration = adapters.get(adapter);
  if (!registration) throw new MayuraError('INVALID_CONFIG', 'Sandbox adapter was not created by this package instance.');
  if (typeof data['invokeTool'] !== 'function') throw new MayuraError('INVALID_CONFIG', 'A trusted tool broker callback is required.');
  if (data['allowTestAdapter'] !== undefined && typeof data['allowTestAdapter'] !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'allowTestAdapter must be boolean.');
  if (adapter.qualification !== 'production' && data['allowTestAdapter'] !== true) throw new MayuraError('UNSUPPORTED_PROFILE', messages.UNSUPPORTED_PROFILE);
  const invoke = data['invokeTool'] as CreateCodeModeOptions['invokeTool'];
  const executions = new Set<string>();

  return Object.freeze({
    async execute<I extends Schema, O extends Schema>(program: CodeProgramDefinition<I, O>, rawInput: InferInput<I>, rawOptions: ExecuteCodeOptions): Promise<Outcome<InferOutput<O>>> {
      const registered = programs.get(program);
      if (!registered) return failure('INVALID_CONFIG') as Outcome<InferOutput<O>>;
      let execution: ExecuteCodeOptions;
      try { execution = snapshotExecutionOptions(rawOptions); }
      catch { return failure('INVALID_CONFIG') as Outcome<InferOutput<O>>; }
      if (executions.size >= MAX_EXECUTIONS_PER_RUNTIME) return failure('LIMIT_EXCEEDED') as Outcome<InferOutput<O>>;
      if (executions.has(execution.executionId)) return failure('CONFLICT') as Outcome<InferOutput<O>>;
      executions.add(execution.executionId);
      let inputSnapshot: JsonValue;
      try { inputSnapshot = freezeJson(jsonValue(rawInput, { maxBytes: program.manifest.limits.maxInputBytes })); }
      catch { return failure('INVALID_INPUT') as Outcome<InferOutput<O>>; }
      let available = false;
      try { available = await registration.isAvailable() === true; }
      catch { /* Availability errors reveal no adapter details. */ }
      if (!available) return failure('UNSUPPORTED_PROFILE') as Outcome<InferOutput<O>>;

      const controller = new AbortController();
      let abortCode: 'CANCELLED' | 'TIMEOUT' = 'CANCELLED';
      const relay = (): void => { if (!controller.signal.aborted) { abortCode = 'CANCELLED'; controller.abort(); } };
      execution.signal.addEventListener('abort', relay, { once: true });
      if (execution.signal.aborted) relay();
      const timer = setTimeout(() => { if (!controller.signal.aborted) { abortCode = 'TIMEOUT'; controller.abort(); } }, program.manifest.limits.wallTimeMillis);
      const evidence: ExecutionEvidence[] = [];
      const pending = new Set<Promise<CodeToolOutcome>>();
      let startedCalls = 0;
      let activeCalls = 0;
      let bridgeOpen = true;
      let bridgeCloseCode: 'CONFLICT' | 'CANCELLED' | 'TIMEOUT' = 'CONFLICT';
      const bridge: CodeToolBridge = Object.freeze({
        call(toolId: string, untrustedInput: unknown): Promise<CodeToolOutcome> {
          const operation = (async (): Promise<CodeToolOutcome> => {
            if (!bridgeOpen) return bridgeFailure(bridgeCloseCode);
            if (controller.signal.aborted) return bridgeFailure(abortCode);
            if (typeof toolId !== 'string' || !registered.tools.has(toolId)) return bridgeFailure('PERMISSION_DENIED');
            if (startedCalls >= program.manifest.limits.maxToolCalls || activeCalls >= program.manifest.limits.maxToolConcurrency) return bridgeFailure('LIMIT_EXCEEDED');
            const sequence = ++startedCalls;
            activeCalls++;
            try {
              let input: JsonValue;
              try { input = freezeJson(jsonValue(untrustedInput, { maxBytes: program.manifest.limits.maxToolInputBytes })); }
              catch { return bridgeFailure('INVALID_INPUT'); }
              if (controller.signal.aborted) return bridgeFailure(abortCode);
              const tool = registered.tools.get(toolId)!;
              const callId = `${execution.executionId}:code:${sequence}`;
              let outcome: Outcome<JsonValue>;
              try {
                outcome = await invoke(tool, input, Object.freeze({ runId: execution.runId, executionId: execution.executionId,
                  callId, programDigest: program.manifest.digest, scope: execution.scope, signal: controller.signal }));
              } catch { return bridgeFailure('TOOL_FAILED'); }
              const snapshot = snapshotToolOutcome(outcome, program.manifest.limits.maxOutputBytes, callId, toolId);
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
          input = freezeJson(jsonValue(await validate(program.input, inputSnapshot, 'input', { maxBytes: program.manifest.limits.maxInputBytes }),
            { maxBytes: program.manifest.limits.maxInputBytes }));
        } catch { return failure('INVALID_INPUT') as Outcome<InferOutput<O>>; }
        if (controller.signal.aborted) return failure(abortCode) as Outcome<InferOutput<O>>;
        const request = Object.freeze({ executionId: execution.executionId, manifest: program.manifest, source: registered.source,
          input, signal: controller.signal, tools: bridge });
        let sandboxResult: SandboxExecutionResult | undefined;
        const adapterWork = Promise.resolve().then(() => registration.execute(request));
        void adapterWork.catch(() => undefined);
        await Promise.race([
          adapterWork.then(result => { sandboxResult = snapshotSandboxResult(result, program.manifest.limits.maxOutputBytes); }, () => undefined),
          new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true })),
        ]);
        bridgeCloseCode = controller.signal.aborted ? abortCode : 'CONFLICT';
        bridgeOpen = false;
        if (controller.signal.aborted) {
          await Promise.allSettled([...pending]);
          return Object.freeze({ ...failure(abortCode), ...(evidence.length ? { evidence: Object.freeze([...evidence]) } : {}) }) as Outcome<InferOutput<O>>;
        }
        await Promise.allSettled([...pending]);
        if (!sandboxResult || !plainRecord(sandboxResult) || sandboxResult.status !== 'succeeded') {
          return Object.freeze({ ...failure('TOOL_FAILED'), ...(evidence.length ? { evidence: Object.freeze([...evidence]) } : {}) }) as Outcome<InferOutput<O>>;
        }
        try {
          const output = freezeJson(jsonValue(await validate(program.output, sandboxResult.output, 'output', { maxBytes: program.manifest.limits.maxOutputBytes }),
            { maxBytes: program.manifest.limits.maxOutputBytes })) as InferOutput<O>;
          return Object.freeze({ status: 'succeeded' as const, output, ...(evidence.length ? { evidence: Object.freeze([...evidence]) } : {}) });
        } catch {
          return Object.freeze({ ...failure('INVALID_OUTPUT'), ...(evidence.length ? { evidence: Object.freeze([...evidence]) } : {}) }) as Outcome<InferOutput<O>>;
        }
      } finally {
        if (controller.signal.aborted) bridgeCloseCode = abortCode;
        bridgeOpen = false;
        clearTimeout(timer);
        execution.signal.removeEventListener('abort', relay);
        if (!controller.signal.aborted) controller.abort();
      }
    },
  });
}

/** Runtime assertion for callers that persist or compare program digests. */
export function isCodeProgramDigest(value: string): boolean {
  return digest.test(value);
}
