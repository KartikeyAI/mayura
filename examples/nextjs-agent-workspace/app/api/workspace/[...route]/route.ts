import { createPrototypeServer } from '../../../../../ui-ag-ui-prototype/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const port = Number(process.env.MAYURA_WORKSPACE_PORT ?? '4190');
if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error('Invalid local workspace port.');
const host = '127.0.0.1:' + port;
const origin = 'http://' + host;
const apiPrefix = '/api/workspace';
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const history = new RegExp(`^/history(?:/${uuid})?$`, 'u');
const cancel = new RegExp(`^/v1/runs/${uuid}/cancel$`, 'u');
const noStore = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

let service: Promise<{ server: Awaited<ReturnType<typeof createPrototypeServer>>; token: string }> | undefined;

async function startService() {
  const server = await createPrototypeServer(origin);
  try {
    const response = await server.fetch(new Request(new URL('/session', origin)));
    const session = await response.json() as { token?: unknown };
    if (!response.ok || typeof session.token !== 'string') throw new Error('Could not initialize the local session.');
    return { server, token: session.token };
  } catch (error) {
    await server.close();
    throw error;
  }
}

/** The local demo keeps its bearer credential on the server and accepts only known same-origin routes. */
async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const browserOrigin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (request.headers.get('host') !== host || (browserOrigin !== null && browserOrigin !== origin)
    || (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none')) {
    return new Response(null, { status: 403, headers: noStore });
  }
  const path = url.pathname.slice(apiPrefix.length);
  if (path !== '/ag-ui' && (url.search || !(request.method === 'GET' ? history.test(path) : cancel.test(path)))) {
    return new Response(null, { status: 404, headers: noStore });
  }
  const { server, token } = await (service ??= startService().catch(error => {
    service = undefined;
    throw error;
  }));
  const headers = new Headers({ Authorization: 'Bearer ' + token });
  for (const name of ['origin', 'sec-fetch-site', 'content-type', 'accept']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const init: RequestInit & { duplex?: 'half' } = { headers, method: request.method, signal: request.signal };
  if (request.body) {
    init.body = request.body;
    init.duplex = 'half';
  }
  return server.fetch(new Request(new URL(path + url.search, origin), init));
}

export const GET = handle;
export const POST = handle;
