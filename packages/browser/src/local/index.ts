import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { MayuraError } from '@mayura/core';
import { BrowserError, type BrowserBackend, type BrowserProvider } from '../contracts.js';

export interface LocalBrowsersOptions {
  /** The browser to run: a path to Chrome, Chromium or Edge. Found among the usual install places by default. */
  readonly executablePath?: string;
  /** Which installed browser to look for without `executablePath`: `'chrome'` (also Chromium) by default, or `'edge'`. */
  readonly channel?: 'chrome' | 'edge';
  /** Run without a window; true by default. */
  readonly headless?: boolean;
  /** Further command-line switches, such as `--lang=en-US`. Switches that open the browser to others are refused. */
  readonly args?: readonly string[];
  /** The longest lifetime; 24 hours by default. */
  readonly maxLifetimeMs?: number;
}

const places = {
  chrome: {
    win32: ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].map(variable => [variable, 'Google\\Chrome\\Application\\chrome.exe'] as const),
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
    linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
  },
  edge: {
    win32: ['PROGRAMFILES(X86)', 'PROGRAMFILES', 'LOCALAPPDATA'].map(variable => [variable, 'Microsoft\\Edge\\Application\\msedge.exe'] as const),
    darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linux: ['microsoft-edge', 'microsoft-edge-stable'],
  },
} as const;

/** The installed browser of a channel, or undefined. */
export function findLocalBrowser(channel: 'chrome' | 'edge' = 'chrome'): string | undefined {
  const where = places[channel];
  if (process.platform === 'win32') {
    for (const [variable, path] of where.win32) { const base = process.env[variable]; if (base && existsSync(join(base, path))) return join(base, path); }
    return undefined;
  }
  if (process.platform === 'darwin') return where.darwin.find(path => existsSync(path));
  for (const name of where.linux) for (const directory of (process.env['PATH'] ?? '').split(delimiter)) if (directory && existsSync(join(directory, name))) return join(directory, name);
  return undefined;
}

/** Switches that would expose the browser beyond this process, or undo what keeps it contained. */
const refusedSwitch = /^--(?:remote-debugging|remote-allow-origins|user-data-dir|load-extension|disable-extensions-except|proxy-server|host-resolver-rules|disable-web-security|no-sandbox)/u;

/**
 * Browsers launched from the Chrome, Chromium or Edge installed on this machine, one process with its own new profile
 * per browser, driven over CDP on 127.0.0.1. Nothing is downloaded. Node only.
 */
export function localBrowsers(options: LocalBrowsersOptions = {}): BrowserProvider {
  if (options.channel !== undefined && options.channel !== 'chrome' && options.channel !== 'edge') throw new MayuraError('INVALID_CONFIG', "localBrowsers(): channel is 'chrome' or 'edge'.");
  if (options.executablePath !== undefined && (typeof options.executablePath !== 'string' || options.executablePath === '')) throw new MayuraError('INVALID_CONFIG', 'localBrowsers(): executablePath must be a path.');
  if (options.headless !== undefined && typeof options.headless !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'localBrowsers(): headless must be a boolean.');
  const extra = options.args ?? [];
  if (!Array.isArray(extra) || extra.length > 64 || extra.some(item => typeof item !== 'string' || !/^--[a-z0-9-]+(?:=[^\0]{0,1024})?$/u.test(item) || refusedSwitch.test(item))) {
    throw new MayuraError('INVALID_CONFIG', 'localBrowsers(): args are --switches; remote debugging, profiles, extensions, proxies and sandbox switches are set here or refused.');
  }
  const maxLifetimeMs = options.maxLifetimeMs ?? 86_400_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000 || maxLifetimeMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'localBrowsers(): maxLifetimeMs is 1 s to about 24 days.');

  const create = async (spec: { readonly viewport: { readonly width: number; readonly height: number } }, { signal }: { readonly signal: AbortSignal }): Promise<BrowserBackend> => {
    const executable = options.executablePath ?? findLocalBrowser(options.channel);
    if (!executable) throw new MayuraError('INVALID_CONFIG', `No ${options.channel ?? 'chrome'} browser was found on this machine; install one, or give executablePath.`);
    const profile = await mkdtemp(join(tmpdir(), 'mayura-browser-'));
    const removeProfile = async () => {
      // The browser lets go of its profile shortly after it exits, later on Windows.
      for (let attempt = 0; attempt < 20; attempt++) {
        try { await rm(profile, { recursive: true, force: true }); return; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
      }
    };
    const args = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--disable-sync',
      '--metrics-recording-only', '--password-store=basic', '--use-mock-keychain', `--window-size=${spec.viewport.width},${spec.viewport.height}`,
      ...(options.headless === false ? [] : ['--headless=new']), ...extra, 'about:blank'];
    let child: ChildProcess;
    try { child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false }); }
    catch { await removeProfile(); throw new BrowserError('unavailable'); }
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]); }
      }
      await removeProfile();
    };
    // The browser prints where it listens on stderr; nothing else of its output is kept.
    const url = await new Promise<string>((resolve, reject) => {
      let seen = '';
      const fail = (error: unknown) => { cleanup(); reject(error); };
      const onData = (chunk: Buffer) => {
        seen = (seen + chunk.toString('utf8')).slice(-8_192);
        const found = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[A-Za-z0-9-]+)/u.exec(seen);
        if (found) { cleanup(); resolve(found[1]!); }
      };
      const onExit = () => fail(new BrowserError('unavailable'));
      const onError = (error: NodeJS.ErrnoException) => fail(error.code === 'ENOENT' ? new MayuraError('INVALID_CONFIG', `The browser at ${executable} could not be started.`) : new BrowserError('unavailable'));
      const onAbort = () => fail(new BrowserError('timeout'));
      const timer = setTimeout(onAbort, 30_000);
      const cleanup = () => { clearTimeout(timer); child.stderr!.off('data', onData); child.off('exit', onExit); child.off('error', onError); signal.removeEventListener('abort', onAbort); };
      child.stderr!.on('data', onData); child.once('exit', onExit); child.once('error', onError);
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    }).catch(async error => { await stop(); throw error; });
    // Keep reading stderr so the browser never blocks on a full pipe.
    child.stderr!.resume();
    return {
      id: `local-${child.pid ?? 'browser'}`,
      cdp: { url },
      release: async () => { await stop(); },
    };
  };

  return Object.freeze({ id: 'local', features: Object.freeze({ liveView: false }), maxLifetimeMs, create });
}

export { serveBrowserFixtures } from './fixtures.js';
export type { BrowserFixtureServer } from './fixtures.js';
