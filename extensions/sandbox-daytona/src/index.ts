import { MayuraError } from 'mayura';
import {
  SandboxError, sandboxHttpFailure, sandboxResponseFailure, sandboxScripts,
  type BackendExecResult, type ProviderSandboxSpec, type SandboxBackend, type SandboxDesktop, type SandboxEntry, type SandboxProvider,
} from 'mayura/sandbox';

export interface DaytonaSandboxOptions {
  /** A Daytona API key. Nothing is read from the environment. */
  readonly apiKey: string;
  /** The organization, when the key can act for several. */
  readonly organizationId?: string;
  /** The snapshot sandboxes start from; Daytona's default by default. A sandbox's own `image` overrides it. */
  readonly snapshot?: string;
  /** The region (Daytona's `target`), such as `us` or `eu`. */
  readonly target?: string;
  /** The working directory; the default user's home, `/home/daytona`, by default. */
  readonly workdir?: string;
  /**
   * Give sandboxes a desktop through Daytona's computer use (screenshots, mouse and keyboard). The snapshot must have
   * computer use; off by default.
   */
  readonly desktop?: boolean;
  /** The longest lifetime, as your organization allows it; 24 hours by default. */
  readonly maxLifetimeMs?: number;
  /** Daytona's API; `https://app.daytona.io/api` by default. */
  readonly apiUrl?: string;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
}

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const environmentScript = (env: Readonly<Record<string, string>>) => Object.entries(env).map(([name, value]) => `export ${name}=${quote(value)}\n`).join('');
const viewPort = 6080;
/** Waits `ms`, or fails with `timeout` when `signal` aborts first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new SandboxError('timeout')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new SandboxError('timeout')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs a command with its output in files, so only as much of it as is kept is ever read back. $1, $2: the stdout and
 * stderr files; $3: a file of standard input, or `-`; $4: a file of the command's environment (read and removed before
 * the command starts), or `-`; $5: the directory; the command follows.
 */
const execScript = [
  'exec >"$1" 2>"$2"',
  '_mayura_in=$3; _mayura_env=$4',
  'cd -- "$5" || exit',
  'shift 5',
  'if [ "$_mayura_env" != - ]; then _mayura_e=$(cat -- "$_mayura_env"); rm -f -- "$_mayura_env"; eval "$_mayura_e"; unset _mayura_e; fi',
  'if [ "$_mayura_in" = - ]; then exec "$@" </dev/null; fi',
  'exec "$@" <"$_mayura_in"',
].join('\n');

/**
 * Daytona sandboxes (daytona.io), over Daytona's REST and toolbox APIs with fetch and no dependencies. Give the result to
 * `createSandboxes` from `mayura/sandbox`.
 */
export function daytonaSandboxes(options: DaytonaSandboxOptions): SandboxProvider {
  if (!options || typeof options.apiKey !== 'string' || !/^[!-~]{8,1024}$/u.test(options.apiKey)) throw new MayuraError('INVALID_CONFIG', 'daytonaSandboxes(): apiKey must be a Daytona API key.');
  const apiKey = options.apiKey;
  for (const [name, value] of [['organizationId', options.organizationId], ['target', options.target]] as const) {
    if (value !== undefined && (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value))) throw new MayuraError('INVALID_CONFIG', `daytonaSandboxes(): ${name} must be a Daytona id.`);
  }
  if (options.snapshot !== undefined && (typeof options.snapshot !== 'string' || !/^[!-~]{1,256}$/u.test(options.snapshot))) throw new MayuraError('INVALID_CONFIG', 'daytonaSandboxes(): snapshot must be a snapshot id or name.');
  const workdir = options.workdir ?? '/home/daytona';
  if (typeof workdir !== 'string' || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(workdir) || workdir.split('/').some(part => part === '.' || part === '..')) {
    throw new MayuraError('INVALID_CONFIG', 'daytonaSandboxes(): workdir must be an absolute, normalized path.');
  }
  if (options.desktop !== undefined && typeof options.desktop !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'daytonaSandboxes(): desktop must be a boolean.');
  const maxLifetimeMs = options.maxLifetimeMs ?? 86_400_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 60_000 || maxLifetimeMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'daytonaSandboxes(): maxLifetimeMs is 1 minute to about 24 days.');
  const apiUrl = (() => {
    try { const url = new URL(options.apiUrl ?? 'https://app.daytona.io/api'); if (url.protocol !== 'https:') throw new Error(); return url.href.replace(/\/$/u, ''); }
    catch { throw new MayuraError('INVALID_CONFIG', 'daytonaSandboxes(): apiUrl must be an https URL.'); }
  })();
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'daytonaSandboxes(): fetch must be a function.');
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${apiKey}`, ...(options.organizationId ? { 'x-daytona-organization-id': options.organizationId } : {}), ...extra });
  const json = { 'content-type': 'application/json' };

  const create = async (spec: ProviderSandboxSpec, { signal }: { readonly signal: AbortSignal }): Promise<SandboxBackend> => {
    if (spec.memoryMiB !== undefined && spec.memoryMiB % 1_024 !== 0) throw new MayuraError('INVALID_INPUT', 'Daytona gives memory in whole GiB.');
    if (spec.cpus !== undefined && !Number.isSafeInteger(spec.cpus)) throw new MayuraError('INVALID_INPUT', 'Daytona gives whole CPUs.');
    if (spec.image !== undefined && !/^[!-~]{1,256}$/u.test(spec.image)) throw new MayuraError('INVALID_INPUT', 'image must be a Daytona snapshot id or name.');
    const snapshot = spec.image ?? options.snapshot;
    const name = `mayura-${randomHex(12)}`;
    const network = spec.network === 'none' ? { networkBlockAll: true } : spec.network === 'all' ? { networkBlockAll: false } : { networkBlockAll: false, domainAllowList: spec.network.allow.join(',') };
    const response = await fetcher(`${apiUrl}/sandbox`, { method: 'POST', signal, headers: headers(json), body: JSON.stringify({
      name, ...(snapshot ? { snapshot } : {}), ...(options.target ? { target: options.target } : {}), env: spec.env, labels: spec.labels,
      // Nothing is public: port URLs are signed, and carry their own access.
      public: false, ...network,
      ...(spec.cpus === undefined ? {} : { cpu: spec.cpus }), ...(spec.memoryMiB === undefined ? {} : { memory: spec.memoryMiB / 1_024 }),
      // The lifetime is Daytona's time to live, after which it destroys the sandbox; it is never stopped for being idle,
      // and is deleted if it stops.
      ttlMinutes: Math.ceil(spec.lifetimeMs / 60_000), autoStopInterval: 0, autoDeleteInterval: 0,
    }) });
    // 404 here is a missing snapshot or organization, not a sandbox that ended.
    if (response.status === 404) { void response.body?.cancel().catch(() => undefined); throw new SandboxError('rejected', 404); }
    if (response.status !== 200 && response.status !== 201) throw sandboxResponseFailure(response);
    let sandbox = await response.json().catch(() => undefined) as { id?: unknown; state?: unknown; toolboxProxyUrl?: unknown } | undefined;
    const id = sandbox?.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new SandboxError('invalid_response');
    const release = async (callSignal: AbortSignal) => {
      const reply = await fetcher(`${apiUrl}/sandbox/${id}`, { method: 'DELETE', signal: callSignal, headers: headers() });
      void reply.body?.cancel().catch(() => undefined);
      if (reply.status !== 200 && reply.status !== 204 && reply.status !== 404) throw sandboxHttpFailure(reply.status);
    };
    try {
      // A sandbox is created, then started; wait for it.
      for (let delay = 250; sandbox?.state !== 'started'; delay = Math.min(delay * 1.5, 2_000)) {
        if (['error', 'build_failed', 'destroyed', 'destroying'].includes(String(sandbox?.state))) throw new SandboxError('rejected');
        await sleep(delay, signal);
        const reply = await fetcher(`${apiUrl}/sandbox/${id}`, { signal, headers: headers() });
        if (reply.status !== 200) throw sandboxResponseFailure(reply);
        sandbox = await reply.json().catch(() => undefined) as typeof sandbox;
      }
      if (options.desktop) {
        const reply = await toolboxCall('POST', '/computeruse/start', signal);
        void reply.body?.cancel().catch(() => undefined);
        if (reply.status !== 200) throw sandboxHttpFailure(reply.status);
      }
    } catch (error) {
      await release(AbortSignal.timeout(30_000)).catch(() => undefined);
      throw error;
    }

    function toolboxBase(): string {
      const proxy = typeof sandbox?.toolboxProxyUrl === 'string' ? sandbox.toolboxProxyUrl : 'https://proxy.app.daytona.io/toolbox';
      try { const url = new URL(proxy); if (url.protocol !== 'https:') throw new Error(); return `${url.href.replace(/\/$/u, '')}/${id}`; }
      catch { throw new SandboxError('invalid_response'); }
    }
    function toolboxCall(method: string, path: string, callSignal: AbortSignal, init: { readonly body?: BodyInit; readonly headers?: Record<string, string> } = {}) {
      return fetcher(`${toolboxBase()}${path}`, { method, signal: callSignal, headers: headers(init.headers), ...(init.body === undefined ? {} : { body: init.body }) });
    }
    const toolboxJson = async (method: string, path: string, callSignal: AbortSignal, body?: unknown): Promise<unknown> => {
      const reply = await toolboxCall(method, path, callSignal, body === undefined ? {} : { body: JSON.stringify(body), headers: json });
      if (reply.status !== 200 && reply.status !== 201 && reply.status !== 202 && reply.status !== 204) throw sandboxResponseFailure(reply);
      return reply.status === 204 ? undefined : reply.json().catch(() => undefined);
    };
    const upload = async (path: string, data: Uint8Array, callSignal: AbortSignal) => {
      const form = new FormData();
      form.append('file', new Blob([data as Uint8Array<ArrayBuffer>]), path.slice(path.lastIndexOf('/') + 1) || 'file');
      const reply = await toolboxCall('POST', `/files/upload-v2?path=${encodeURIComponent(path)}`, callSignal, { body: form });
      void reply.body?.cancel().catch(() => undefined);
      if (reply.status === 400) throw new MayuraError('INVALID_INPUT', 'That path cannot be written.');
      if (reply.status !== 200 && reply.status !== 201) throw sandboxHttpFailure(reply.status);
    };
    /** The start of a file: at most `max` bytes, and whether there was more. Undefined when there is none. */
    const download = async (path: string, max: number, callSignal: AbortSignal): Promise<{ data: Uint8Array; more: boolean } | undefined> => {
      const reply = await toolboxCall('GET', `/files/download?path=${encodeURIComponent(path)}`, callSignal);
      if (reply.status === 404) { void reply.body?.cancel().catch(() => undefined); return undefined; }
      if (reply.status === 400) { void reply.body?.cancel().catch(() => undefined); throw new MayuraError('INVALID_INPUT', 'That path is not a file.'); }
      if (reply.status !== 200) throw sandboxResponseFailure(reply);
      if (!reply.body) return { data: new Uint8Array(0), more: false };
      const chunks: Uint8Array[] = []; let kept = 0; let more = false; const reader = reply.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const room = max - kept;
          if (value.byteLength > room) { more = true; if (room > 0) { chunks.push(value.subarray(0, room)); kept += room; } await reader.cancel().catch(() => undefined); break; }
          chunks.push(value); kept += value.byteLength;
        }
      } finally { reader.releaseLock(); }
      const data = new Uint8Array(kept); let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
      return { data, more };
    };
    const removeQuietly = (path: string) => toolboxCall('DELETE', `/files?path=${encodeURIComponent(path)}`, AbortSignal.timeout(30_000))
      .then(reply => reply.body?.cancel(), () => undefined).catch(() => undefined);

    const desktop: SandboxDesktop | undefined = options.desktop ? {
      size: async ({ signal: callSignal }) => {
        const info = await toolboxJson('GET', '/computeruse/display/info', callSignal) as { displays?: { width?: unknown; height?: unknown; isActive?: unknown }[] } | undefined;
        const display = info?.displays?.find(item => item.isActive) ?? info?.displays?.[0];
        if (!display || !Number.isSafeInteger(display.width) || !Number.isSafeInteger(display.height)) throw new SandboxError('invalid_response');
        return { width: display.width as number, height: display.height as number };
      },
      screenshot: async ({ signal: callSignal }) => {
        const shot = await toolboxJson('GET', '/computeruse/screenshot?showCursor=true', callSignal) as { screenshot?: unknown } | undefined;
        if (typeof shot?.screenshot !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(shot.screenshot)) throw new SandboxError('invalid_response');
        const binary = atob(shot.screenshot); const data = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
        return { data, mediaType: data[0] === 0xff ? 'image/jpeg' as const : 'image/png' as const };
      },
      click: async (x, y, { button, double, signal: callSignal }) => { await toolboxJson('POST', '/computeruse/mouse/click', callSignal, { x, y, button, double }); },
      move: async (x, y, { signal: callSignal }) => { await toolboxJson('POST', '/computeruse/mouse/move', callSignal, { x, y }); },
      scroll: async (x, y, { dx, dy, signal: callSignal }) => {
        // Daytona scrolls up and down only.
        if (dx !== 0) throw new MayuraError('INVALID_INPUT', 'Daytona desktops scroll up and down only.');
        if (dy !== 0) await toolboxJson('POST', '/computeruse/mouse/scroll', callSignal, { x, y, direction: dy > 0 ? 'down' : 'up', amount: Math.abs(dy) });
      },
      type: async (text, { signal: callSignal }) => { await toolboxJson('POST', '/computeruse/keyboard/type', callSignal, { text }); },
      key: async (keys, { signal: callSignal }) => {
        if (keys.includes('+')) await toolboxJson('POST', '/computeruse/keyboard/hotkey', callSignal, { keys: keys.toLowerCase() });
        else await toolboxJson('POST', '/computeruse/keyboard/key', callSignal, { key: keys.toLowerCase() });
      },
      viewUrl: async ({ signal: callSignal }) => `${(await signedUrl(viewPort, callSignal)).replace(/\/$/u, '')}/vnc.html?autoconnect=true&resize=scale`,
    } : undefined;
    const createdAt = Date.now();
    async function signedUrl(port: number, callSignal: AbortSignal): Promise<string> {
      // Valid while the sandbox lives.
      const expires = Math.max(60, Math.min(86_400, Math.ceil((createdAt + spec.lifetimeMs - Date.now()) / 1_000)));
      const reply = await fetcher(`${apiUrl}/sandbox/${id}/ports/${port}/signed-preview-url?expiresInSeconds=${expires}`, { signal: callSignal, headers: headers() });
      if (reply.status !== 200) throw sandboxResponseFailure(reply);
      const signed = await reply.json().catch(() => undefined) as { url?: unknown } | undefined;
      if (typeof signed?.url !== 'string') throw new SandboxError('invalid_response');
      return signed.url;
    }

    return {
      id,
      exec: async (command, execOptions): Promise<BackendExecResult> => {
        const tag = randomHex(12); const base = `/tmp/mayura-${tag}`;
        const files = { out: `${base}.out`, err: `${base}.err`, in: `${base}.in`, env: `${base}.env` };
        const stdin = execOptions.stdin?.byteLength ? execOptions.stdin : undefined;
        const hasEnv = Object.keys(execOptions.env).length > 0;
        const session = `mayura-${tag}`;
        let stopped = false;
        try {
          if (stdin) await upload(files.in, stdin, execOptions.signal);
          if (hasEnv) await upload(files.env, new TextEncoder().encode(environmentScript(execOptions.env)), execOptions.signal);
          await toolboxJson('POST', '/process/session', execOptions.signal, { sessionId: session });
          const line = [`${sandboxScripts.tagVariable}=${tag}`, 'sh', '-c', quote(execScript), 'mayura', quote(files.out), quote(files.err), quote(stdin ? files.in : '-'),
            quote(hasEnv ? files.env : '-'), quote(execOptions.cwd), ...command.map(quote)].join(' ');
          const started = await toolboxJson('POST', `/process/session/${session}/exec`, execOptions.signal, { command: line, runAsync: true }) as { cmdId?: unknown } | undefined;
          const cmdId = started?.cmdId;
          if (typeof cmdId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(cmdId)) throw new SandboxError('invalid_response');
          let exitCode: number | undefined;
          for (let delay = 100; exitCode === undefined; delay = Math.min(delay * 1.5, 1_000)) {
            await sleep(delay, execOptions.signal);
            const status = await toolboxJson('GET', `/process/session/${session}/command/${cmdId}`, execOptions.signal) as { exitCode?: unknown } | undefined;
            if (typeof status?.exitCode === 'number') exitCode = status.exitCode;
          }
          const [out, err] = await Promise.all([download(files.out, execOptions.maxOutputBytes, execOptions.signal), download(files.err, execOptions.maxOutputBytes, execOptions.signal)]);
          return { exitCode, stdout: out?.data ?? new Uint8Array(0), stderr: err?.data ?? new Uint8Array(0), truncated: (out?.more ?? false) || (err?.more ?? false) };
        } catch (error) {
          if (!execOptions.signal.aborted) throw error;
          stopped = true;
          // Ending the call ends the command: every process carrying its tag is killed, then what it wrote is read.
          const kill = AbortSignal.timeout(8_000);
          await toolboxJson('POST', '/process/execute', kill, { command: ['sh', '-c', quote(sandboxScripts.kill), 'mayura', tag].join(' '), timeout: 5 }).catch(() => undefined);
          const [out, err] = await Promise.all([download(files.out, execOptions.maxOutputBytes, kill).catch(() => undefined), download(files.err, execOptions.maxOutputBytes, kill).catch(() => undefined)]);
          return { stdout: out?.data ?? new Uint8Array(0), stderr: err?.data ?? new Uint8Array(0), truncated: (out?.more ?? false) || (err?.more ?? false) };
        } finally {
          void toolboxCall('DELETE', `/process/session/${session}`, AbortSignal.timeout(30_000)).then(reply => reply.body?.cancel(), () => undefined).catch(() => undefined);
          for (const path of [files.out, files.err, ...(stdin ? [files.in] : []), ...(hasEnv && stopped ? [files.env] : [])]) void removeQuietly(path);
        }
      },
      readFile: async (path, { maxBytes, signal: callSignal }) => {
        const file = await download(path, maxBytes, callSignal);
        if (file?.more) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxBytes} bytes.`);
        return file?.data;
      },
      writeFile: async (path, data, { signal: callSignal }) => {
        const parent = path.slice(0, path.lastIndexOf('/')) || '/';
        if (parent !== '/') await toolboxJson('POST', `/files/folder?path=${encodeURIComponent(parent)}&mode=0755`, callSignal);
        await upload(path, data, callSignal);
      },
      listFiles: async (path, { limit, signal: callSignal }) => {
        const reply = await toolboxCall('GET', `/files?path=${encodeURIComponent(path)}&depth=1`, callSignal);
        if (reply.status === 404) { void reply.body?.cancel().catch(() => undefined); return undefined; }
        if (reply.status === 400) { void reply.body?.cancel().catch(() => undefined); throw new MayuraError('INVALID_INPUT', 'That path is not a directory.'); }
        if (reply.status !== 200) throw sandboxResponseFailure(reply);
        const entries = await reply.json().catch(() => undefined) as unknown;
        if (!Array.isArray(entries)) throw new SandboxError('invalid_response');
        return entries.slice(0, limit).map((entry: { name?: unknown; isDir?: unknown; size?: unknown; modifiedAt?: unknown }): SandboxEntry => {
          if (typeof entry?.name !== 'string') throw new SandboxError('invalid_response');
          const directory = entry.isDir === true; const modified = typeof entry.modifiedAt === 'string' ? Date.parse(entry.modifiedAt) : Number.NaN;
          return { name: entry.name, type: directory ? 'directory' : 'file', size: directory || !Number.isSafeInteger(entry.size) ? 0 : entry.size as number,
            ...(Number.isFinite(modified) ? { modified } : {}) };
        });
      },
      removeFile: async (path, { recursive, signal: callSignal }) => {
        if (!recursive) {
          // A directory goes only when it is empty: check first, as Daytona's delete may take what is in it.
          const reply = await toolboxCall('GET', `/files?path=${encodeURIComponent(path)}&depth=1`, callSignal);
          if (reply.status === 404) { void reply.body?.cancel().catch(() => undefined); return; }
          if (reply.status === 200) {
            const entries = await reply.json().catch(() => undefined) as unknown;
            if (!Array.isArray(entries)) throw new SandboxError('invalid_response');
            if (entries.length > 0) throw new MayuraError('INVALID_INPUT', 'The directory is not empty; remove it with recursive.');
          } else void reply.body?.cancel().catch(() => undefined);
        }
        const reply = await toolboxCall('DELETE', `/files?path=${encodeURIComponent(path)}${recursive ? '&recursive=true' : ''}`, callSignal);
        void reply.body?.cancel().catch(() => undefined);
        if (reply.status !== 200 && reply.status !== 204 && reply.status !== 404) throw sandboxHttpFailure(reply.status);
      },
      url: (port, { signal: callSignal }) => signedUrl(port, callSignal),
      ...(desktop ? { desktop } : {}),
      release: ({ signal: callSignal }) => release(callSignal),
    };
  };

  return Object.freeze({
    id: 'daytona', workdir, maxLifetimeMs,
    features: Object.freeze({ stdin: true, ports: true, desktop: options.desktop === true, network: Object.freeze(['none', 'all', 'allowlist'] as const) }),
    create,
  });
}
