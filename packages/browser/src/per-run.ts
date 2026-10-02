import { MayuraError, type Scope } from '@mayura/core';
import type { Browser, Browsers } from './browsers.js';
import type { BrowserSource } from './tools.js';

export interface BrowserPerRun {
  /** Give this to `browserTools`: the run's browser, opened the first time a tool needs it. */
  readonly source: BrowserSource;
  /** Releases the run's browser, if it has one. Call it when the run ends, from an `onFinally` hook. */
  release(runId: string): Promise<void>;
  /** Runs that have a browser now. */
  readonly runs: readonly string[];
}

type Spec = { readonly lifetimeMs?: number; readonly labels?: Readonly<Record<string, string>> };

/**
 * One browser per run: opened when a tool of the run first needs it, and released by `release(runId)`. Release it when
 * the run ends:
 *
 * ```ts
 * defineHook({ id: 'browser.release', version: '1', stage: 'onFinally', handler: (_event, context) => perRun.release(context.runId) })
 * ```
 *
 * A browser not released ends with its lifetime; a tool that needs it after that gets an error.
 */
export function browserPerRun(browsers: Browsers, options: Spec | ((context: { readonly runId: string; readonly scope: Scope }) => Spec) = {}): BrowserPerRun {
  if (!browsers || typeof browsers.open !== 'function') throw new MayuraError('INVALID_CONFIG', 'browserPerRun() needs browsers from createBrowsers().');
  if (typeof options !== 'function' && (!options || typeof options !== 'object')) throw new MayuraError('INVALID_CONFIG', 'browserPerRun() needs the options to open each browser with.');
  const byRun = new Map<string, Promise<Browser>>();
  return Object.freeze({
    source: async (context: { readonly runId: string; readonly scope: Scope; readonly signal: AbortSignal }) => {
      let browser = byRun.get(context.runId);
      if (!browser) {
        const spec = typeof options === 'function' ? options({ runId: context.runId, scope: context.scope }) : options;
        // Not tied to the first caller's signal: the browser outlives the call that opened it.
        const opened = browsers.open({ ...spec });
        browser = opened;
        byRun.set(context.runId, opened);
        opened.catch(() => { if (byRun.get(context.runId) === opened) byRun.delete(context.runId); });
      }
      const item = await browser;
      if (item.ended) throw new MayuraError('INVALID_INPUT', 'The run\'s browser has ended.');
      return item;
    },
    release: async (runId: string) => {
      const browser = byRun.get(runId);
      if (!browser) return;
      byRun.delete(runId);
      const item = await browser.catch(() => undefined);
      await item?.release();
    },
    get runs() { return Object.freeze([...byRun.keys()]); },
  });
}
