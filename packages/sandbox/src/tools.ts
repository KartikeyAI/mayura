import { media, MayuraError, withMedia, type JsonObject, type Schema, type Scope } from '@mayura/core';
import { defineTool, type AnyTool } from '@mayura/tools';
import type { Sandbox } from './sandboxes.js';

/**
 * The sandbox the tools work in: one sandbox, or a function giving the sandbox for a run, such as one created on
 * first use and released when the run ends (see `sandboxPerRun`).
 */
export type SandboxSource = Sandbox | ((context: { readonly runId: string; readonly scope: Scope; readonly signal: AbortSignal }) => Promise<Sandbox>);

export interface SandboxToolsOptions {
  /** Names the tools (`<name>.exec`, `<name>.read`, ...) and their permissions (`sandbox:<name>:exec`, ...). */
  readonly name: string;
  /** Make `<name>.exec`, which runs shell commands; permission `sandbox:<name>:exec`. Off by default. */
  readonly exec?: boolean;
  /** Make `<name>.write` and `<name>.remove`; permission `sandbox:<name>:write`. Off by default: the file tools only read. */
  readonly write?: boolean;
  /** Make `<name>.url`, giving the URL of a port the sandbox serves; permission `sandbox:<name>:ports`. Off by default. */
  readonly ports?: boolean;
  /** Make the desktop tools (`<name>.screenshot`, `.click`, `.type`, `.key`, `.scroll`); permission `sandbox:<name>:desktop`. Off by default. */
  readonly desktop?: boolean;
  /** The longest a command may run, in milliseconds; 5 minutes by default. The model may ask for less. */
  readonly execTimeoutMs?: number;
  /** What one `<name>.exec` call costs at most, in micro-units of your budget currency; 0 by default. */
  readonly execCostMicros?: number;
  /** The most bytes of stdout, and of stderr, returned to the model; 32 KiB by default. The middle of longer output is left out. */
  readonly maxOutputBytes?: number;
  /** The most bytes one read returns to the model; 256 KiB by default. Larger files are read in parts. */
  readonly maxReadBytes?: number;
  /** The largest file one write stores; 1 MiB by default. */
  readonly maxWriteBytes?: number;
}

type Kind = 'string' | 'integer' | 'string?' | 'integer?' | 'boolean?';
/** A bounded object schema of strings, integers and booleans, without a schema library. */
function object<T>(fields: Readonly<Record<string, Kind>>, maxString: number): Schema<T> {
  return { '~standard': { version: 1, vendor: 'mayura-sandbox', validate: (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'Expected an object.' }] };
    const input = value as Record<string, unknown>;
    for (const name of Object.keys(input)) if (!Object.hasOwn(fields, name)) return { issues: [{ message: `Unexpected field ${name}.` }] };
    for (const [name, kind] of Object.entries(fields)) {
      const item = input[name];
      if (item === undefined) { if (kind.endsWith('?')) continue; return { issues: [{ message: `${name} is required.` }] }; }
      if (kind.startsWith('string') && (typeof item !== 'string' || item.length > maxString)) return { issues: [{ message: `${name} must be a string.` }] };
      if (kind.startsWith('integer') && (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)) return { issues: [{ message: `${name} must be a non-negative integer.` }] };
      if (kind.startsWith('boolean') && typeof item !== 'boolean') return { issues: [{ message: `${name} must be true or false.` }] };
    }
    return { value: input as T };
  } } } as Schema<T>;
}
/** `schema`, with a further check of the value it accepted. */
function refine<T>(schema: Schema<T>, check: (value: T) => string | undefined): Schema<T> {
  return { '~standard': { version: 1, vendor: 'mayura-sandbox', validate: (value: unknown) => {
    const result = schema['~standard'].validate(value) as { value?: T; issues?: readonly { message: string }[] };
    if (result.issues) return result;
    const message = check(result.value as T);
    return message === undefined ? result : { issues: [{ message }] };
  } } } as Schema<T>;
}
const anything: Schema<unknown> = { '~standard': { version: 1, vendor: 'mayura-sandbox', validate: (value: unknown) => ({ value }) } } as Schema<unknown>;

const strict = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const toBase64 = (data: Uint8Array) => { let binary = ''; for (let offset = 0; offset < data.byteLength; offset += 0x8000) binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000)); return btoa(binary); };
function fromBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(text) || text.length % 4 !== 0) throw new MayuraError('INVALID_INPUT', 'base64 must be base64.');
  const binary = atob(text); const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
  return data;
}
/** Text at most `max` bytes of UTF-8: its start and end, with what was left out of the middle noted. */
function clip(text: string, max: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= max) return text;
  const half = Math.floor(max / 2); const loose = new TextDecoder('utf-8');
  return `${loose.decode(bytes.subarray(0, half))}\n[... ${bytes.byteLength - 2 * half} bytes left out ...]\n${loose.decode(bytes.subarray(bytes.byteLength - half))}`;
}
function positive(value: number | undefined, name: string, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new MayuraError('INVALID_CONFIG', `sandboxTools(): ${name} must be 1 to ${max}.`);
  return result;
}

/**
 * Tools that let an agent work in a sandbox. Listing and reading files need `sandbox:<name>:read`; the other tools
 * are each off until enabled, and need their own permission. Paths may be absolute or relative to the sandbox's
 * workdir. Commands run as `sh -c <command>`, so the sandbox's image needs a POSIX shell.
 */
export function sandboxTools(source: SandboxSource, options: SandboxToolsOptions): AnyTool[] {
  if (typeof source !== 'function' && (!source || typeof source.exec !== 'function' || typeof source.readFile !== 'function')) throw new MayuraError('INVALID_CONFIG', 'sandboxTools() needs a sandbox, or a function giving one.');
  const name = options?.name;
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(name)) throw new MayuraError('INVALID_CONFIG', 'sandboxTools(): name is lowercase letters, digits, _ and -, starting with a letter.');
  for (const flag of ['exec', 'write', 'ports', 'desktop'] as const) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') throw new MayuraError('INVALID_CONFIG', `sandboxTools(): ${flag} must be a boolean.`);
  }
  if (typeof source !== 'function') {
    if (options.ports && !source.features.ports) throw new MayuraError('INVALID_CONFIG', `sandboxTools(): the ${source.provider} sandbox provider does not serve ports.`);
    if (options.desktop && !source.features.desktop) throw new MayuraError('INVALID_CONFIG', `sandboxTools(): the ${source.provider} sandbox provider has no desktop.`);
  }
  const execTimeoutMs = positive(options.execTimeoutMs, 'execTimeoutMs', 300_000, 86_400_000);
  const maxOutputBytes = positive(options.maxOutputBytes, 'maxOutputBytes', 32_768, 1_048_576);
  const maxReadBytes = positive(options.maxReadBytes, 'maxReadBytes', 262_144, 16_777_216);
  const maxWriteBytes = positive(options.maxWriteBytes, 'maxWriteBytes', 1_048_576, 16_777_216);
  const execCostMicros = options.execCostMicros ?? 0;
  if (!Number.isSafeInteger(execCostMicros) || execCostMicros < 0) throw new MayuraError('INVALID_CONFIG', 'sandboxTools(): execCostMicros must be a non-negative integer.');
  const version = `1:${execTimeoutMs}:${maxOutputBytes}:${maxReadBytes}:${maxWriteBytes}`;
  const sandbox = async (context: { readonly runId: string; readonly scope: Scope; readonly signal: AbortSignal }): Promise<Sandbox> => {
    if (typeof source !== 'function') return source;
    const resolved = await source({ runId: context.runId, scope: context.scope, signal: context.signal });
    if (!resolved || typeof resolved.exec !== 'function') throw new MayuraError('INVALID_CONFIG', 'The sandbox source gave no sandbox.');
    return resolved;
  };
  const pathField = { type: 'string', description: 'The path: absolute, or relative to the working directory.' };

  const tools: AnyTool[] = [
    defineTool({
      id: `${name}.read`, version, effects: 'read', capabilities: [`sandbox:${name}:read`], timeoutMs: 120_000,
      description: `Read a file in the ${name} sandbox. Text comes back as text, anything else as base64. Up to ${maxReadBytes} bytes per call: read larger files in parts with offset.`,
      input: object<{ path: string; offset?: number }>({ path: 'string', offset: 'integer?' }, 4_096),
      output: anything,
      inputJsonSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: pathField, offset: { type: 'integer', minimum: 0, description: 'Start reading at this byte.' } } } as JsonObject,
      execute: async (request, context) => {
        const box = await sandbox(context); const offset = request.offset ?? 0;
        // Files are read whole (up to the sandbox's limit) and the part asked for is returned.
        const file = await box.readFile(request.path, { signal: context.signal });
        if (!file) return { path: request.path, found: false } as JsonObject;
        const part = file.subarray(offset, offset + maxReadBytes); const end = offset + part.byteLength;
        let content: JsonObject;
        try { content = { text: strict.decode(part) }; } catch { content = { base64: toBase64(part) }; }
        return { path: request.path, found: true, size: file.byteLength, offset, ...content, ...(end < file.byteLength ? { nextOffset: end } : {}) } as JsonObject;
      },
    }) as unknown as AnyTool,
    defineTool({
      id: `${name}.list`, version, effects: 'read', capabilities: [`sandbox:${name}:read`], timeoutMs: 120_000,
      description: `List a directory in the ${name} sandbox: names, types and sizes. Without a path, the working directory.`,
      input: object<{ path?: string }>({ path: 'string?' }, 4_096),
      output: anything,
      inputJsonSchema: { type: 'object', additionalProperties: false, properties: { path: pathField } } as JsonObject,
      execute: async (request, context) => {
        const box = await sandbox(context);
        const entries = await box.listFiles(request.path, { limit: 1_000, signal: context.signal });
        if (!entries) return { path: request.path ?? box.workdir, found: false } as JsonObject;
        return { path: request.path ?? box.workdir, found: true, entries: entries.map(entry => ({ name: entry.name, type: entry.type, size: entry.size })) } as JsonObject;
      },
    }) as unknown as AnyTool,
  ];
  if (options.exec) {
    tools.push(defineTool({
      id: `${name}.exec`, version, effects: 'write', capabilities: [`sandbox:${name}:exec`], timeoutMs: execTimeoutMs + 30_000, costMicros: execCostMicros,
      description: `Run a shell command in the ${name} sandbox, an isolated Linux machine, and get its exit code and output. Commands run with sh -c, in the working directory unless cwd is given. Each runs at most ${Math.round(execTimeoutMs / 1_000)} s; output past ${maxOutputBytes} bytes is cut in the middle.`,
      input: refine(object<{ command: string; cwd?: string; stdin?: string; timeoutSeconds?: number }>({ command: 'string', cwd: 'string?', stdin: 'string?', timeoutSeconds: 'integer?' }, 131_072),
        request => request.command.trim() === '' ? 'command is required.' : request.timeoutSeconds === 0 ? 'timeoutSeconds must be positive.' : undefined),
      output: anything,
      inputJsonSchema: { type: 'object', additionalProperties: false, required: ['command'], properties: {
        command: { type: 'string', description: 'The shell command, such as npm test or ls -la src.' },
        cwd: { type: 'string', description: 'The directory to run in.' },
        stdin: { type: 'string', description: 'Text to give the command on standard input.' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: Math.ceil(execTimeoutMs / 1_000), description: 'Stop the command after this many seconds.' } } } as JsonObject,
      execute: async (request, context) => {
        const timeoutMs = request.timeoutSeconds === undefined ? execTimeoutMs : Math.min(request.timeoutSeconds * 1_000, execTimeoutMs);
        const box = await sandbox(context);
        const result = await box.exec(['sh', '-c', request.command], { timeoutMs, signal: context.signal,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }), ...(request.stdin === undefined ? {} : { stdin: request.stdin }) });
        return { ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }), timedOut: result.timedOut,
          stdout: clip(result.stdout, maxOutputBytes), stderr: clip(result.stderr, maxOutputBytes), durationMs: result.durationMs,
          ...(result.truncated ? { truncated: true } : {}) } as JsonObject;
      },
    }) as unknown as AnyTool);
  }
  if (options.write) {
    tools.push(
      defineTool({
        id: `${name}.write`, version, effects: 'write', capabilities: [`sandbox:${name}:write`], timeoutMs: 120_000,
        description: `Write a file in the ${name} sandbox, creating its directories and replacing any file there. Give text, or base64 for other data; at most ${maxWriteBytes} bytes.`,
        input: refine(object<{ path: string; text?: string; base64?: string }>({ path: 'string', text: 'string?', base64: 'string?' }, Math.ceil(maxWriteBytes / 3) * 4 + 4),
          request => (request.text === undefined) === (request.base64 === undefined) ? 'Give text or base64.' : undefined),
        output: anything,
        inputJsonSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: {
          path: pathField, text: { type: 'string', description: 'The content, as text.' }, base64: { type: 'string', description: 'The content, base64-encoded, instead of text.' } } } as JsonObject,
        execute: async (request, context) => {
          const data = request.text !== undefined ? encoder.encode(request.text) : fromBase64(request.base64!);
          if (data.byteLength > maxWriteBytes) throw new MayuraError('LIMIT_EXCEEDED', `A file written by this tool is at most ${maxWriteBytes} bytes.`);
          await (await sandbox(context)).writeFile(request.path, data, { signal: context.signal });
          return { path: request.path, size: data.byteLength } as JsonObject;
        },
      }) as unknown as AnyTool,
      defineTool({
        id: `${name}.remove`, version, effects: 'write', capabilities: [`sandbox:${name}:write`], timeoutMs: 120_000,
        description: `Remove a file in the ${name} sandbox, or a directory and everything in it with recursive.`,
        input: object<{ path: string; recursive?: boolean }>({ path: 'string', recursive: 'boolean?' }, 4_096),
        output: anything,
        inputJsonSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: {
          path: pathField, recursive: { type: 'boolean', description: 'Remove a directory and everything in it.' } } } as JsonObject,
        execute: async (request, context) => {
          await (await sandbox(context)).removeFile(request.path, { recursive: request.recursive ?? false, signal: context.signal });
          return { path: request.path, removed: true } as JsonObject;
        },
      }) as unknown as AnyTool,
    );
  }
  if (options.ports) {
    tools.push(defineTool({
      id: `${name}.url`, version, effects: 'read', capabilities: [`sandbox:${name}:ports`], timeoutMs: 60_000,
      description: `Get the URL where the ${name} sandbox serves a port, such as a web server started in it. Only ports opened when the sandbox was created have one.`,
      input: object<{ port: number }>({ port: 'integer' }, 0),
      output: anything,
      inputJsonSchema: { type: 'object', additionalProperties: false, required: ['port'], properties: { port: { type: 'integer', minimum: 1, maximum: 65_535 } } } as JsonObject,
      execute: async (request, context) => ({ port: request.port, url: await (await sandbox(context)).url(request.port, { signal: context.signal }) }) as JsonObject,
    }) as unknown as AnyTool);
  }
  if (options.desktop) {
    const desktopOf = async (context: { readonly runId: string; readonly scope: Scope; readonly signal: AbortSignal }) => {
      const box = await sandbox(context);
      if (!box.desktop) throw new MayuraError('INVALID_INPUT', `The ${box.provider} sandbox has no desktop.`);
      return box.desktop;
    };
    const permission = [`sandbox:${name}:desktop`];
    const point = { x: { type: 'integer', minimum: 0, description: 'Pixels from the left.' }, y: { type: 'integer', minimum: 0, description: 'Pixels from the top.' } };
    tools.push(
      defineTool({
        id: `${name}.screenshot`, version, effects: 'read', capabilities: permission, timeoutMs: 60_000,
        media: { accept: ['image/png', 'image/jpeg'], maxItems: 1, maxBytes: 16 * 1_048_576 },
        description: `See the ${name} sandbox's screen. Returns the image and its size in pixels.`,
        input: object<Record<string, never>>({}, 0),
        output: anything,
        inputJsonSchema: { type: 'object', additionalProperties: false, properties: {} } as JsonObject,
        execute: async (_request, context) => {
          const desktop = await desktopOf(context);
          const [shot, size] = await Promise.all([desktop.screenshot({ signal: context.signal }), desktop.size({ signal: context.signal })]);
          return withMedia({ width: size.width, height: size.height } as JsonObject, [media(shot.data, shot.mediaType)]);
        },
      }) as unknown as AnyTool,
      defineTool({
        id: `${name}.click`, version, effects: 'write', capabilities: permission, timeoutMs: 60_000,
        description: `Click on the ${name} sandbox's screen, at pixel coordinates from a screenshot.`,
        input: refine(object<{ x: number; y: number; button?: string; double?: boolean }>({ x: 'integer', y: 'integer', button: 'string?', double: 'boolean?' }, 8),
          request => request.button === undefined || ['left', 'right', 'middle'].includes(request.button) ? undefined : "button is 'left', 'right' or 'middle'."),
        output: anything,
        inputJsonSchema: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { ...point,
          button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: { type: 'boolean', description: 'Double-click.' } } } as JsonObject,
        execute: async (request, context) => {
          await (await desktopOf(context)).click(request.x, request.y, { button: (request.button ?? 'left') as 'left' | 'right' | 'middle', double: request.double ?? false, signal: context.signal });
          return { clicked: true } as JsonObject;
        },
      }) as unknown as AnyTool,
      defineTool({
        id: `${name}.scroll`, version, effects: 'write', capabilities: permission, timeoutMs: 60_000,
        description: `Scroll on the ${name} sandbox's screen at a point: dy is notches down (negative for up), dx notches right.`,
        input: { '~standard': { version: 1, vendor: 'mayura-sandbox', validate: (value: unknown) => {
          const input = value as Record<string, unknown> | null;
          if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['x', 'y', 'dx', 'dy'].includes(key))
            || [input['x'], input['y']].some(item => !Number.isSafeInteger(item) || (item as number) < 0)
            || [input['dx'], input['dy']].some(item => item !== undefined && (!Number.isSafeInteger(item) || Math.abs(item as number) > 100))) return { issues: [{ message: 'Expected x, y and dx or dy.' }] };
          return { value: input as { x: number; y: number; dx?: number; dy?: number } };
        } } } as Schema<{ x: number; y: number; dx?: number; dy?: number }>,
        output: anything,
        inputJsonSchema: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { ...point,
          dx: { type: 'integer', minimum: -100, maximum: 100 }, dy: { type: 'integer', minimum: -100, maximum: 100 } } } as JsonObject,
        execute: async (request, context) => {
          await (await desktopOf(context)).scroll(request.x, request.y, { dx: request.dx ?? 0, dy: request.dy ?? 0, signal: context.signal });
          return { scrolled: true } as JsonObject;
        },
      }) as unknown as AnyTool,
      defineTool({
        id: `${name}.type`, version, effects: 'write', capabilities: permission, timeoutMs: 120_000,
        description: `Type text on the ${name} sandbox's desktop, into whatever has focus.`,
        input: object<{ text: string }>({ text: 'string' }, 10_000),
        output: anything,
        inputJsonSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } } as JsonObject,
        execute: async (request, context) => { await (await desktopOf(context)).type(request.text, { signal: context.signal }); return { typed: true } as JsonObject; },
      }) as unknown as AnyTool,
      defineTool({
        id: `${name}.key`, version, effects: 'write', capabilities: permission, timeoutMs: 60_000,
        description: `Press a key or a chord on the ${name} sandbox's desktop, such as Enter, Tab, Escape or ctrl+c.`,
        input: object<{ keys: string }>({ keys: 'string' }, 64),
        output: anything,
        inputJsonSchema: { type: 'object', additionalProperties: false, required: ['keys'], properties: { keys: { type: 'string', description: 'A key, or keys joined with +.' } } } as JsonObject,
        execute: async (request, context) => { await (await desktopOf(context)).key(request.keys, { signal: context.signal }); return { pressed: true } as JsonObject; },
      }) as unknown as AnyTool,
    );
  }
  return tools;
}
