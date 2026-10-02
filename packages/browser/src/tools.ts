import { media, MayuraError, withMedia, type JsonObject, type Schema, type Scope } from '@mayura/core';
import { defineTool, type AnyTool } from '@mayura/tools';
import type { Browser, PageState } from './browsers.js';
import { BrowserError } from './contracts.js';

/** The browser the tools drive: one browser, or a function giving the browser for a run (see `browserPerRun`). */
export type BrowserSource = Browser | ((context: { readonly runId: string; readonly scope: Scope; readonly signal: AbortSignal }) => Promise<Browser>);

export interface BrowserToolsOptions {
  /** Names the tools (`<name>.goto`, `<name>.click`, ...) and their permissions (`browser:<name>:read`, ...). */
  readonly name: string;
  /**
   * Make the tools that act on pages: `<name>.click`, `.fill`, `.press`, `.select`, `.hover`, `.scroll` and `.tab`;
   * permission `browser:<name>:act`. Off by default: the tools only navigate and read.
   */
  readonly act?: boolean;
  /** Make `<name>.screenshot`, which returns an image of the page; permission `browser:<name>:read`. Off by default. */
  readonly screenshot?: boolean;
  /** Make `<name>.evaluate`, which runs JavaScript in the page; permission `browser:<name>:evaluate`. Off by default. */
  readonly evaluate?: boolean;
  /** Return a fresh snapshot after each navigation and action, so the model sees what changed; true by default. */
  readonly snapshotAfter?: boolean;
  /** What one navigation or action costs at most, in micro-units of your budget currency; 0 by default. */
  readonly callCostMicros?: number;
}

type Kind = 'string' | 'integer' | 'string?' | 'integer?' | 'boolean?';
function object<T>(fields: Readonly<Record<string, Kind>>, maxString: number, check?: (value: T) => string | undefined): Schema<T> {
  return { '~standard': { version: 1, vendor: 'mayura-browser', validate: (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'Expected an object.' }] };
    const input = value as Record<string, unknown>;
    for (const name of Object.keys(input)) if (!Object.hasOwn(fields, name)) return { issues: [{ message: `Unexpected field ${name}.` }] };
    for (const [name, kind] of Object.entries(fields)) {
      const item = input[name];
      if (item === undefined) { if (kind.endsWith('?')) continue; return { issues: [{ message: `${name} is required.` }] }; }
      if (kind.startsWith('string') && (typeof item !== 'string' || item.length > maxString)) return { issues: [{ message: `${name} must be a string.` }] };
      if (kind.startsWith('integer') && (typeof item !== 'number' || !Number.isSafeInteger(item))) return { issues: [{ message: `${name} must be a whole number.` }] };
      if (kind.startsWith('boolean') && typeof item !== 'boolean') return { issues: [{ message: `${name} must be true or false.` }] };
    }
    const message = check?.(input as T);
    return message === undefined ? { value: input as T } : { issues: [{ message }] };
  } } } as Schema<T>;
}
const anything: Schema<unknown> = { '~standard': { version: 1, vendor: 'mayura-browser', validate: (value: unknown) => ({ value }) } } as Schema<unknown>;
const schema = (required: readonly string[], properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, ...(required.length ? { required: [...required] } : {}), properties }) as unknown as JsonObject;
const correctable = new Set(['INVALID_INPUT', 'PERMISSION_DENIED', 'LIMIT_EXCEEDED']);
const refField = { type: 'string', description: 'The element\'s ref from the latest snapshot, such as e12.' };

/**
 * Tools that let an agent use a browser. Navigating and reading (`<name>.goto`, `.back`, `.snapshot`, `.text`) need
 * `browser:<name>:read`; acting on pages, screenshots and JavaScript are each off until enabled. Pages are read as
 * snapshots: an outline of the page whose `[ref=eN]` marks are what the action tools take. The origins the browser may
 * load are set where its browsers are created (`createBrowsers`).
 */
export function browserTools(source: BrowserSource, options: BrowserToolsOptions): AnyTool[] {
  if (typeof source !== 'function' && (!source || typeof source.goto !== 'function' || typeof source.snapshot !== 'function')) throw new MayuraError('INVALID_CONFIG', 'browserTools() needs a browser, or a function giving one.');
  const name = options?.name;
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(name)) throw new MayuraError('INVALID_CONFIG', 'browserTools(): name is lowercase letters, digits, _ and -, starting with a letter.');
  for (const flag of ['act', 'screenshot', 'evaluate', 'snapshotAfter'] as const) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') throw new MayuraError('INVALID_CONFIG', `browserTools(): ${flag} must be a boolean.`);
  }
  const callCostMicros = options.callCostMicros ?? 0;
  if (!Number.isSafeInteger(callCostMicros) || callCostMicros < 0) throw new MayuraError('INVALID_CONFIG', 'browserTools(): callCostMicros must be a non-negative integer.');
  const snapshotAfter = options.snapshotAfter ?? true;
  const version = `1:${snapshotAfter ? 1 : 0}`;
  const read = [`browser:${name}:read`]; const act = [`browser:${name}:act`];
  const browser = async (context: { readonly runId: string; readonly scope: Scope; readonly signal: AbortSignal }): Promise<Browser> => {
    if (typeof source !== 'function') return source;
    const resolved = await source({ runId: context.runId, scope: context.scope, signal: context.signal });
    if (!resolved || typeof resolved.goto !== 'function') throw new MayuraError('INVALID_CONFIG', 'The browser source gave no browser.');
    return resolved;
  };
  /** A call's result, with the page as it now is when `snapshotAfter`. */
  const after = async (page: Browser, result: PageState & Record<string, unknown>, signal: AbortSignal): Promise<JsonObject> => {
    if (!snapshotAfter) return result as unknown as JsonObject;
    const snapshot = await page.snapshot({ signal });
    return { ...result, url: snapshot.url, title: snapshot.title, snapshot: snapshot.text, ...(snapshot.truncated ? { snapshotTruncated: true } : {}),
      ...(snapshot.dialogs.length ? { dialogs: [...snapshot.dialogs] } : {}) } as unknown as JsonObject;
  };
  const tool = (id: string, permission: readonly string[], description: string, input: Schema<unknown>, inputJsonSchema: JsonObject,
    execute: (request: Record<string, unknown>, page: Browser, signal: AbortSignal) => Promise<JsonObject | ReturnType<typeof withMedia>>, extra: Record<string, unknown> = {}) =>
    defineTool({ id: `${name}.${id}`, version, effects: permission === read ? 'read' : 'write', capabilities: [...permission], timeoutMs: 180_000,
      ...(id === 'goto' || permission === act ? { costMicros: callCostMicros } : {}), description, input, output: anything, inputJsonSchema,
      execute: async (request: unknown, context: { readonly runId: string; readonly scope: Scope; readonly signal: AbortSignal }) => {
        try { return await execute(request as Record<string, unknown>, await browser(context), context.signal); }
        catch (error) {
          // Mistakes the model can put right come back as the result, in Mayura's own words, so it can try again; what
          // the browser or its provider failed with is thrown, and its details withheld.
          if (error instanceof MayuraError && !(error instanceof BrowserError) && correctable.has(error.code)) return { error: error.code, message: error.message } as JsonObject;
          throw error;
        }
      }, ...extra } as never) as unknown as AnyTool;

  const tools: AnyTool[] = [
    tool('goto', read, `Open a web page in the ${name} browser. Only some sites may be allowed; others are refused. Returns the page as a snapshot.`,
      object<{ url: string }>({ url: 'string' }, 8_192), schema(['url'], { url: { type: 'string', description: 'An http(s) URL.' } }),
      async (request, page, signal) => after(page, { ...(await page.goto(request['url'] as string, { signal })) }, signal)),
    tool('back', read, `Go back to the previous page in the ${name} browser.`, object({}, 0), schema([], {}),
      async (_request, page, signal) => after(page, { ...(await page.back({ signal })) }, signal)),
    tool('snapshot', read, `Read the page open in the ${name} browser as an outline of its elements. Elements you can act on carry [ref=eN]; refs from older snapshots stop working.`,
      object({}, 0), schema([], {}),
      async (_request, page, signal) => { const snapshot = await page.snapshot({ signal }); return { ...snapshot, dialogs: [...snapshot.dialogs] } as unknown as JsonObject; }),
    tool('text', read, `Read the visible text of the page in the ${name} browser, or of one element by its ref.`,
      object<{ ref?: string }>({ ref: 'string?' }, 16), schema([], { ref: refField }),
      async (request, page, signal) => ({ ...(await page.text({ signal, ...(request['ref'] === undefined ? {} : { ref: request['ref'] as string }) })) }) as unknown as JsonObject),
  ];
  if (options.act) {
    tools.push(
      tool('click', act, `Click an element in the ${name} browser by its ref.`,
        object<{ ref: string; double?: boolean }>({ ref: 'string', double: 'boolean?' }, 16), schema(['ref'], { ref: refField, double: { type: 'boolean', description: 'Double-click.' } }),
        async (request, page, signal) => after(page, { ...(await page.click(request['ref'] as string, { signal, double: request['double'] === true })) }, signal)),
      tool('fill', act, `Replace the text of an input in the ${name} browser, as typing it would. Press Enter afterwards to submit, if needed.`,
        object<{ ref: string; text: string }>({ ref: 'string', text: 'string' }, 100_000), schema(['ref', 'text'], { ref: refField, text: { type: 'string' } }),
        async (request, page, signal) => after(page, { ...(await page.fill(request['ref'] as string, request['text'] as string, { signal })) }, signal)),
      tool('press', act, `Press a key in the ${name} browser, on what has focus: Enter, Tab, Escape, ArrowDown, a letter, or a chord such as Control+a.`,
        object<{ keys: string }>({ keys: 'string' }, 64), schema(['keys'], { keys: { type: 'string' } }),
        async (request, page, signal) => after(page, { ...(await page.press(request['keys'] as string, { signal })) }, signal)),
      tool('select', act, `Choose an option of a list in the ${name} browser, by the option's value or label.`,
        object<{ ref: string; option: string }>({ ref: 'string', option: 'string' }, 4_096), schema(['ref', 'option'], { ref: refField, option: { type: 'string' } }),
        async (request, page, signal) => after(page, { ...(await page.select(request['ref'] as string, request['option'] as string, { signal })) }, signal)),
      tool('hover', act, `Move the pointer over an element in the ${name} browser, to open what it shows on hover.`,
        object<{ ref: string }>({ ref: 'string' }, 16), schema(['ref'], { ref: refField }),
        async (request, page, signal) => after(page, { ...(await page.hover(request['ref'] as string, { signal })) }, signal)),
      tool('scroll', act, `Scroll the page in the ${name} browser by dy pixels (negative scrolls up), or an element by its ref.`,
        object<{ dy: number; ref?: string }>({ dy: 'integer', ref: 'string?' }, 16, request => Math.abs(request.dy) > 100_000 ? 'dy is at most 100,000 either way.' : undefined),
        schema(['dy'], { dy: { type: 'integer', minimum: -100_000, maximum: 100_000 }, ref: refField }),
        async (request, page, signal) => after(page, { ...(await page.scroll(request['dy'] as number, { signal, ...(request['ref'] === undefined ? {} : { ref: request['ref'] as string }) })) }, signal)),
      tool('tab', act, `Work with the ${name} browser's tabs: list them, open a new one (optionally at a URL), switch to one, or close one.`,
        object<{ action: string; tab?: string; url?: string }>({ action: 'string', tab: 'string?', url: 'string?' }, 8_192,
          request => !['list', 'new', 'select', 'close'].includes(request.action) ? "action is 'list', 'new', 'select' or 'close'."
            : (request.action === 'select' || request.action === 'close') && request.tab === undefined ? 'tab is required.' : undefined),
        schema(['action'], { action: { type: 'string', enum: ['list', 'new', 'select', 'close'] }, tab: { type: 'string', description: 'A tab id from list.' }, url: { type: 'string' } }),
        async (request, page, signal) => {
          const action = request['action'];
          if (action === 'list') return { tabs: (await page.tabs({ signal })).map(item => ({ ...item })) } as unknown as JsonObject;
          if (action === 'close') { await page.closeTab(request['tab'] as string, { signal }); return { closed: request['tab'] } as JsonObject; }
          if (action === 'select') return after(page, { ...(await page.selectTab(request['tab'] as string, { signal })) }, signal);
          return after(page, { ...(await page.newTab(request['url'] as string | undefined, { signal })) }, signal);
        }),
    );
  }
  if (options.screenshot) {
    tools.push(tool('screenshot', read, `See the page in the ${name} browser as an image, the visible part or (fullPage) all of it.`,
      object<{ fullPage?: boolean }>({ fullPage: 'boolean?' }, 0), schema([], { fullPage: { type: 'boolean' } }),
      async (request, page, signal) => {
        const shot = await page.screenshot({ signal, fullPage: request['fullPage'] === true });
        return withMedia({ bytes: shot.data.byteLength } as JsonObject, [media(shot.data, shot.mediaType)]);
      }, { media: { accept: ['image/png'], maxItems: 1, maxBytes: 64 * 1_048_576 } }));
  }
  if (options.evaluate) {
    tools.push(tool('evaluate', [`browser:${name}:evaluate`], `Run a JavaScript expression in the page in the ${name} browser and get its value as JSON, or what it threw. Promises are awaited.`,
      object<{ expression: string }>({ expression: 'string' }, 100_000), schema(['expression'], { expression: { type: 'string' } }),
      async (request, page, signal) => ({ ...(await page.evaluate(request['expression'] as string, { signal })) }) as unknown as JsonObject));
  }
  return tools;
}
