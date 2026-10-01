import { MayuraError } from 'mayura';
import { SandboxError, type ProviderSandboxSpec, type SandboxBackend, type SandboxDesktop, type SandboxProvider } from 'mayura/sandbox';
import { e2bSandboxes, type E2bSandboxOptions } from '@mayurajs/sandbox-e2b';

export interface E2bDesktopOptions extends E2bSandboxOptions {
  /** The screen size in pixels; 1024 × 768 by default. */
  readonly resolution?: readonly [width: number, height: number];
  /** The screen's dots per inch; 96 by default. */
  readonly dpi?: number;
  /**
   * A live view a person can open in a browser (`desktop.viewUrl()`): `'off'` (the default), `'view'` to watch only,
   * or `'control'` to use the desktop too. The view is public at its URL, which carries its password.
   */
  readonly liveView?: 'off' | 'view' | 'control';
}

const display = ':0';
const vncPort = 5900;
const viewPort = 6080;
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');

// Starts the X server and the desktop, and waits for the screen. $1 × $2: the resolution; $3: the DPI.
const startScript = [
  `setsid nohup Xvfb ${display} -ac -screen 0 "$1x$2x24" -retro -dpi "$3" -nolisten tcp -nolisten unix >/dev/null 2>&1 &`,
  '_tries=0',
  `until xdpyinfo -display ${display} >/dev/null 2>&1; do _tries=$((_tries + 1)); [ "$_tries" -le 150 ] || exit 3; sleep 0.1; done`,
  'setsid nohup startxfce4 >/dev/null 2>&1 &',
].join('\n');
// Starts the VNC server and noVNC, and waits for noVNC. $1: the password; $2: `view` or `control`.
const viewScript = [
  '_flag=; [ "$2" = view ] && _flag=-viewonly',
  `x11vnc -bg -display ${display} -forever -wait 50 -shared -rfbport ${vncPort} -passwd "$1" $_flag >/tmp/x11vnc.log 2>&1 || exit 3`,
  `cd /opt/noVNC/utils && setsid nohup ./novnc_proxy --vnc localhost:${vncPort} --listen ${viewPort} --web /opt/noVNC >/tmp/novnc.log 2>&1 &`,
  '_tries=0',
  `until nc -z localhost ${viewPort} 2>/dev/null; do _tries=$((_tries + 1)); [ "$_tries" -le 100 ] || exit 4; sleep 0.1; done`,
].join('\n');

/** Key names as people write them, to X keysyms. */
const keyNames: Readonly<Record<string, string>> = {
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift', meta: 'super', cmd: 'super', command: 'super', super: 'super', win: 'super',
  enter: 'Return', return: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'BackSpace', delete: 'Delete', del: 'Delete', insert: 'Insert',
  space: 'space', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down',
};
/** `ctrl+c` as xdotool's `ctrl+c`; `Enter` as `Return`; `f5` as `F5`. */
export function xdotoolKeys(keys: string): string {
  return keys.split('+').map(key => {
    const lower = key.toLowerCase();
    if (keyNames[lower] !== undefined) return keyNames[lower]!;
    if (/^f([1-9]|1[0-9]|2[0-4])$/u.test(lower)) return lower.toUpperCase();
    return key;
  }).join('+');
}

/**
 * E2B Desktop sandboxes: an E2B sandbox from the `desktop` template (Ubuntu with Xfce, browsers and office apps), with
 * a desktop agents can see and use through `desktop` and the desktop tools of `mayura/sandbox`. Give the result to
 * `createSandboxes`.
 */
export function e2bDesktopSandboxes(options: E2bDesktopOptions): SandboxProvider {
  const [width, height] = options?.resolution ?? [1024, 768];
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 320 || height < 240 || width > 7_680 || height > 4_320) {
    throw new MayuraError('INVALID_CONFIG', 'e2bDesktopSandboxes(): resolution is [width, height], from 320 × 240 to 7680 × 4320.');
  }
  const dpi = options?.dpi ?? 96;
  if (!Number.isSafeInteger(dpi) || dpi < 48 || dpi > 480) throw new MayuraError('INVALID_CONFIG', 'e2bDesktopSandboxes(): dpi is 48 to 480.');
  const liveView = options?.liveView ?? 'off';
  if (!['off', 'view', 'control'].includes(liveView)) throw new MayuraError('INVALID_CONFIG', "e2bDesktopSandboxes(): liveView is 'off', 'view' or 'control'.");
  const inner = e2bSandboxes({ ...options, template: options.template ?? 'desktop' });

  const create = async (spec: ProviderSandboxSpec, { signal }: { readonly signal: AbortSignal }): Promise<SandboxBackend> => {
    if (spec.ports.includes(viewPort) && liveView !== 'off') throw new MayuraError('INVALID_INPUT', `Port ${viewPort} serves the live view.`);
    // The live view is served on its port, which must be public for a browser to open it.
    const backend = await inner.create(liveView === 'off' ? spec : { ...spec, ports: [...spec.ports, viewPort] }, { signal });
    const run = async (command: readonly string[], callSignal: AbortSignal, maxOutputBytes = 65_536) => {
      const result = await backend.exec(command, { cwd: inner.workdir, env: { DISPLAY: display }, maxOutputBytes, signal: callSignal });
      if (result.exitCode === undefined) throw new SandboxError('timeout');
      if (result.exitCode !== 0) throw new SandboxError('rejected');
      return new TextDecoder().decode(result.stdout);
    };
    try {
      await run(['sh', '-c', startScript, 'mayura', String(width), String(height), String(dpi)], signal);
    } catch (error) {
      await backend.release({ signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
      throw error;
    }
    const at = (x: number, y: number) => ['mousemove', '--sync', String(x), String(y)];
    let view: Promise<string> | undefined;
    const desktop: SandboxDesktop = {
      size: async ({ signal: callSignal }) => {
        const match = /^(\d{1,5}) (\d{1,5})\s*$/u.exec(await run(['xdotool', 'getdisplaygeometry'], callSignal));
        if (!match) throw new SandboxError('invalid_response');
        return { width: Number(match[1]), height: Number(match[2]) };
      },
      screenshot: async ({ signal: callSignal }) => {
        const path = `/tmp/mayura-screenshot-${randomHex(8)}.png`;
        await run(['scrot', '--pointer', path], callSignal);
        try {
          const data = await backend.readFile(path, { maxBytes: 16 * 1_048_576, signal: callSignal });
          if (!data) throw new SandboxError('invalid_response');
          return { data, mediaType: 'image/png' as const };
        } finally { await backend.removeFile(path, { recursive: false, signal: AbortSignal.timeout(30_000) }).catch(() => undefined); }
      },
      click: async (x, y, { button, double, signal: callSignal }) => {
        await run(['xdotool', ...at(x, y), 'click', ...(double ? ['--repeat', '2'] : []), button === 'left' ? '1' : button === 'middle' ? '2' : '3'], callSignal);
      },
      move: async (x, y, { signal: callSignal }) => { await run(['xdotool', ...at(x, y)], callSignal); },
      scroll: async (x, y, { dx, dy, signal: callSignal }) => {
        // X scrolls with buttons: 4 up, 5 down, 6 left, 7 right, one notch per click.
        await run(['xdotool', ...at(x, y), ...(dy ? ['click', '--repeat', String(Math.abs(dy)), dy > 0 ? '5' : '4'] : []),
          ...(dx ? ['click', '--repeat', String(Math.abs(dx)), dx > 0 ? '7' : '6'] : [])], callSignal);
      },
      type: async (text, { signal: callSignal }) => {
        // In parts, as long strings typed at once drop characters.
        const characters = [...text];
        for (let index = 0; index < characters.length; index += 50) await run(['xdotool', 'type', '--delay', '12', '--', characters.slice(index, index + 50).join('')], callSignal);
      },
      key: async (keys, { signal: callSignal }) => { await run(['xdotool', 'key', '--', xdotoolKeys(keys)], callSignal); },
      ...(liveView === 'off' ? {} : {
        viewUrl: ({ signal: callSignal }: { readonly signal: AbortSignal }) => {
          view ??= (async () => {
            // VNC passwords are 8 characters.
            const password = randomHex(4);
            await run(['sh', '-c', viewScript, 'mayura', password, liveView], callSignal);
            const base = await backend.url!(viewPort, { signal: callSignal });
            return `${base}vnc.html?autoconnect=true&resize=scale&password=${password}${liveView === 'view' ? '&view_only=true' : ''}`;
          })();
          view.catch(() => { view = undefined; });
          return view;
        },
      }),
    };
    return { ...backend, desktop };
  };

  return Object.freeze({
    id: 'e2b-desktop', workdir: inner.workdir, maxLifetimeMs: inner.maxLifetimeMs,
    features: Object.freeze({ ...inner.features, desktop: true }),
    create,
  });
}
