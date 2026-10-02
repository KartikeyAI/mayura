import { MayuraError } from 'mayura';
import { connectCdp, type Browser, type CdpConnection, type CdpSocketFactory } from 'mayura/browser';

export interface ScreencastOptions {
  /** JPEG quality, 1 to 100; 60 by default. */
  readonly quality?: number;
  /** The widest frame, in pixels; 1,280 by default (320 to 3,840). */
  readonly maxWidth?: number;
  /** The tallest frame, in pixels; 800 by default (240 to 2,160). */
  readonly maxHeight?: number;
  /** The most frames a second; 5 by default (1 to 30). */
  readonly maxFps?: number;
  /** Frames larger than this are skipped, in bytes; 2 MiB by default. */
  readonly maxFrameBytes?: number;
  /** Lets `input` use the page, as a person would: off by default. */
  readonly interact?: boolean;
  /** For runtimes whose WebSocket cannot send the headers a browser's CDP connection needs. */
  readonly webSocket?: CdpSocketFactory;
  /** Ends the screencast. */
  readonly signal?: AbortSignal;
}

export interface ScreencastFrame {
  /** A JPEG of the page as shown. */
  readonly data: Uint8Array;
  readonly mediaType: 'image/jpeg';
  /** The page's size in CSS pixels, which `input` coordinates are fractions of. */
  readonly width: number;
  readonly height: number;
  /** The tab shown, as `browser.tabs()` names it. */
  readonly tab: string;
}

/** What a person does in the viewer. Coordinates are fractions of the frame, 0 to 1 from the top left. */
export type ViewerInput =
  | { readonly type: 'mouse'; readonly action: 'down' | 'up' | 'move'; readonly x: number; readonly y: number; readonly button?: 'left' | 'middle' | 'right'; readonly clicks?: number; readonly modifiers?: number }
  | { readonly type: 'wheel'; readonly x: number; readonly y: number; readonly dx: number; readonly dy: number }
  | { readonly type: 'key'; readonly action: 'down' | 'up'; readonly key: string; readonly modifiers?: number }
  | { readonly type: 'text'; readonly text: string };

/** The frames of a browser's active tab as it changes, following the tab the browser has active. */
export interface Screencast extends AsyncIterable<ScreencastFrame> {
  /** The next frame, waiting for one; undefined once the screencast ended. */
  next(): Promise<ScreencastFrame | undefined>;
  /** Uses the page shown, for screencasts with `interact`. */
  input(event: ViewerInput, options?: { readonly signal?: AbortSignal }): Promise<void>;
  /** True once closed, or once its browser or connection ended. */
  readonly ended: boolean;
  close(): void;
}

const named: Readonly<Record<string, { readonly code: string; readonly keyCode: number; readonly text?: string }>> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 }, Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 }, PageUp: { code: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', keyCode: 34 },
  Shift: { code: 'ShiftLeft', keyCode: 16 }, Control: { code: 'ControlLeft', keyCode: 17 }, Alt: { code: 'AltLeft', keyCode: 18 }, Meta: { code: 'MetaLeft', keyCode: 91 },
};
const buttons = { left: 'left', middle: 'middle', right: 'right' } as const;
const mouseTypes = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' } as const;

function bound(value: number | undefined, name: string, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new MayuraError('INVALID_CONFIG', `browserScreencast(): ${name} is ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.`);
  return result;
}
const fraction = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const modifiersOf = (value: unknown): number => {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 15) throw new MayuraError('INVALID_INPUT', 'modifiers is 0 to 15 (Alt 1, Control 2, Meta 4, Shift 8).');
  return value as number;
};
function decode(base64: string): Uint8Array {
  const binary = atob(base64); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * A screencast of a `mayura/browser` browser: the active tab's frames as JPEGs, over a CDP connection of its own, and,
 * with `interact`, a way for a person to use the page. Frames come no faster than `maxFps`, and only as fast as they
 * are taken. The browser's origins hold for whatever a person does. It needs a browser other clients can join
 * (`browser.cdp`).
 */
export async function browserScreencast(browser: Browser, options: ScreencastOptions = {}): Promise<Screencast> {
  if (!browser || typeof browser.tabs !== 'function') throw new MayuraError('INVALID_CONFIG', 'browserScreencast() needs a browser.');
  const quality = bound(options.quality, 'quality', 60, 1, 100);
  const maxWidth = bound(options.maxWidth, 'maxWidth', 1_280, 320, 3_840);
  const maxHeight = bound(options.maxHeight, 'maxHeight', 800, 240, 2_160);
  const maxFps = bound(options.maxFps, 'maxFps', 5, 1, 30);
  const maxFrameBytes = bound(options.maxFrameBytes, 'maxFrameBytes', 2_097_152, 65_536, 16_777_216);
  if (options.interact !== undefined && typeof options.interact !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'browserScreencast(): interact must be a boolean.');
  const cdp = browser.cdp;
  if (!cdp) throw new MayuraError('INVALID_CONFIG', `The ${browser.provider} provider's browsers cannot be joined: each connection starts a browser of its own.`);
  if (browser.ended) throw new MayuraError('INVALID_INPUT', 'The browser has ended.');

  const connection: CdpConnection = await connectCdp(cdp.url, { headers: cdp.headers, ...(options.webSocket ? { webSocket: options.webSocket } : {}), ...(options.signal ? { signal: options.signal } : {}) });
  let ended = false;
  let shown: { readonly tab: string; readonly sessionId: string } | undefined;
  let size = { width: 0, height: 0 };
  let waiting: { readonly frame: ScreencastFrame; readonly ack: number; readonly sessionId: string } | undefined;
  let taker: ((frame: ScreencastFrame | undefined) => void) | undefined;
  let lastAck = 0; let ackTimer: ReturnType<typeof setTimeout> | undefined;
  let followTimer: ReturnType<typeof setTimeout> | undefined; let failures = 0;

  const end = () => {
    if (ended) return;
    ended = true;
    clearTimeout(ackTimer); clearTimeout(followTimer);
    options.signal?.removeEventListener('abort', end);
    waiting = undefined; const take = taker; taker = undefined; take?.(undefined);
    connection.close();
  };
  options.signal?.addEventListener('abort', end, { once: true });
  void connection.closed.then(end);

  const ack = (sessionId: string, id: number) => { void connection.send('Page.screencastFrameAck', { sessionId: id }, { sessionId }).catch(() => undefined); };
  const offFrames = connection.on('Page.screencastFrame', (params, sessionId) => {
    if (ended || !shown || sessionId !== shown.sessionId) return;
    const id = params['sessionId']; const data = params['data']; const metadata = params['metadata'] as { deviceWidth?: unknown; deviceHeight?: unknown } | undefined;
    if (typeof id !== 'number' || typeof data !== 'string') return;
    // Base64 is 4/3 of the bytes: a frame too large is skipped, unread.
    if (data.length > Math.ceil(maxFrameBytes / 3) * 4) { ack(sessionId, id); return; }
    const width = typeof metadata?.deviceWidth === 'number' && metadata.deviceWidth > 0 ? metadata.deviceWidth : size.width;
    const height = typeof metadata?.deviceHeight === 'number' && metadata.deviceHeight > 0 ? metadata.deviceHeight : size.height;
    let bytes: Uint8Array;
    try { bytes = decode(data); } catch { ack(sessionId, id); return; }
    size = { width, height };
    const frame: ScreencastFrame = Object.freeze({ data: bytes, mediaType: 'image/jpeg' as const, width, height, tab: shown.tab });
    if (taker) { const take = taker; taker = undefined; take(frame); schedule(sessionId, id); }
    else waiting = { frame, ack: id, sessionId };
  });
  void connection.closed.then(offFrames);
  // The next frame is asked for once this one is taken, and no sooner than maxFps allows.
  const schedule = (sessionId: string, id: number) => {
    const wait = Math.max(0, lastAck + 1_000 / maxFps - Date.now());
    ackTimer = setTimeout(() => { lastAck = Date.now(); ack(sessionId, id); }, wait);
  };

  const show = async (tab: string) => {
    const previous = shown; shown = undefined; waiting = undefined;
    if (previous) await connection.send('Target.detachFromTarget', { sessionId: previous.sessionId }).catch(() => undefined);
    const { sessionId } = await connection.send<{ sessionId: string }>('Target.attachToTarget', { targetId: tab, flatten: true });
    shown = { tab, sessionId };
    await connection.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth, maxHeight, everyNthFrame: 1 }, { sessionId });
  };
  // Follows the tab the browser has active, as its agent moves between tabs.
  const follow = async () => {
    if (ended) return;
    if (browser.ended) { end(); return; }
    try {
      const active = (await browser.tabs(options.signal ? { signal: options.signal } : {})).find(tab => tab.active);
      if (active && active.tab !== shown?.tab) await show(active.tab);
      failures = 0;
    } catch {
      if (browser.ended || ++failures >= 3) { end(); return; }
    }
    if (!ended) followTimer = setTimeout(() => void follow(), 1_000);
  };
  await follow();

  const next = (): Promise<ScreencastFrame | undefined> => {
    if (ended) return Promise.resolve(undefined);
    if (waiting) { const { frame, ack: id, sessionId } = waiting; waiting = undefined; schedule(sessionId, id); return Promise.resolve(frame); }
    if (taker) return Promise.reject(new MayuraError('INVALID_INPUT', 'Take one frame at a time.'));
    return new Promise(resolve => { taker = resolve; });
  };

  const input = async (event: ViewerInput, inputOptions: { readonly signal?: AbortSignal } = {}): Promise<void> => {
    if (options.interact !== true) throw new MayuraError('PERMISSION_DENIED', 'This screencast is view only.');
    if (ended) throw new MayuraError('INVALID_INPUT', 'The screencast has ended.');
    const on = shown;
    if (!on || size.width === 0) throw new MayuraError('INVALID_INPUT', 'No page is shown yet.');
    const send = (method: string, params: Record<string, unknown>) => connection.send(method, params, { sessionId: on.sessionId, ...(inputOptions.signal ? { signal: inputOptions.signal } : {}) });
    const item = event as Record<string, unknown> | null;
    if (!item || typeof item !== 'object') throw new MayuraError('INVALID_INPUT', 'An input is an object with a type.');
    if (item['type'] === 'mouse' || item['type'] === 'wheel') {
      if (!fraction(item['x']) || !fraction(item['y'])) throw new MayuraError('INVALID_INPUT', 'x and y are fractions of the frame, 0 to 1.');
      const point = { x: Math.round(item['x'] * size.width), y: Math.round(item['y'] * size.height) };
      if (item['type'] === 'wheel') {
        const { dx, dy } = item;
        if (typeof dx !== 'number' || typeof dy !== 'number' || !Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 10_000 || Math.abs(dy) > 10_000) throw new MayuraError('INVALID_INPUT', 'dx and dy are pixels, -10,000 to 10,000.');
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: dx, deltaY: dy });
        return;
      }
      const type = mouseTypes[item['action'] as keyof typeof mouseTypes];
      const button = item['button'] === undefined ? 'left' : buttons[item['button'] as keyof typeof buttons];
      const clicks = item['clicks'] ?? 1;
      if (!Object.hasOwn(mouseTypes, item['action'] as string) || !button || !Object.hasOwn(buttons, button) || !Number.isSafeInteger(clicks) || (clicks as number) < 1 || (clicks as number) > 3) {
        throw new MayuraError('INVALID_INPUT', 'A mouse input has action down, up or move, a button left, middle or right, and clicks 1 to 3.');
      }
      await send('Input.dispatchMouseEvent', { type, ...point, modifiers: modifiersOf(item['modifiers']), ...(type === 'mouseMoved' ? {} : { button, clickCount: clicks }) });
      return;
    }
    if (item['type'] === 'key') {
      const key = item['key'];
      if ((item['action'] !== 'down' && item['action'] !== 'up') || typeof key !== 'string') throw new MayuraError('INVALID_INPUT', 'A key input has action down or up, and a key.');
      const modifiers = modifiersOf(item['modifiers']);
      const definition = Object.hasOwn(named, key) ? named[key]! : [...key].length === 1 && /^[^\p{Cc}]$/u.test(key) ? {
        code: /^[a-z]$/iu.test(key) ? `Key${key.toUpperCase()}` : /^\d$/u.test(key) ? `Digit${key}` : '', keyCode: /^[a-z\d]$/iu.test(key) ? key.toUpperCase().charCodeAt(0) : 0,
        // Typed as text unless Control, Alt or Meta is held.
        ...(modifiers & 7 ? {} : { text: key }),
      } : undefined;
      if (!definition) throw new MayuraError('INVALID_INPUT', 'key is one character, or a key such as Enter, Tab, Backspace or ArrowDown.');
      const common = { key, code: definition.code, windowsVirtualKeyCode: definition.keyCode, modifiers };
      await send('Input.dispatchKeyEvent', item['action'] === 'up' ? { type: 'keyUp', ...common }
        : definition.text !== undefined ? { type: 'keyDown', ...common, text: definition.text, unmodifiedText: definition.text } : { type: 'rawKeyDown', ...common });
      return;
    }
    if (item['type'] === 'text') {
      if (typeof item['text'] !== 'string' || item['text'].length === 0 || item['text'].length > 1_000) throw new MayuraError('INVALID_INPUT', 'text is 1 to 1,000 characters.');
      await send('Input.insertText', { text: item['text'] });
      return;
    }
    throw new MayuraError('INVALID_INPUT', 'type is mouse, wheel, key or text.');
  };

  const screencast: Screencast = {
    next, input,
    get ended() { return ended; },
    close: end,
    [Symbol.asyncIterator]: () => ({
      next: async () => { const frame = await next(); return frame ? { value: frame, done: false } : { value: undefined, done: true }; },
      return: async () => { end(); return { value: undefined, done: true }; },
    }),
  };
  return screencast;
}
