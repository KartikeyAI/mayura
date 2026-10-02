import { spawn } from 'node:child_process';
import { defineTool, MayuraError, type AnyTool, type JsonObject, type Schema, type Scope } from 'mayura';
import type { Browser, BrowserSource } from 'mayura/browser';

export interface AgentBrowserToolsOptions {
  /** Names the tools (`<name>.read`, ...) and their permissions (`agent-browser:<name>:read`, ...); `agent` by default. */
  readonly name?: string;
  /** The agent-browser command line, as program and arguments; `['agent-browser']` (on the PATH) by default. */
  readonly cli?: readonly string[];
  /** Make `<name>.act`, which clicks, fills, types and presses on the page; permission `agent-browser:<name>:act`. Off by default. */
  readonly act?: boolean;
  /** Make `<name>.eval`, which runs JavaScript in the page; permission `agent-browser:<name>:evaluate`. Off by default. */
  readonly evaluate?: boolean;
  /** The longest one command may take; 60 s by default. */
  readonly timeoutMs?: number;
  /** The most bytes of a command's result returned to the model; 64 KiB by default. */
  readonly maxResultBytes?: number;
}

/** Each command a tool runs, with how many arguments it takes, and the flags allowed. */
const readCommands: Readonly<Record<string, { readonly min: number; readonly max: number; readonly flags?: readonly string[] }>> = {
  snapshot: { min: 0, max: 0, flags: ['-i', '-c', '-d', '-s'] },
  get: { min: 1, max: 3 },
  is: { min: 2, max: 2 },
};
const actCommands: Readonly<Record<string, { readonly min: number; readonly max: number }>> = {
  click: { min: 1, max: 1 }, dblclick: { min: 1, max: 1 }, fill: { min: 2, max: 2 }, type: { min: 2, max: 2 }, press: { min: 1, max: 1 },
  hover: { min: 1, max: 1 }, focus: { min: 1, max: 1 }, check: { min: 1, max: 1 }, uncheck: { min: 1, max: 1 }, select: { min: 2, max: 6 },
  scroll: { min: 1, max: 2 }, scrollintoview: { min: 1, max: 1 }, wait: { min: 1, max: 1 },
};
const getWhat = ['text', 'html', 'value', 'attr', 'title', 'url', 'count', 'box'];
const isWhat = ['visible', 'enabled', 'checked'];
const flagsWithValue = new Set(['-d', '-s']);

/** The arguments for one command, checked; a refusal names what is wrong, for the model to put right. */
function commandArgs(command: string, args: readonly string[], allowed: Readonly<Record<string, { readonly min: number; readonly max: number; readonly flags?: readonly string[] }>>): string[] {
  const rule = allowed[command]!; // the input schema admits only the listed commands
  if (!Array.isArray(args) || args.length > 10 || args.some(arg => typeof arg !== 'string' || arg.length > 4_096 || arg.includes('\u0000'))) throw new MayuraError('INVALID_INPUT', 'args are at most 10 strings.');
  const positional: string[] = []; const flags: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith('-')) {
      // Only the flags a command is listed with; anything else could point agent-browser elsewhere.
      if (!rule.flags?.includes(arg)) throw new MayuraError('INVALID_INPUT', `${arg} is not allowed${rule.flags ? `; ${command} takes ${rule.flags.join(', ')}` : ''}. Arguments may not start with -.`);
      flags.push(arg);
      if (flagsWithValue.has(arg)) { const value = args[++index]; if (value === undefined || value.startsWith('-')) throw new MayuraError('INVALID_INPUT', `${arg} needs a value.`); flags.push(value); }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length < rule.min || positional.length > rule.max) throw new MayuraError('INVALID_INPUT', `${command} takes ${rule.min === rule.max ? rule.min : `${rule.min} to ${rule.max}`} arguments.`);
  if (command === 'get' && !getWhat.includes(positional[0]!)) throw new MayuraError('INVALID_INPUT', `get takes one of ${getWhat.join(', ')}.`);
  if (command === 'is' && !isWhat.includes(positional[0]!)) throw new MayuraError('INVALID_INPUT', `is takes one of ${isWhat.join(', ')}.`);
  if (command === 'scroll' && !['up', 'down', 'left', 'right'].includes(positional[0]!)) throw new MayuraError('INVALID_INPUT', 'scroll takes up, down, left or right, and optionally pixels.');
  return [...positional, ...flags];
}

interface Ran { readonly code: number | null; readonly stdout: string }
/** Runs the CLI without a shell, keeping at most `max` bytes of what it prints. */
function runCli(command: readonly string[], args: readonly string[], timeoutMs: number, signal: AbortSignal, max: number): Promise<Ran> {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command[0]!, [...command.slice(1), ...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false }); }
    catch { reject(new MayuraError('INVALID_CONFIG', 'agent-browser could not be started.')); return; }
    const chunks: Buffer[] = []; let kept = 0; let settled = false;
    const stop = () => { child.kill(); };
    const timer = setTimeout(stop, timeoutMs);
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { if (kept < max) { chunks.push(chunk.subarray(0, max - kept)); kept += Math.min(chunk.byteLength, max - kept); } });
    child.on('error', error => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', stop);
      reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new MayuraError('INVALID_CONFIG', `agent-browser was not found at ${command[0]}; install it (npm install -g agent-browser), or give cli.`) : new MayuraError('TOOL_FAILED', 'agent-browser could not be started.'));
    });
    // On exit, not close: agent-browser leaves a daemon holding its output open. What it printed arrives by the end
    // of its output, or soon after it exits.
    child.on('exit', code => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', stop);
      const finish = () => {
        if (signal.aborted) reject(new MayuraError('CANCELLED', 'The command was cancelled.'));
        else resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
      };
      if (child.stdout.readableEnded) finish();
      else { const grace = setTimeout(finish, 500); child.stdout.once('end', () => { clearTimeout(grace); finish(); }); }
    });
  });
}

const anything: Schema<unknown> = { '~standard': { version: 1, vendor: 'mayura-agent-browser', validate: (value: unknown) => ({ value }) } } as Schema<unknown>;
const commandInput = (commands: readonly string[]): Schema<{ command: string; args?: string[] }> => ({ '~standard': { version: 1, vendor: 'mayura-agent-browser', validate: (value: unknown) => {
  const input = value as { command?: unknown; args?: unknown } | null;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'command' && key !== 'args')) return { issues: [{ message: 'Expected { command, args }.' }] };
  if (typeof input.command !== 'string' || !commands.includes(input.command)) return { issues: [{ message: `command is one of ${commands.join(', ')}.` }] };
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string'))) return { issues: [{ message: 'args are strings.' }] };
  return { value: input as { command: string; args?: string[] } };
} } } as Schema<{ command: string; args?: string[] }>);
const correctable = new Set(['INVALID_INPUT']);


/**
 * Vercel Labs' agent-browser as tools on a `mayura/browser` browser, the CLI driving it over its CDP endpoint:
 * `<name>.read` (snapshot, get, is) needs `agent-browser:<name>:read`; `<name>.act` (click, fill, type, press, ...)
 * and `<name>.eval` are off until enabled, each with its own permission. Navigation stays with the browser's own
 * `goto`, which keeps to its origins. Each browser gets an agent-browser session of its own, so refs from a snapshot
 * stay valid for the next command. Node only; the agent-browser command line must be installed.
 */
export function agentBrowserTools(source: BrowserSource, options: AgentBrowserToolsOptions = {}): AnyTool[] {
  if (typeof source !== 'function' && (!source || typeof source.goto !== 'function')) throw new MayuraError('INVALID_CONFIG', 'agentBrowserTools() needs a browser, or a function giving one.');
  const name = options.name ?? 'agent';
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(name)) throw new MayuraError('INVALID_CONFIG', 'agentBrowserTools(): name is lowercase letters, digits, _ and -, starting with a letter.');
  const cli = options.cli ?? ['agent-browser'];
  if (!Array.isArray(cli) || cli.length === 0 || cli.some(item => typeof item !== 'string' || item === '' || item.includes('\u0000'))) throw new MayuraError('INVALID_CONFIG', 'agentBrowserTools(): cli is the command line as program and arguments.');
  for (const flag of ['act', 'evaluate'] as const) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') throw new MayuraError('INVALID_CONFIG', `agentBrowserTools(): ${flag} must be a boolean.`);
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new MayuraError('INVALID_CONFIG', 'agentBrowserTools(): timeoutMs is 1,000 to 600,000.');
  const maxResultBytes = options.maxResultBytes ?? 65_536;
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1_024 || maxResultBytes > 4_194_304) throw new MayuraError('INVALID_CONFIG', 'agentBrowserTools(): maxResultBytes is 1,024 to 4,194,304.');

  // A session per browser; closed once its browser has ended.
  const sessions = new Map<Browser, string>();
  const closeEnded = () => {
    for (const [browser, session] of sessions) {
      if (!browser.ended) continue;
      sessions.delete(browser);
      void runCli(cli, ['--session', session, '--json', 'close'], 30_000, AbortSignal.timeout(30_000), 4_096).catch(() => undefined);
    }
  };
  const run = async (args: readonly string[], context: { readonly runId: string; readonly scope: Scope; readonly signal: AbortSignal }): Promise<JsonObject> => {
    closeEnded();
    const browser = typeof source === 'function' ? await source(context) : source;
    if (!browser || typeof browser.goto !== 'function') throw new MayuraError('INVALID_CONFIG', 'The browser source gave no browser.');
    if (browser.ended) throw new MayuraError('INVALID_INPUT', 'The browser has ended.');
    // agent-browser needs to reach this very browser; it would act on other pages of a shared one; it sends no headers
    // on its CDP connection.
    const cdp = browser.cdp;
    if (!cdp) throw new MayuraError('INVALID_CONFIG', `agent-browser cannot join the ${browser.provider} provider's browsers: each connection starts a browser of its own.`);
    if (cdp.isolated) throw new MayuraError('INVALID_CONFIG', 'agent-browser cannot be kept to a browser context of its own: use a browser that is this one\'s alone.');
    if (Object.keys(cdp.headers).length > 0) throw new MayuraError('INVALID_CONFIG', `agent-browser cannot connect to the ${browser.provider} provider's browsers, which need headers on their CDP connection.`);
    let session = sessions.get(browser);
    if (!session) { session = `mayura-${crypto.randomUUID()}`; sessions.set(browser, session); }
    // What agent-browser prints is read whole (up to 16 MiB) so its JSON parses; the result is bounded after.
    const ran = await runCli(cli, ['--cdp', cdp.url, '--session', session, '--json', ...args], timeoutMs, context.signal, 16 * 1_048_576);
    let reply: { success?: unknown; data?: unknown; error?: unknown };
    try { reply = JSON.parse(ran.stdout) as typeof reply; }
    catch { throw new MayuraError(ran.code === null ? 'TIMEOUT' : 'TOOL_FAILED', ran.code === null ? 'agent-browser did not answer in time.' : 'agent-browser did not answer in JSON.'); }
    // agent-browser's own report of what it did; its bookkeeping (lifecycle) is left out.
    const { lifecycle: _lifecycle, ...data } = (reply.data && typeof reply.data === 'object' && !Array.isArray(reply.data) ? reply.data : { value: reply.data ?? null }) as Record<string, unknown>;
    const result = reply.success === true ? { ok: true, ...data } : { ok: false, error: typeof reply.error === 'string' ? reply.error.slice(0, 1_000) : 'agent-browser did not succeed.' };
    const text = JSON.stringify(result);
    if (new TextEncoder().encode(text).byteLength > maxResultBytes) {
      const snapshot = typeof data['snapshot'] === 'string' ? data['snapshot'] : undefined;
      return snapshot !== undefined ? { ok: true, snapshot: snapshot.slice(0, Math.floor(maxResultBytes / 2)), truncated: true } : { ok: false, error: `The result is larger than ${maxResultBytes} bytes.` };
    }
    return result as JsonObject;
  };
  const tool = (id: string, permission: string, effects: 'read' | 'write', description: string, commands: Readonly<Record<string, { min: number; max: number; flags?: readonly string[] }>>) =>
    defineTool({ id: `${name}.${id}`, version: '1', effects, capabilities: [`agent-browser:${name}:${permission}`], timeoutMs: timeoutMs + 15_000, description,
      input: commandInput(Object.keys(commands)), output: anything,
      inputJsonSchema: { type: 'object', additionalProperties: false, required: ['command'], properties: {
        command: { type: 'string', enum: Object.keys(commands) }, args: { type: 'array', items: { type: 'string' }, maxItems: 10 } } } as unknown as JsonObject,
      execute: async (request: { command: string; args?: string[] }, context: { readonly runId: string; readonly scope: Scope; readonly signal: AbortSignal }) => {
        try { return await run([request.command, ...commandArgs(request.command, request.args ?? [], commands)], context); }
        catch (error) {
          // Mistakes the model can put right come back as the result, so it can try again.
          if (error instanceof MayuraError && correctable.has(error.code)) return { error: error.code, message: error.message } as JsonObject;
          throw error;
        }
      } } as never) as unknown as AnyTool;

  const tools: AnyTool[] = [
    tool('read', 'read', 'read', `Read the page open in the ${name} browser with agent-browser: snapshot (an outline whose @e refs the act tool takes; flags -i interactive only, -c compact, -d depth, -s selector), get text|html|value|attr <name>|title|url|count|box [@ref or selector], or is visible|enabled|checked <@ref or selector>.`, readCommands),
  ];
  if (options.act) {
    tools.push(tool('act', 'act', 'write', `Act on the page open in the ${name} browser with agent-browser, by @ref from a snapshot or a CSS selector: click, dblclick, fill <ref> <text>, type <ref> <text>, press <key>, hover, focus, check, uncheck, select <ref> <value>, scroll <up|down|left|right> [px], scrollintoview, wait <ref or ms>. Arguments may not start with -. To open a page, use the browser's goto.`, actCommands));
  }
  if (options.evaluate) {
    tools.push(tool('eval', 'evaluate', 'write', `Run a JavaScript expression in the page open in the ${name} browser with agent-browser, and get its value.`, { eval: { min: 1, max: 1 } }));
  }
  return tools;
}
