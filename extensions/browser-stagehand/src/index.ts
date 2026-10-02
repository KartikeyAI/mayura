import { defineTool, MayuraError, type AnyTool, type JsonObject, type Schema, type Scope } from 'mayura';
import type { Browser, BrowserSource } from 'mayura/browser';

/** The part of a Stagehand v3 page this package uses. */
export interface StagehandPageLike { url(): string }
/** The part of a Stagehand v3 instance this package uses; one from `@browserbasehq/stagehand` is one. */
export interface StagehandLike {
  init(): Promise<unknown>;
  close(options?: { force?: boolean }): Promise<unknown>;
  act(instruction: string, options?: { page?: StagehandPageLike; timeout?: number }): Promise<{ success?: unknown; message?: unknown; actionDescription?: unknown }>;
  extract(instruction: string, schema?: undefined, options?: { page?: StagehandPageLike; timeout?: number }): Promise<{ extraction?: unknown }>;
  observe(instruction: string, options?: { page?: StagehandPageLike; timeout?: number }): Promise<unknown>;
  readonly context?: { pages(): readonly StagehandPageLike[] };
}
/** Stagehand's class, or one like it: what `new` is called on with Stagehand's v3 options. */
export type StagehandConstructor = new (options: Record<string, unknown>) => StagehandLike;

export interface StagehandToolsOptions {
  /** Names the tools (`<name>.act`, ...) and their permissions (`stagehand:<name>:read`, ...); `stagehand` by default. */
  readonly name?: string;
  /** Stagehand's model: `'provider/model'`, or `{ modelName, apiKey, baseURL }`. Stagehand reads no keys from the environment here. */
  readonly model: string | { readonly modelName: string; readonly apiKey?: string; readonly baseURL?: string };
  /** Make `<name>.act`, which does what an instruction says on the page; permission `stagehand:<name>:act`. Off by default. */
  readonly act?: boolean;
  /** The longest one call may take; 120 s by default. */
  readonly timeoutMs?: number;
  /** The most bytes of a result returned to the model; 64 KiB by default. */
  readonly maxResultBytes?: number;
  /**
   * What each call costs at most, in micro-units of your budget currency, by tool: Stagehand calls its model outside
   * Mayura, so this is how its spending reaches the run's budget. 0 by default.
   */
  readonly costMicros?: { readonly act?: number; readonly extract?: number; readonly observe?: number };
  /** Stagehand's class, for a Stagehand you import yourself or for tests; `@browserbasehq/stagehand` is loaded when first needed otherwise. */
  readonly stagehand?: StagehandConstructor;
}

const anything: Schema<unknown> = { '~standard': { version: 1, vendor: 'mayura-stagehand', validate: (value: unknown) => ({ value }) } } as Schema<unknown>;
const instructionInput: Schema<{ instruction: string }> = { '~standard': { version: 1, vendor: 'mayura-stagehand', validate: (value: unknown) => {
  const input = value as { instruction?: unknown } | null;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'instruction')) return { issues: [{ message: 'Expected { instruction }.' }] };
  if (typeof input.instruction !== 'string' || input.instruction.trim() === '' || input.instruction.length > 2_000) return { issues: [{ message: 'instruction is text, at most 2,000 characters.' }] };
  return { value: input as { instruction: string } };
} } } as Schema<{ instruction: string }>;
const instructionSchema = { type: 'object', additionalProperties: false, required: ['instruction'], properties: { instruction: { type: 'string', maxLength: 2_000 } } } as unknown as JsonObject;
const encoder = new TextEncoder(); const decoder = new TextDecoder();
const clip = (text: string, max: number) => {
  const bytes = encoder.encode(text);
  return bytes.byteLength <= max ? { text, truncated: false } : { text: decoder.decode(bytes.subarray(0, max)).replace(/�$/u, ''), truncated: true };
};

async function loadStagehand(): Promise<StagehandConstructor> {
  const specifier = '@browserbasehq/stagehand';
  try { return (await import(specifier) as { Stagehand: StagehandConstructor }).Stagehand; }
  catch { throw new MayuraError('INVALID_CONFIG', 'stagehandTools() needs Stagehand 3: npm install @browserbasehq/stagehand@3'); }
}

/**
 * Stagehand's natural-language browser automation as tools on a `mayura/browser` browser: `<name>.extract` (what a page
 * says, as text) and `<name>.observe` (what can be done on it) need `stagehand:<name>:read`; `<name>.act` (do what an
 * instruction says) is off until enabled, with `stagehand:<name>:act`. Stagehand 3 drives the same browser over its CDP
 * endpoint, so the browser's origins, lifetime and limits still hold. Node only (Stagehand's own requirement).
 */
export function stagehandTools(source: BrowserSource, options: StagehandToolsOptions): AnyTool[] {
  if (typeof source !== 'function' && (!source || typeof source.goto !== 'function')) throw new MayuraError('INVALID_CONFIG', 'stagehandTools() needs a browser, or a function giving one.');
  const name = options?.name ?? 'stagehand';
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(name)) throw new MayuraError('INVALID_CONFIG', 'stagehandTools(): name is lowercase letters, digits, _ and -, starting with a letter.');
  const model = options.model;
  if (!(typeof model === 'string' && /^[a-z0-9-]+\/[\w.:-]+$/iu.test(model)) && !(model && typeof model === 'object' && typeof model.modelName === 'string' && model.modelName !== '')) {
    throw new MayuraError('INVALID_CONFIG', "stagehandTools(): model is 'provider/model', or { modelName, apiKey }.");
  }
  if (options.act !== undefined && typeof options.act !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'stagehandTools(): act must be a boolean.');
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new MayuraError('INVALID_CONFIG', 'stagehandTools(): timeoutMs is 1,000 to 600,000.');
  const maxResultBytes = options.maxResultBytes ?? 65_536;
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1_024 || maxResultBytes > 4_194_304) throw new MayuraError('INVALID_CONFIG', 'stagehandTools(): maxResultBytes is 1,024 to 4,194,304.');
  const costs = options.costMicros ?? {};
  for (const [tool, cost] of Object.entries(costs)) if (!Number.isSafeInteger(cost) || (cost as number) < 0) throw new MayuraError('INVALID_CONFIG', `stagehandTools(): costMicros.${tool} must be a non-negative whole number.`);
  if (options.stagehand !== undefined && typeof options.stagehand !== 'function') throw new MayuraError('INVALID_CONFIG', 'stagehandTools(): stagehand must be a class.');

  // One Stagehand per browser, made when a tool first needs it.
  const instances = new WeakMap<Browser, Promise<StagehandLike>>();
  const browserOf = async (context: { readonly runId: string; readonly scope: Scope; readonly signal: AbortSignal }): Promise<Browser> => {
    const browser = typeof source === 'function' ? await source(context) : source;
    if (!browser || typeof browser.goto !== 'function') throw new MayuraError('INVALID_CONFIG', 'The browser source gave no browser.');
    if (browser.ended) throw new MayuraError('INVALID_INPUT', 'The browser has ended.');
    return browser;
  };
  const stagehandFor = (browser: Browser): Promise<StagehandLike> => {
    let instance = instances.get(browser);
    if (!instance) {
      instance = (async () => {
        // Stagehand needs to reach this very browser; it would act on other pages of a shared one; its CDP connection
        // sends no headers.
        const cdp = browser.cdp;
        if (!cdp) throw new MayuraError('INVALID_CONFIG', `Stagehand cannot join the ${browser.provider} provider's browsers: each connection starts a browser of its own.`);
        if (cdp.isolated) throw new MayuraError('INVALID_CONFIG', 'Stagehand cannot be kept to a browser context of its own: use a browser that is this one\'s alone.');
        if (Object.keys(cdp.headers).length > 0) throw new MayuraError('INVALID_CONFIG', `Stagehand cannot connect to the ${browser.provider} provider's browsers, which need headers on their CDP connection.`);
        const Stagehand = options.stagehand ?? await loadStagehand();
        const stagehand = new Stagehand({
          env: 'LOCAL', localBrowserLaunchOptions: { cdpUrl: cdp.url },
          model: typeof model === 'string' ? model : { ...model },
          // Disconnect on close, never end the browser: its lifetime is Mayura's to keep.
          keepAlive: true, verbose: 0, disablePino: true, logger: () => undefined,
        });
        await stagehand.init();
        return stagehand;
      })();
      instance.catch(() => instances.delete(browser));
      instances.set(browser, instance);
    }
    return instance;
  };
  /** The Stagehand page showing the browser's active tab, when Stagehand can tell. */
  const activePage = async (browser: Browser, stagehand: StagehandLike, signal: AbortSignal): Promise<StagehandPageLike | undefined> => {
    const active = (await browser.tabs({ signal })).find(tab => tab.active);
    try { return active ? stagehand.context?.pages().find(page => page.url() === active.url) : undefined; } catch { return undefined; }
  };
  const tool = (id: 'act' | 'extract' | 'observe', permission: string, description: string,
    run: (stagehand: StagehandLike, instruction: string, call: { page?: StagehandPageLike; timeout: number }) => Promise<JsonObject>) =>
    defineTool({ id: `${name}.${id}`, version: '1', effects: id === 'act' ? 'write' : 'read', capabilities: [`stagehand:${name}:${permission}`], timeoutMs: timeoutMs + 30_000,
      costMicros: costs[id] ?? 0, description, input: instructionInput, output: anything, inputJsonSchema: instructionSchema,
      execute: async (request: { instruction: string }, context: { readonly runId: string; readonly scope: Scope; readonly signal: AbortSignal }) => {
        const browser = await browserOf(context);
        const stagehand = await stagehandFor(browser);
        const page = await activePage(browser, stagehand, context.signal);
        return run(stagehand, request.instruction, { ...(page ? { page } : {}), timeout: timeoutMs });
      } } as never) as unknown as AnyTool;

  const tools: AnyTool[] = [
    tool('extract', 'read', 'Read what the page open in the browser says about something, by an instruction such as "the price of the first product", as text, using Stagehand.',
      async (stagehand, instruction, call) => {
        const result = await stagehand.extract(instruction, undefined, call);
        const text = clip(typeof result?.extraction === 'string' ? result.extraction : JSON.stringify(result ?? null), maxResultBytes);
        return { extraction: text.text, ...(text.truncated ? { truncated: true } : {}) } as JsonObject;
      }),
    tool('observe', 'read', 'Find what can be done on the page open in the browser for an instruction, such as "the search box", using Stagehand: the matching elements and actions.',
      async (stagehand, instruction, call) => {
        const found = await stagehand.observe(instruction, call);
        const actions = (Array.isArray(found) ? found : []).slice(0, 50).map(item => {
          const action = item as { description?: unknown; method?: unknown; selector?: unknown };
          return { description: typeof action?.description === 'string' ? action.description.slice(0, 500) : '', ...(typeof action?.method === 'string' ? { method: action.method } : {}) };
        });
        return { actions } as unknown as JsonObject;
      }),
  ];
  if (options.act) {
    tools.push(tool('act', 'act', 'Do what an instruction says on the page open in the browser, such as "click the sign in button" or "type mayura into the search box", using Stagehand.',
      async (stagehand, instruction, call) => {
        const result = await stagehand.act(instruction, call);
        return { success: result?.success === true, message: clip(typeof result?.message === 'string' ? result.message : '', 4_096).text,
          ...(typeof result?.actionDescription === 'string' ? { action: result.actionDescription.slice(0, 1_000) } : {}) } as JsonObject;
      }));
  }
  return tools;
}
