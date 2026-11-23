import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { createAdaptorServer, upgradeWebSocket, type WebSocketServerLike } from '@hono/node-server';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { validator } from 'hono/validator';
import { describe, expect, it, vi } from 'vitest';

function pending() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Hono request boundaries', () => {
  it.each(['release notes', 'release%20notes', 'folder\\notes'])('preserves %s as one document name', async name => {
    const app = new Hono();
    app.get('/documents/:name', c => c.json({ name: c.req.param('name') }));
    app.get('/documents/:folder/:name', c => c.text('nested document'));

    const response = await app.request(`/documents/${encodeURIComponent(name)}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name });
  });

  it('keeps nested wildcard routes inside mounted middleware and leaves adjacent public routes accessible', async () => {
    const workspace = new Hono();
    const serveAsset = vi.fn();
    workspace.use('/:team/*', async (c, next) => {
      if (c.req.header('authorization') !== 'Bearer fixture') return c.text('Unauthorized', 401);
      await next();
    });
    workspace.get('/:team/assets/*', c => {
      serveAsset();
      return c.text('private asset');
    });
    const app = new Hono();
    app.route('/workspaces', workspace);
    app.get('/workspaces-public/assets/*', c => c.text('public asset'));

    const asset = '/workspaces/design/assets/images/icon';
    expect((await app.request(asset)).status).toBe(401);
    expect(serveAsset).not.toHaveBeenCalled();
    expect(await (await app.request(asset, { headers: { authorization: 'Bearer fixture' } })).text()).toBe('private asset');
    expect(serveAsset).toHaveBeenCalledOnce();
    expect(await (await app.request('/workspaces-public/assets/images/icon')).text()).toBe('public asset');
    expect((await app.request('/workspaces/design/asset-list')).status).toBe(401);
  });

  it('validates multipart text once and rejects ambiguous or malformed uploads', async () => {
    const app = new Hono();
    const accept = vi.fn();
    app.post('/uploads', validator('form', (form, c) => {
      const description = form.description;
      if (typeof description !== 'string' || description.trim() === '') return c.text('One description is required', 400);
      return { description };
    }), c => {
      accept(c.req.valid('form'));
      return c.text('Accepted', 201);
    });

    const form = new FormData();
    form.set('description', 'Release notes');
    expect((await app.request('/uploads', { method: 'POST', body: form })).status).toBe(201);
    expect(accept).toHaveBeenCalledWith({ description: 'Release notes' });

    form.append('description', 'Second description');
    expect((await app.request('/uploads', { method: 'POST', body: form })).status).toBe(400);
    form.set('description', new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    expect((await app.request('/uploads', { method: 'POST', body: form })).status).toBe(400);
    expect((await app.request('/uploads', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data' },
      body: 'incomplete upload',
    })).status).toBe(400);
    expect(accept).toHaveBeenCalledOnce();
  });

  it('checks the origin for text/ping requests before invoking the handler', async () => {
    const origin = 'https://workspace.test';
    const app = new Hono();
    const record = vi.fn();
    app.post('/activity', csrf(), c => {
      record();
      return c.body(null, 204);
    });
    const ping = (source: string) => app.request(`${origin}/activity`, {
      method: 'POST',
      headers: { origin: source, 'content-type': 'text/ping' },
      body: 'opened',
    });

    expect((await ping('https://another.test')).status).toBe(403);
    expect(record).not.toHaveBeenCalled();
    expect((await ping(origin)).status).toBe(204);
    expect(record).toHaveBeenCalledOnce();
  });

  it('handles a peer reset during a pending WebSocket upgrade without opening a session', async () => {
    class FixtureWebSocketServer extends EventEmitter implements WebSocketServerLike {
      options = { noServer: true };
      handleUpgrade = vi.fn<WebSocketServerLike['handleUpgrade']>();
      close = vi.fn();
    }
    const webSockets = new FixtureWebSocketServer();
    const peer = new PassThrough();
    const incomingSocket = new Socket();
    const incoming = new IncomingMessage(incomingSocket);
    incoming.url = '/events';
    incoming.headers = { host: 'workspace.test', upgrade: 'websocket', connection: 'Upgrade' };
    const started = pending();
    const proceed = pending();
    const dispatched = pending();
    const onOpen = vi.fn();
    const app = new Hono();
    app.get('/events', upgradeWebSocket(() => ({ onOpen })));
    app.get('/health', c => c.text('healthy'));
    const server = createAdaptorServer({
      overrideGlobalObjects: false,
      websocket: { server: webSockets },
      fetch: async (request, env) => {
        started.resolve();
        await proceed.promise;
        const response = await app.fetch(request, env);
        dispatched.resolve();
        return response;
      },
    });

    try {
      const closed = new Promise<void>(resolve => peer.once('close', resolve));
      server.emit('upgrade', incoming, peer, Buffer.alloc(0));
      await started.promise;
      peer.destroy(Object.assign(new Error('Fixture peer disconnected'), { code: 'ECONNRESET' }));
      await closed;
      proceed.resolve();
      await dispatched.promise;
      expect(webSockets.handleUpgrade).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
      expect(await (await app.request('/health')).text()).toBe('healthy');
    } finally {
      proceed.resolve();
      peer.destroy();
      incomingSocket.destroy();
      server.close();
    }
  });
});
