import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileStore } from 'mayura/files';
import { fileStoreConformance } from 'mayura/testing';
import { googleDriveFiles } from '../src/index.js';

const folderId = 'folder_0123456789';
interface DriveFile { id: string; name: string; parents: string[]; data: Uint8Array; version: number; mimeType: string; modifiedTime: string; appProperties: Record<string, string>; trashed: boolean }
/** Reads a Drive query string literal ('...' with \\ and \' escapes) starting at `from`. */
function readLiteral(text: string, from: number): [string, number] {
  let value = ''; let index = from + 1;
  while (text[index] !== "'") { if (text[index] === '\\') index++; value += text[index]; index++; }
  return [value, index + 1];
}

/** Enough of the Drive API v3 to run the file store contract: queries, resumable uploads, media reads, trash and delete. */
function emulator(seen: Request[] = []) {
  const files = new Map<string, DriveFile>(); let ids = 0; let clock = Date.parse('2026-10-01T00:00:00Z'); const sessions = new Map<string, { id?: string; meta: Record<string, unknown> }>();
  const resource = (file: DriveFile) => ({ id: file.id, name: file.name, size: String(file.data.byteLength), version: String(file.version), mimeType: file.mimeType, modifiedTime: file.modifiedTime,
    ...(Object.keys(file.appProperties).length ? { appProperties: file.appProperties } : {}) });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); seen.push(request.clone());
    if (request.headers.get('authorization') !== 'Bearer fixture-token') return Response.json({ error: { code: 401, message: 'SECRET' } }, { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === '/drive/v3/files' && request.method === 'GET') {
      const q = url.searchParams.get('q')!;
      const [folder, afterFolder] = readLiteral(q, 0);
      const nameAt = q.indexOf(' and name = ', afterFolder);
      const name = nameAt < 0 ? undefined : readLiteral(q, nameAt + ' and name = '.length)[0];
      const matches = [...files.values()].filter(file => file.parents.includes(folder) && !file.trashed && (name === undefined || file.name === name))
        .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime) || b.id.localeCompare(a.id));
      const size = Number(url.searchParams.get('pageSize')); const start = Number(url.searchParams.get('pageToken') ?? 0);
      const page = matches.slice(start, start + size);
      return Response.json({ files: page.map(resource), ...(matches.length > start + size ? { nextPageToken: String(start + size) } : {}) });
    }
    const upload = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/u.exec(url.pathname);
    if (upload && url.searchParams.get('uploadType') === 'resumable' && !url.searchParams.has('upload_id')) {
      const session = `s${sessions.size + 1}`; sessions.set(session, { ...(upload[1] ? { id: upload[1] } : {}), meta: await request.json() as Record<string, unknown> });
      return new Response(null, { status: 200, headers: { location: `http://127.0.0.1:1/upload/drive/v3/files?uploadType=resumable&upload_id=${session}` } });
    }
    if (url.pathname === '/upload/drive/v3/files' && request.method === 'PUT') {
      const session = sessions.get(url.searchParams.get('upload_id')!)!; const data = new Uint8Array(await request.arrayBuffer());
      const meta = session.meta as { name?: string; parents?: string[]; mimeType: string; appProperties?: Record<string, string | null> };
      clock += 1_000;
      const previous = session.id ? files.get(session.id)! : undefined;
      const properties = { ...(previous?.appProperties ?? {}) };
      for (const [key, value] of Object.entries(meta.appProperties ?? {})) { if (value === null) delete properties[key]; else properties[key] = value; }
      const file: DriveFile = { id: previous?.id ?? `id${++ids}${'x'.repeat(10)}`, name: previous?.name ?? meta.name!, parents: previous?.parents ?? meta.parents!, data, version: (previous?.version ?? 0) + 1,
        mimeType: meta.mimeType, modifiedTime: new Date(clock).toISOString(), appProperties: properties, trashed: false };
      files.set(file.id, file);
      return Response.json(resource(file));
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/u.exec(url.pathname);
    if (one) {
      const file = files.get(decodeURIComponent(one[1]!));
      if (!file) return Response.json({ error: { code: 404 } }, { status: 404 });
      if (request.method === 'DELETE') { files.delete(file.id); return new Response(null, { status: 204 }); }
      if (request.method === 'PATCH') { Object.assign(file, await request.json() as object); return Response.json(resource(file)); }
      if (url.searchParams.get('alt') === 'media') {
        const range = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.get('range') ?? '');
        return range ? new Response(file.data.slice(Number(range[1]), Number(range[2]) + 1) as BodyInit, { status: 206 }) : new Response(file.data as BodyInit, { status: 200 });
      }
    }
    return new Response(null, { status: 400 });
  }) as typeof globalThis.fetch;
  return { fetch, files };
}
const token = () => 'fixture-token';
const drive = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof googleDriveFiles>[0]> = {}) =>
  createFileStore(googleDriveFiles({ token, folderId, endpoint: 'http://127.0.0.1:1', fetch, ...extra }), { maxFileBytes: 1_048_576 });

describe('@mayurajs/filestorage-google-drive keeps the file store contract', () => {
  const store = drive(emulator().fetch);
  for (const test of fileStoreConformance) it(test.name, async () => {
    // Drive has no preconditions: those cases report themselves skipped.
    expect(await test.run({ store })).toBe(/ifMatch|ifNoneMatch/u.test(test.name) ? 'skipped' : 'passed');
  });
});

describe('@mayurajs/filestorage-google-drive', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('declares no preconditions, so they are refused rather than ignored', async () => {
    const store = drive(emulator().fetch);
    expect([store.conditionalWrites, store.conditionalDelete]).toEqual([false, false]);
    await expect(store.put('a', new Uint8Array(1), { ifNoneMatch: '*' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('reads the newest of two files a race left with one name, and deletes both', async () => {
    const google = emulator(); const store = drive(google.fetch);
    await store.put('race.txt', new TextEncoder().encode('first'));
    const [only] = [...google.files.values()];
    google.files.set('idDuplicate000', { ...only!, id: 'idDuplicate000', data: new TextEncoder().encode('second'), modifiedTime: '2027-01-01T00:00:00.000Z', version: 9 });
    expect(new TextDecoder().decode((await store.get('race.txt'))!.data)).toBe('second');
    expect((await store.list()).files.map(file => file.key)).toEqual(['race.txt']);
    await store.delete('race.txt');
    expect(await store.get('race.txt')).toBeUndefined();
  });

  it('moves deleted files to the trash unless asked to delete them outright', async () => {
    const trash = emulator(); await drive(trash.fetch).put('a.txt', new Uint8Array(1)); await drive(trash.fetch).delete('a.txt');
    expect([...trash.files.values()].map(file => file.trashed)).toEqual([true]);
    const gone = emulator(); await drive(gone.fetch, { permanentDelete: true }).put('a.txt', new Uint8Array(1)); await drive(gone.fetch, { permanentDelete: true }).delete('a.txt');
    expect(gone.files.size).toBe(0);
  });

  it('queries names with quotes safely, and reads nothing from the environment', async () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/attacker/key.json');
    const seen: Request[] = []; const store = drive(emulator(seen).fetch);
    // A key shaped to break out of the quoted name and widen the query.
    const key = "it's' or name != 'x.txt";
    await store.put(key, new TextEncoder().encode('x'));
    await store.put('other.txt', new TextEncoder().encode('other'));
    expect(new TextDecoder().decode((await store.get(key))!.data)).toBe('x');
    expect(new URL(seen[0]!.url).searchParams.get('q')).toBe(`'${folderId}' in parents and trashed = false and name = 'it\\'s\\' or name != \\'x.txt'`);
    expect(seen.every(request => request.headers.get('authorization') === 'Bearer fixture-token' && request.url.startsWith('http://127.0.0.1:1/'))).toBe(true);
  });

  it('refuses metadata longer than Drive keeps, a folder too large to list, and a failing token source before sending', async () => {
    const store = drive(emulator().fetch);
    await expect(store.put('a', new Uint8Array(1), { metadata: { note: 'x'.repeat(200) } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const small = drive(emulator().fetch, { maxFolderFiles: 2 });
    for (const name of ['a', 'b', 'c']) await small.put(name, new Uint8Array(1));
    await expect(small.list()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    let sent = 0; const counting = (async () => { sent++; return new Response(null, { status: 500 }); }) as unknown as typeof globalThis.fetch;
    await expect(createFileStore(googleDriveFiles({ token: () => { throw new Error('SECRET'); }, folderId, fetch: counting }), { maxFileBytes: 64 }).head('a')).rejects.toMatchObject({ reason: 'authentication' });
    expect(sent).toBe(0);
  });

  it('needs a token source, a folder and an https endpoint (or http on this machine)', () => {
    const invalid = expect.objectContaining({ code: 'INVALID_CONFIG' });
    expect(() => googleDriveFiles({ token, folderId: "x' or '1'='1" })).toThrow(invalid);
    expect(() => googleDriveFiles({ token: 'secret' as never, folderId })).toThrow(invalid);
    expect(() => googleDriveFiles({ token, folderId, endpoint: 'http://drive.internal' })).toThrow(invalid);
    expect(() => googleDriveFiles({ token, folderId: 'appDataFolder' })).not.toThrow();
  });
});
