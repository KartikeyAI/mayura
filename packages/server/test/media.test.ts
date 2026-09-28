import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { media, type JsonObject, type Media, type ModelRequest, type Schema } from '@mayura/core';
import { defineAgent } from '@mayura/runtime';
import { createLocalArtifactStore, mediaFromArtifact } from '../../artifacts/src/index.js';
import { createClient, ClientError } from '../../client/src/index.js';
import { scriptedModel, testImage, testPdf } from '../../testing/src/index.js';
import { createAgentServer, type AgentServer, type AgentServerOptions, type ServerIdentity } from '../src/index.js';

// Images and PDFs over HTTP: base64, URLs or stored artifacts in a run submission, checked by the server with a
// precise refusal, part of the idempotency key, and sent by the client.

const publicOrigin = 'https://agents.example.test';
const schema: Schema<unknown> = { '~standard': { version: 1, vendor: 'test', validate: value => ({ value }) } };
const scope = { principalId: 'alice', projectId: 'project' };
const identity: ServerIdentity = { scope, agentIds: ['eyes', 'plain'], capabilities: ['runs:read', 'runs:submit'], expiresAtMs: Date.now() + 60_000 };
const servers: AgentServer[] = []; const folders: string[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
const png = (testImage() as Media & { data: Uint8Array }).data;
const base64 = Buffer.from(png).toString('base64');

function server(seen: ModelRequest[], options: Partial<AgentServerOptions> = {}): AgentServer {
  const model = scriptedModel(Array.from({ length: 8 }, () => (request: ModelRequest) => { seen.push(request); return { type: 'final' as const, output: 'seen', usage: { costMicros: 0 } }; }), { id: 'fixture' });
  const eyes = defineAgent({ id: 'eyes', version: '1', instructions: 'Look.', tools: [], input: schema, output: schema, model, media: { accept: ['image/png'], urls: ['https://cdn.example.com/'] } });
  const plain = defineAgent({ id: 'plain', version: '1', instructions: 'Read.', tools: [], input: schema, output: schema, model });
  const value = createAgentServer({ publicOrigin, authenticate: async () => identity, ...options,
    agents: [{ agent: eyes, permissions: { allow: ['model:fixture'] } }, { agent: plain, permissions: { allow: ['model:fixture'] } }] });
  servers.push(value); return value;
}
const submit = (value: AgentServer, body: JsonObject, key = 'key-1') => value.fetch(new Request(new URL('/v1/runs', publicOrigin), { method: 'POST',
  headers: { authorization: 'Bearer TOKEN', 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) }));
const error = async (response: Response) => ({ status: response.status, ...((await response.json()) as { error: JsonObject }).error });
const until = async (check: () => boolean): Promise<void> => { for (let tries = 0; tries < 200 && !check(); tries++) await new Promise(resolve => setTimeout(resolve, 5)); };

describe('run submissions with media', () => {
  it('pass base64 images and allowed URLs to the agent, and make them part of the idempotency key', async () => {
    const seen: ModelRequest[] = []; const value = server(seen);
    const item = { mediaType: 'image/png', data: base64, name: 'shot.png' };
    expect((await submit(value, { agentId: 'eyes', input: { q: 1 }, media: [item, { mediaType: 'image/png', url: 'https://cdn.example.com/a.png' }] })).status).toBe(202);
    await until(() => seen.length === 1);
    const sent = (seen[0]!.messages[0] as { media: readonly Media[] }).media;
    expect(sent.map(entry => ('data' in entry ? [entry.name, [...entry.data]] : [entry.url]))).toEqual([['shot.png', [...png]], ['https://cdn.example.com/a.png']]);
    // The same key with the same media replays; with different media it conflicts.
    expect((await submit(value, { agentId: 'eyes', input: { q: 1 }, media: [item, { mediaType: 'image/png', url: 'https://cdn.example.com/a.png' }] })).status).toBe(200);
    expect(await error(await submit(value, { agentId: 'eyes', input: { q: 1 }, media: [item] }))).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('refuse media with a message that says exactly what is wrong', async () => {
    const value = server([]);
    expect(await error(await submit(value, { agentId: 'plain', input: 1, media: [{ mediaType: 'image/png', data: base64 }] })))
      .toMatchObject({ status: 400, code: 'INVALID_MEDIA', message: 'Agent plain: media is not accepted here; declare which types are accepted with `media: { accept: [...] }`.' });
    expect(await error(await submit(value, { agentId: 'eyes', input: 1, media: [{ mediaType: 'image/jpeg', data: base64 }] }, 'k2')))
      .toMatchObject({ code: 'INVALID_MEDIA', message: 'media 1: These bytes are image/png, not image/jpeg.' });
    expect(await error(await submit(value, { agentId: 'eyes', input: 1, media: [{ mediaType: 'image/svg+xml', data: base64 }] }, 'k3')))
      .toMatchObject({ code: 'INVALID_MEDIA', message: expect.stringContaining('mediaType must be one of image/png') });
    expect(await error(await submit(value, { agentId: 'eyes', input: 1, media: [{ mediaType: 'image/png', url: 'https://evil.example.com/a.png' }] }, 'k4')))
      .toMatchObject({ code: 'INVALID_MEDIA', message: expect.stringContaining('not under an allowed URL prefix') });
    expect(await error(await submit(value, { agentId: 'eyes', input: 1, media: [{ mediaType: 'image/png', data: base64, extra: true }] }, 'k5')))
      .toMatchObject({ code: 'INVALID_MEDIA', message: expect.stringContaining('must have mediaType with data') });
    expect(await error(await submit(value, { agentId: 'eyes', input: 1, media: [{ artifact: {} }] }, 'k6'))).toMatchObject({ status: 404, code: 'NOT_ENABLED', option: 'mediaArtifacts' });
  });

  it('accept bodies above maxBodyBytes only when an agent takes media', async () => {
    const big = new Uint8Array(1_200_000); big.set(png);
    const item = { mediaType: 'image/png', data: Buffer.from(big).toString('base64') };
    expect((await submit(server([]), { agentId: 'eyes', input: 1, media: [item] })).status).toBe(202);
    expect(await error(await submit(server([], { limits: { maxMediaBodyBytes: 1_048_576 } }), { agentId: 'eyes', input: 1, media: [item] })))
      .toMatchObject({ status: 413, code: 'BODY_TOO_LARGE' });
  });

  it('read stored artifacts for the caller\'s scope', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'mayura-media-')); folders.push(folder);
    const store = createLocalArtifactStore({ rootDirectory: folder, maxArtifactBytes: 1_048_576 });
    const reference = await store.commit(await store.stage({ scope, content: png, mediaType: 'image/png', classification: 'internal', filename: 'stored.png' }));
    const seen: ModelRequest[] = [];
    const value = server(seen, { mediaArtifacts: (ref, callerScope) => mediaFromArtifact(store, ref, callerScope) });
    expect((await submit(value, { agentId: 'eyes', input: 1, media: [{ artifact: reference as unknown as JsonObject }] })).status).toBe(202);
    await until(() => seen.length === 1);
    expect((seen[0]!.messages[0] as { media: readonly Media[] }).media[0]).toMatchObject({ mediaType: 'image/png', name: 'stored.png' });
    // Another project's caller cannot read it.
    const other = server([], { authenticate: async () => ({ ...identity, scope: { principalId: 'bob', projectId: 'other' } }), mediaArtifacts: (ref, callerScope) => mediaFromArtifact(store, ref, callerScope) });
    expect(await error(await submit(other, { agentId: 'eyes', input: 1, media: [{ artifact: reference as unknown as JsonObject }] })))
      .toMatchObject({ code: 'INVALID_MEDIA', message: 'media 1: the artifact could not be read for this caller.' });
  });
});

describe('the client', () => {
  it('sends media as base64 or URLs, and refuses what it cannot send', async () => {
    const seen: ModelRequest[] = []; const value = server(seen);
    const client = createClient({ baseUrl: publicOrigin, token: () => 'TOKEN', fetch: (input, init) => value.fetch(new Request(input, init)) });
    await client.submit('eyes', { q: 1 }, { idempotencyKey: 'client-1', media: [media(png, 'image/png', { name: 'a.png' })] });
    await until(() => seen.length === 1);
    expect((seen[0]!.messages[0] as { media: readonly Media[] }).media[0]).toMatchObject({ mediaType: 'image/png', name: 'a.png' });
    await expect(client.submit('eyes', 1, { idempotencyKey: 'client-2', media: [testPdf()] })).rejects.toMatchObject({ code: 'INVALID_MEDIA', status: 400 });
    await expect(client.submit('eyes', 1, { idempotencyKey: 'client-3', media: [{ mediaType: 'image/png' } as never] })).rejects.toBeInstanceOf(ClientError);
    const small = createClient({ baseUrl: publicOrigin, token: () => 'TOKEN', maxMediaBytes: 100, fetch: (input, init) => value.fetch(new Request(input, init)) });
    await expect(small.submit('eyes', 1, { idempotencyKey: 'client-4', media: [testImage()] })).rejects.toMatchObject({ code: 'INVALID_MEDIA' });
  });
});
