import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const docker = promisify(execFile);
const encoder = new TextEncoder();
const sse = (event: string, data: string) => encoder.encode(`event: ${event}\ndata: ${data}\n\n`);

export interface Seen { readonly method: string; readonly url: URL; readonly headers: Headers; readonly json?: Record<string, unknown> }
/**
 * The sandbox bridge's HTTP API, answering in its wire formats. Commands run by `run`: their output, exit code (or
 * `hang`), and in which events. With `container`, sandboxes are a local container and commands run in it for real.
 */
export function fakeBridge(options: {
  readonly container?: string;
  readonly run?: (argv: string[], cwd: string) => { stdout?: string; stderr?: string; exitCode?: number; hang?: boolean; error?: boolean; raw?: string };
  readonly create?: () => Response;
  readonly files?: Map<string, Uint8Array>;
} = {}) {
  const seen: Seen[] = []; const execs: { argv: string[]; cwd: string }[] = []; const files = options.files ?? new Map<string, Uint8Array>();
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    const json = request.headers.get('content-type') === 'application/json' && body.byteLength ? JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown> : undefined;
    seen.push({ method: request.method, url, headers: request.headers, ...(json ? { json } : {}) });
    if (request.headers.get('authorization') !== 'Bearer bridge_test_key') return Response.json({ error: 'unauthorized' }, { status: 401 });
    const path = url.pathname;
    if (path === '/v1/sandbox' && request.method === 'POST') return options.create?.() ?? Response.json({ id: 'sbx-cf-1' });
    if (path === '/v1/sandbox/sbx-cf-1' && request.method === 'DELETE') return new Response(null, { status: 204 });
    if (path.startsWith('/v1/sandbox/sbx-cf-1/file/') && request.method === 'PUT') {
      const name = decodeURIComponent(path.slice('/v1/sandbox/sbx-cf-1/file/'.length));
      if (name.includes('..')) return Response.json({ error: 'outside /workspace' }, { status: 400 });
      if (options.container) {
        const child = spawn('docker', ['exec', '-i', options.container, 'sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'x', `/workspace/${name}`], { windowsHide: true });
        child.stdin.end(body); await new Promise(resolve => child.on('close', resolve));
      } else files.set(`/workspace/${name}`, body);
      return Response.json({ ok: true });
    }
    if (path === '/v1/sandbox/sbx-cf-1/exec' && request.method === 'POST') {
      const { argv, cwd } = json as { argv: string[]; cwd: string };
      execs.push({ argv, cwd });
      if (options.container) {
        const child = spawn('docker', ['exec', '-w', cwd, options.container, ...argv], { windowsHide: true });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            child.stdout.on('data', (chunk: Buffer) => controller.enqueue(sse('stdout', chunk.toString('base64'))));
            child.stderr.on('data', (chunk: Buffer) => controller.enqueue(sse('stderr', chunk.toString('base64'))));
            child.on('close', code => { try { controller.enqueue(sse('exit', JSON.stringify({ exit_code: code ?? -1 }))); controller.close(); } catch { /* the reader went away */ } });
          },
          cancel() { child.kill(); },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      const answer = options.run?.(argv, cwd) ?? { exitCode: 0 };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (answer.raw !== undefined) { controller.enqueue(encoder.encode(answer.raw)); if (!answer.hang) controller.close(); return; }
          if (answer.stdout) controller.enqueue(sse('stdout', btoa(answer.stdout)));
          if (answer.stderr) controller.enqueue(sse('stderr', btoa(answer.stderr)));
          if (answer.hang) return;
          controller.enqueue(answer.error ? sse('error', JSON.stringify({ message: 'secret detail from cloudflare', code: 'X' })) : sse('exit', JSON.stringify({ exit_code: answer.exitCode ?? 0 })));
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, seen, execs, files };
}

export async function startContainer(image: string): Promise<{ name: string; stop: () => Promise<void> }> {
  const name = `mayura-cf-test-${Math.random().toString(16).slice(2, 10)}`;
  await docker('docker', ['run', '-d', '--rm', '--pull', 'never', '--network', 'none', '--name', name, '--label', 'mayura.sandbox=cf-test', image, 'sh', '-c', 'mkdir -p /workspace && sleep 600'], { windowsHide: true });
  return { name, stop: async () => { await docker('docker', ['rm', '-f', name], { windowsHide: true }).catch(() => undefined); } };
}
