import { MayuraError, type JsonObject, type Schema } from '@mayura/core';
import { defineTool, type AnyTool } from '@mayura/tools';
import type { FileInfo, FileStore } from './contracts.js';

type Kind = 'string' | 'integer' | 'string?' | 'integer?';
/** A bounded object schema of strings and integers, without a schema library. */
function object<T>(fields: Readonly<Record<string, Kind>>, maxString: number): Schema<T> {
  return { '~standard': { version: 1, vendor: 'mayura-files', validate: (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'Expected an object.' }] };
    const input = value as Record<string, unknown>;
    for (const name of Object.keys(input)) if (!Object.hasOwn(fields, name)) return { issues: [{ message: `Unexpected field ${name}.` }] };
    for (const [name, kind] of Object.entries(fields)) {
      const item = input[name];
      if (item === undefined) { if (kind.endsWith('?')) continue; return { issues: [{ message: `${name} is required.` }] }; }
      if (kind.startsWith('string') && (typeof item !== 'string' || item.length > maxString)) return { issues: [{ message: `${name} must be a string.` }] };
      if (kind.startsWith('integer') && (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)) return { issues: [{ message: `${name} must be a non-negative integer.` }] };
    }
    return { value: input as T };
  } } } as Schema<T>;
}
const anything: Schema<unknown> = { '~standard': { version: 1, vendor: 'mayura-files', validate: (value: unknown) => ({ value }) } } as Schema<unknown>;

export interface FileToolsOptions {
  /** Names the tools (`<name>.read`, `<name>.list`, ...) and their permissions (`files:<name>:read`, `files:<name>:write`). */
  readonly name: string;
  /** Also make `<name>.write` and `<name>.delete`. Off by default: the tools only read. */
  readonly write?: boolean;
  /** Let `<name>.write` replace a file that exists. Off by default: writes only create new files. */
  readonly overwrite?: boolean;
  /** The most bytes one read returns to the model; 256 KiB (or the store's `maxFileBytes`) by default. Larger files are read in ranges. */
  readonly maxReadBytes?: number;
  /** The largest file one write stores; 1 MiB (or the store's `maxFileBytes`) by default, and at most that. */
  readonly maxWriteBytes?: number;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const toBase64 = (data: Uint8Array) => { let binary = ''; for (let offset = 0; offset < data.byteLength; offset += 0x8000) binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000)); return btoa(binary); };
function fromBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(text) || text.length % 4 !== 0) throw new MayuraError('INVALID_INPUT', 'base64 must be base64.');
  const binary = atob(text); const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
  return data;
}
const summary = (file: FileInfo): JsonObject => ({ path: file.key, size: file.size, etag: file.etag, ...(file.contentType ? { contentType: file.contentType } : {}),
  ...(file.lastModified === undefined ? {} : { lastModified: new Date(file.lastModified).toISOString() }) });

/**
 * Tools that let an agent read, list and (when `write` is on) write and delete files in one store. Reads and lists
 * require `files:<name>:read`; writes and deletes require `files:<name>:write` and are `write` effects. Give the tools
 * a store made with `within(...)` to confine them to one tenant's or one run's files.
 */
export function fileTools(store: FileStore, options: FileToolsOptions): AnyTool[] {
  if (!store || typeof store.get !== 'function' || typeof store.within !== 'function') throw new MayuraError('INVALID_CONFIG', 'fileTools() needs a file store.');
  const name = options?.name;
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(name)) throw new MayuraError('INVALID_CONFIG', 'fileTools(): name is lowercase letters, digits, _ and -, starting with a letter.');
  const maxReadBytes = options.maxReadBytes ?? Math.min(262_144, store.maxFileBytes); const maxWriteBytes = options.maxWriteBytes ?? Math.min(1_048_576, store.maxFileBytes);
  for (const [value, label] of [[maxReadBytes, 'maxReadBytes'], [maxWriteBytes, 'maxWriteBytes']] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > store.maxFileBytes) throw new MayuraError('INVALID_CONFIG', `fileTools(): ${label} must be 1 to the store's maxFileBytes.`);
  }
  if (options.write !== undefined && typeof options.write !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'fileTools(): write must be a boolean.');
  if (options.overwrite !== undefined && (typeof options.overwrite !== 'boolean' || (options.overwrite && !options.write))) throw new MayuraError('INVALID_CONFIG', 'fileTools(): overwrite needs write.');
  // Create-only writes need a store that can refuse a write when the file exists; without one, only overwriting is honest.
  if (options.write && !options.overwrite && !store.conditionalWrites) throw new MayuraError('INVALID_CONFIG', `fileTools(): the ${store.id} store cannot create files only when absent; set overwrite: true to let the tools replace files.`);
  const read = `files:${name}:read`; const write = `files:${name}:write`; const version = `1:${store.id}:${maxReadBytes}:${maxWriteBytes}:${options.overwrite ? 'overwrite' : 'create'}`;

  const tools: AnyTool[] = [
    defineTool({
      id: `${name}.read`, version, effects: 'read', capabilities: [read], timeoutMs: 60_000,
      description: `Read a file from the ${name} files. Text comes back as text, anything else as base64. Up to ${maxReadBytes} bytes per call: read larger files in parts with offset and length.`,
      input: object<{ path: string; offset?: number; length?: number }>({ path: 'string', offset: 'integer?', length: 'integer?' }, 1_024),
      output: anything,
      inputJsonSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: { type: 'string', description: 'The file path, such as reports/q3.csv.' },
        offset: { type: 'integer', minimum: 0, description: 'Start reading at this byte.' },
        length: { type: 'integer', minimum: 1, description: `Read at most this many bytes (at most ${maxReadBytes}).` } } } as JsonObject,
      execute: async (request, context) => {
        const offset = request.offset ?? 0; const length = Math.min(request.length ?? maxReadBytes, maxReadBytes);
        if (length < 1) throw new MayuraError('INVALID_INPUT', 'length must be positive.');
        const file = await store.get(request.path, { range: { offset, length }, maxBytes: maxReadBytes, signal: context.signal });
        if (!file) return { path: request.path, found: false } as JsonObject;
        let content: JsonObject;
        try { content = { text: decoder.decode(file.data) }; } catch { content = { base64: toBase64(file.data) }; }
        const end = offset + file.data.byteLength;
        return { ...summary(file), found: true, offset, ...content, ...(end < file.size ? { nextOffset: end } : {}) } as JsonObject;
      },
    }) as unknown as AnyTool,
    defineTool({
      id: `${name}.list`, version, effects: 'read', capabilities: [read], timeoutMs: 60_000,
      description: `List files in the ${name} files, in path order, optionally under a prefix such as reports/. Pass the cursor of a page to get the next.`,
      input: object<{ prefix?: string; cursor?: string; limit?: number }>({ prefix: 'string?', cursor: 'string?', limit: 'integer?' }, 4_096),
      output: anything,
      inputJsonSchema: { type: 'object', additionalProperties: false, properties: {
        prefix: { type: 'string', description: 'Only paths starting with this.' }, cursor: { type: 'string', description: 'The cursor of the previous page.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'At most this many files (100 by default).' } } } as JsonObject,
      execute: async (request, context) => {
        const page = await store.list({ limit: Math.min(request.limit ?? 100, 100), signal: context.signal,
          ...(request.prefix === undefined ? {} : { prefix: request.prefix }), ...(request.cursor === undefined ? {} : { cursor: request.cursor }) });
        return { files: page.files.map(summary), ...(page.cursor === undefined ? {} : { cursor: page.cursor }) } as JsonObject;
      },
    }) as unknown as AnyTool,
  ];
  if (!options.write) return tools;
  tools.push(
    defineTool({
      id: `${name}.write`, version, effects: 'write', capabilities: [write], timeoutMs: 60_000,
      description: options.overwrite
        ? `Write a file in the ${name} files, creating or replacing it. Give text, or base64 for other data.${store.conditionalWrites ? ' To replace a file only if unchanged since you read it, give its etag as ifMatch.' : ''}`
        : `Create a new file in the ${name} files. Give text, or base64 for other data. Existing files cannot be replaced.`,
      input: object<{ path: string; text?: string; base64?: string; contentType?: string; ifMatch?: string }>(
        { path: 'string', text: 'string?', base64: 'string?', contentType: 'string?', ...(options.overwrite && store.conditionalWrites ? { ifMatch: 'string?' as const } : {}) }, Math.ceil(maxWriteBytes / 3) * 4 + 4),
      output: anything,
      inputJsonSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: { type: 'string', description: 'The file path, such as reports/q3.csv.' }, text: { type: 'string', description: 'The content, as text.' },
        base64: { type: 'string', description: 'The content, base64-encoded, instead of text.' }, contentType: { type: 'string', description: 'Its media type, such as text/csv.' },
        ...(options.overwrite && store.conditionalWrites ? { ifMatch: { type: 'string', description: 'Replace only if the file is still at this etag.' } } : {}) } } as JsonObject,
      execute: async (request, context) => {
        if ((request.text === undefined) === (request.base64 === undefined)) throw new MayuraError('INVALID_INPUT', 'Give text or base64.');
        const data = request.text !== undefined ? new TextEncoder().encode(request.text) : fromBase64(request.base64!);
        if (data.byteLength > maxWriteBytes) throw new MayuraError('LIMIT_EXCEEDED', `A file written by this tool is at most ${maxWriteBytes} bytes.`);
        const contentType = request.contentType ?? (request.text !== undefined ? 'text/plain; charset=utf-8' : 'application/octet-stream');
        const written = await store.put(request.path, data, { contentType, signal: context.signal,
          ...(options.overwrite ? (request.ifMatch === undefined ? {} : { ifMatch: request.ifMatch }) : { ifNoneMatch: '*' as const }) });
        return summary(written);
      },
    }) as unknown as AnyTool,
    defineTool({
      id: `${name}.delete`, version, effects: 'write', capabilities: [write], timeoutMs: 60_000,
      description: `Delete a file from the ${name} files.${store.conditionalDelete ? ' Give its etag as ifMatch to delete it only if unchanged.' : ''}`,
      input: object<{ path: string; ifMatch?: string }>({ path: 'string', ...(store.conditionalDelete ? { ifMatch: 'string?' as const } : {}) }, 1_024),
      output: anything,
      inputJsonSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: { type: 'string', description: 'The file path.' }, ...(store.conditionalDelete ? { ifMatch: { type: 'string', description: 'Delete only if the file is still at this etag.' } } : {}) } } as JsonObject,
      execute: async (request, context) => {
        await store.delete(request.path, { signal: context.signal, ...(request.ifMatch === undefined ? {} : { ifMatch: request.ifMatch }) });
        return { path: request.path, deleted: true } as JsonObject;
      },
    }) as unknown as AnyTool,
  );
  return tools;
}
