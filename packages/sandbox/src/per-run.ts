import { MayuraError, type Scope } from '@mayura/core';
import type { CreateSandboxOptions, Sandbox, Sandboxes } from './sandboxes.js';
import type { SandboxSource } from './tools.js';

export interface SandboxPerRun {
  /** Give this to `sandboxTools`: the run's sandbox, created the first time a tool needs it. */
  readonly source: SandboxSource;
  /** Releases the run's sandbox, if it has one. Call it when the run ends, from an `onFinally` hook. */
  release(runId: string): Promise<void>;
  /** Runs that have a sandbox now. */
  readonly runs: readonly string[];
}

type Spec = Omit<CreateSandboxOptions, 'signal'>;

/**
 * One sandbox per run: created when a tool of the run first needs it, with `options` (or what `options` returns for
 * the run), and released by `release(runId)`. Release it when the run ends:
 *
 * ```ts
 * defineHook({ id: 'sandbox.release', version: '1', stage: 'onFinally', handler: (_event, context) => perRun.release(context.runId) })
 * ```
 *
 * A sandbox not released ends with its lifetime; a tool that needs it after that gets an error.
 */
export function sandboxPerRun(sandboxes: Sandboxes, options: Spec | ((context: { readonly runId: string; readonly scope: Scope }) => Spec)): SandboxPerRun {
  if (!sandboxes || typeof sandboxes.create !== 'function') throw new MayuraError('INVALID_CONFIG', 'sandboxPerRun() needs sandboxes from createSandboxes().');
  if (typeof options !== 'function' && (!options || typeof options !== 'object')) throw new MayuraError('INVALID_CONFIG', 'sandboxPerRun() needs the options to create each sandbox with.');
  const byRun = new Map<string, Promise<Sandbox>>();
  return Object.freeze({
    source: async (context: { readonly runId: string; readonly scope: Scope; readonly signal: AbortSignal }) => {
      let sandbox = byRun.get(context.runId);
      if (!sandbox) {
        const spec = typeof options === 'function' ? options({ runId: context.runId, scope: context.scope }) : options;
        // Not tied to the first caller's signal: the sandbox outlives the call that created it.
        const created = sandboxes.create({ ...spec });
        sandbox = created;
        byRun.set(context.runId, created);
        created.catch(() => { if (byRun.get(context.runId) === created) byRun.delete(context.runId); });
      }
      const item = await sandbox;
      if (item.ended) throw new MayuraError('INVALID_INPUT', 'The run\'s sandbox has ended.');
      return item;
    },
    release: async (runId: string) => {
      const sandbox = byRun.get(runId);
      if (!sandbox) return;
      byRun.delete(runId);
      const item = await sandbox.catch(() => undefined);
      await item?.release();
    },
    get runs() { return Object.freeze([...byRun.keys()]); },
  });
}
