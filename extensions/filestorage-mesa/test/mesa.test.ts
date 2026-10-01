import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileStore } from 'mayura/files';
import { fileStoreConformance } from 'mayura/testing';
import { mesaFiles, mesaMaxFileBytes } from '../src/index.js';

interface Change { id: string; parent?: string; files: Map<string, Uint8Array> }
/**
 * Enough of Mesa's REST API to run the file store contract: changes on a base, a bookmark that moves only forward,
 * and content at a change (files, and directories to a depth).
 */
function emulator(options: { racer?: () => Promise<void> } = {}) {
  const changes = new Map<string, Change>([['c0', { id: 'c0', files: new Map() }]]); let bookmark = 'c0'; let next = 0;
  const descends = (id: string, ancestor: string) => { for (let at: string | undefined = id; at; at = changes.get(at)!.parent) if (at === ancestor) return true; return false; };
  const sha = (data: Uint8Array) => createHash('sha1').update(data).digest('hex');
  const error = (status: number) => Response.json({ error: { code: 'x', message: 'SECRET' } }, { status });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.headers.get('authorization') !== 'Bearer fixture-token') return error(401);
    const url = new URL(request.url); const path = url.pathname.replace(/^\/v1\/acme\/notes/u, '');
    if (path === '/bookmarks/main' && request.method === 'GET') return Response.json({ name: 'main', change_id: bookmark, is_default: true });
    if (path === '/bookmarks/main' && request.method === 'PATCH') {
      const { change_id } = await request.json() as { change_id: string };
      if (!descends(change_id, bookmark)) return error(409);
      const from = bookmark; bookmark = change_id; return Response.json({ name: 'main', change_id, is_default: true, from_change_id: from });
    }
    if (path === '/changes' && request.method === 'POST') {
      const body = await request.json() as { base_change_id: string; files: { path: string; action?: string; content?: string }[] };
      const base = changes.get(body.base_change_id); if (!base) return error(404);
      await options.racer?.();
      const files = new Map(base.files);
      for (const file of body.files) { if (file.action === 'delete') files.delete(file.path); else files.set(file.path, new Uint8Array(Buffer.from(file.content!, 'base64'))); }
      const change = { id: `c${++next}`, parent: base.id, files }; changes.set(change.id, change);
      return Response.json({ id: change.id, current_commit_oid: change.id, is_conflicted: false }, { status: 201 });
    }
    if (path === '/content' && request.method === 'GET') {
      const change = changes.get(url.searchParams.get('change_id')!); if (!change) return error(404);
      const target = url.searchParams.get('path') ?? ''; const depth = Number(url.searchParams.get('depth') ?? 1);
      const file = change.files.get(target);
      if (file) return Response.json({ type: 'file', name: target.split('/').at(-1), path: target, sha: sha(file), size: file.byteLength, encoding: 'base64', content: Buffer.from(file).toString('base64'), mode: '100644' });
      const directory = (prefix: string, levels: number): unknown[] => {
        const names = new Map<string, boolean>();
        for (const key of change.files.keys()) if (key.startsWith(prefix)) { const rest = key.slice(prefix.length); const [first, ...more] = rest.split('/'); names.set(first!, names.get(first!) || more.length > 0); }
        return [...names].map(([name, isDir]) => isDir
          ? { type: 'dir', name, path: `${prefix}${name}`, sha: 'd', ...(levels > 1 ? { entries: directory(`${prefix}${name}/`, levels - 1) } : {}) }
          : { type: 'file', name, path: `${prefix}${name}`, sha: sha(change.files.get(`${prefix}${name}`)!), size: change.files.get(`${prefix}${name}`)!.byteLength, mode: '100644' });
      };
      const prefix = target ? `${target}/` : '';
      if (target && ![...change.files.keys()].some(key => key.startsWith(prefix))) return error(404);
      return Response.json({ type: 'dir', name: target, path: target, sha: 'd', child_count: 0, entries: directory(prefix, depth) });
    }
    return error(400);
  }) as typeof globalThis.fetch;
  return { fetch, head: () => changes.get(bookmark)! };
}
const token = () => 'fixture-token';
const mesa = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof mesaFiles>[0]> = {}) =>
  createFileStore(mesaFiles({ token, org: 'acme', repo: 'notes', apiURL: 'http://127.0.0.1:1/v1', fetch, ...extra }), { maxFileBytes: mesaMaxFileBytes });

describe('@mayurajs/filestorage-mesa keeps the file store contract', () => {
  const store = mesa(emulator().fetch);
  // Mesa keeps no media type or metadata, which the first case writes and reads back; preconditions skip themselves.
  const skip = { 'writes and reads back bytes, media type and metadata': 'Mesa keeps no media type or metadata' };
  for (const test of fileStoreConformance) it(test.name, async () => {
    expect(await test.run({ store, skip })).toBe(test.name in skip || /ifMatch|ifNoneMatch/u.test(test.name) ? 'skipped' : 'passed');
  });
});

describe('@mayurajs/filestorage-mesa', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('rebases a write onto a bookmark another writer moved, so concurrent writers keep each other\'s files', async () => {
    let racing = 0;
    const mesaApi = emulator({ racer: async () => { if (racing++ < 3) await new Promise(resolve => setTimeout(resolve, 5)); } });
    const store = mesa(mesaApi.fetch);
    await Promise.all(['a.txt', 'b.txt', 'c.txt'].map(key => store.put(key, new TextEncoder().encode(key))));
    expect([...mesaApi.head().files.keys()].sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('refuses metadata and files over Mesa\'s inline limit, before sending', async () => {
    let sent = 0;
    const counting = (async () => { sent++; return new Response(null, { status: 500 }); }) as unknown as typeof globalThis.fetch;
    const store = createFileStore(mesaFiles({ token, org: 'acme', repo: 'notes', fetch: counting }), { maxFileBytes: 1_048_576 });
    await expect(store.put('a', new Uint8Array(1), { metadata: { owner: 'acme' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.put('a', new Uint8Array(mesaMaxFileBytes + 1))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(sent).toBe(0);
  });

  it('maps errors to fixed reasons without the service text, and reads nothing from the environment', async () => {
    vi.stubEnv('MESA_API_KEY', 'from-env');
    for (const [status, reason] of [[401, 'authentication'], [403, 'authentication'], [500, 'unavailable']] as const) {
      const failing = (async () => Response.json({ error: { code: 'x', message: 'SECRET' } }, { status })) as unknown as typeof globalThis.fetch;
      const caught = await mesa(failing).head('a').catch((thrown: unknown) => thrown);
      expect(caught).toMatchObject({ reason }); expect(JSON.stringify(caught)).not.toContain('SECRET');
    }
  });

  it('needs a token source, Mesa names and an https API (or http on this machine)', () => {
    const invalid = expect.objectContaining({ code: 'INVALID_CONFIG' });
    expect(() => mesaFiles({ token, org: 'acme/x', repo: 'notes' })).toThrow(invalid);
    expect(() => mesaFiles({ token, org: 'acme', repo: 'notes', bookmark: '../main' })).toThrow(invalid);
    expect(() => mesaFiles({ token: 'secret' as never, org: 'acme', repo: 'notes' })).toThrow(invalid);
    expect(() => mesaFiles({ token, org: 'acme', repo: 'notes', apiURL: 'http://mesa.internal/v1' })).toThrow(invalid);
    expect(() => mesaFiles({ token, org: 'acme', repo: 'notes' })).not.toThrow();
  });
});
