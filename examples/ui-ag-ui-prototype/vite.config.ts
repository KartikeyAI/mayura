import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { defineConfig, type Connect, type Plugin } from 'vite';
import { createPrototypeServer } from './server.js';

const host = '127.0.0.1';
const port = Number(process.env['MAYURA_UI_EXAMPLE_PORT'] ?? '4180');
if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error('MAYURA_UI_EXAMPLE_PORT must be a port between 1024 and 65535.');
const origin = 'http://' + host + ':' + port;
const endpoints = /^\/(?:session|ag-ui|history(?:\/[a-f0-9-]{36})?|v1\/runs\/[a-f0-9-]+\/cancel)(?:\?|$)/u;

function localAgent(): Plugin {
  const attach = (server: { middlewares: Connect.Server; httpServer: { once(event: 'close', listener: () => void): unknown } | null }) => {
    let agent: ReturnType<typeof createPrototypeServer> | undefined;
    server.httpServer?.once('close', () => {
      void agent?.then(value => value.close()).catch(() => undefined);
    });
    server.middlewares.use((req, res, next) => {
      if (!req.url || !endpoints.test(req.url)) { next(); return; }
      if (req.headers.host !== host + ':' + port) { res.writeHead(400).end(); return; }
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      const handle = async () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          for (const item of typeof value === 'string' ? [value] : value ?? []) headers.append(name, item);
        }
        const method = req.method ?? 'GET';
        const init: RequestInit & { duplex?: 'half' } = { method, headers, signal: controller.signal };
        const hasBody = Number(headers.get('content-length')) > 0 || headers.has('transfer-encoding');
        if (method !== 'GET' && method !== 'HEAD' && hasBody) {
          init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
          init.duplex = 'half';
        }
        const { fetch } = await (agent ??= Promise.resolve(createPrototypeServer(origin)));
        const response = await fetch(new Request(new URL(req.url!, origin), init));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (!response.body) { res.end(); return; }
        res.flushHeaders();
        await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), res, { signal: controller.signal });
      };
      void handle().catch(() => {
        if (controller.signal.aborted) return;
        if (res.headersSent) res.destroy();
        else res.writeHead(500, { 'Content-Type': 'text/plain' }).end('The local demo is unavailable.');
      });
    });
  };

  return { name: 'mayura-local-agent', configureServer: attach, configurePreviewServer: attach };
}

export default defineConfig({
  plugins: [localAgent()],
  server: { host, port, strictPort: true },
  preview: { host, port, strictPort: true },
});
