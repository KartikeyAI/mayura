// Terminal front ends for agents: an interactive chat (`runTerminalChat`) and one-shot commands whose flags come from
// the agent's input (`runAgentCommand`). A person at the terminal can confirm actions before they run
// (`confirmBeforeRunning`) and answer the agent's questions (`askPersonTool`); with nobody there, both refuse.
import { readFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { MayuraError, publicError, type InferInput, type InferOutput, type JsonObject, type JsonValue, type Schema } from '@mayura/core';
import type { AgentDefinition, Runtime } from '@mayura/runtime';
import { defineTool, ToolRefusal, withPreflight, type AnyTool } from '@mayura/tools';

/** Someone at the terminal, for the run currently in a chat turn or command. */
interface Person {
  confirm(title: string, detail: string): Promise<boolean>;
  ask(question: string): Promise<string | undefined>;
}
// Tools find the person for their run by the run id the runtime passes them; a run with nobody registered is refused.
const people = new Map<string, Person>();

/**
 * The same tool, but a person at the terminal sees its input and confirms before it runs. Declining, or running with
 * nobody at a terminal (for example on a server), refuses the call before any effect.
 */
export function confirmBeforeRunning<T extends AnyTool>(tool: T, options: { readonly describe?: (input: InferOutput<T['input']>) => string;
  readonly waitMs?: number } = {}): T {
  return withPreflight(tool, async (input, context) => {
    const person = people.get(context.runId);
    if (!person) throw new ToolRefusal(`${tool.id} needs a person to confirm it, and nobody is available.`);
    const detail = options.describe ? options.describe(input) : JSON.stringify(input, null, 2);
    if (!await person.confirm(`Allow ${tool.id}?`, detail)) throw new ToolRefusal(`The person declined ${tool.id}.`);
  }, { extraTimeoutMs: options.waitMs ?? 600_000, description: `${tool.description} (A person confirms each call.)` });
}

const questionInput: Schema<{ question: string }> = { '~standard': { version: 1, vendor: 'mayura-terminal', validate: value => {
  const record = value as Record<string, unknown> | null;
  return record && typeof record === 'object' && !Array.isArray(record) && Object.keys(record).length === 1 && typeof record['question'] === 'string'
    && record['question'].length > 0 && record['question'].length <= 2_000 ? { value: { question: record['question'] } } : { issues: [{ message: 'Expected { question }.' }] };
} } } as Schema<{ question: string }>;
const anyOutput: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'mayura-terminal', validate: value => ({ value: value as JsonValue }) } } as Schema<JsonValue>;
/** A tool the agent calls to ask the person at the terminal a question. Grant `tool:person.ask` and `person:ask`. */
export const askPersonTool = defineTool({ id: 'person.ask', version: '1', effects: 'none', capabilities: ['person:ask'], costMicros: 0, timeoutMs: 600_000,
  description: 'Ask the person you are working with a question, when you cannot continue without their answer. Ask one clear question at a time.',
  input: questionInput, output: anyOutput,
  inputJsonSchema: { type: 'object', additionalProperties: false, required: ['question'], properties: { question: { type: 'string', description: 'The question to ask.' } } },
  execute: async ({ question }, context) => {
    const person = people.get(context.runId); if (!person) throw new ToolRefusal('Nobody is available to answer questions.');
    const answer = await person.ask(question); if (answer === undefined) throw new ToolRefusal('The person did not answer.');
    return { answer };
  } });

/** Plain text for a person from an agent's output: a string, or its reply/message/text/answer field, or JSON. */
export function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    for (const field of ['reply', 'message', 'text', 'answer', 'content', 'response']) {
      const value = (output as Record<string, unknown>)[field]; if (typeof value === 'string') return value;
    }
  }
  return JSON.stringify(output, null, 2);
}
const dollars = (micros: number): string => `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 6 : 4)}`;
const spent = (runtime: Runtime, handle: Parameters<Runtime['inspect']>[0]): number => {
  try { const value = runtime.inspect(handle).budget.spentMicros; return typeof value === 'number' ? value : Number(value) || 0; } catch { return 0; }
};

export interface ChatTurn { readonly role: 'person' | 'agent'; readonly text: string }

/**
 * The default chat input: the message alone for the first turn, and afterwards the last 20 turns as a transcript
 * followed by the new message, so an agent that takes text remembers the conversation.
 */
export function chatTranscript(message: string, history: readonly ChatTurn[]): string {
  if (history.length === 0) return message;
  const earlier = history.slice(-20).map(turn => `${turn.role === 'person' ? 'Person' : 'You'}: ${turn.text}`).join('\n');
  return `The conversation so far:\n${earlier}\n\nThe person's new message:\n${message}`;
}

/** Whether a streamed preview differs from the final answer, which then has to be shown in full. */
const differs = (streamed: string, final: string): boolean => streamed.trim() !== final.trim();
export interface TerminalChatOptions<I extends Schema, O extends Schema> {
  readonly agent: AgentDefinition<I, O>;
  readonly runtime: Runtime;
  /**
   * The agent's input for a message; `history` holds the earlier turns. The default (`chatTranscript`) passes the
   * message text, with the recent conversation before it after the first turn.
   */
  readonly toInput?: (message: string, history: readonly ChatTurn[]) => InferInput<I>;
  /** What to show for the agent's output; the default is `outputText`. */
  readonly toText?: (output: InferOutput<O>) => string;
  readonly title?: string;
  /** Streams to prompt on; the process's terminal by default. */
  readonly io?: { readonly input?: Readable; readonly output?: Writable };
}

/** Run an interactive chat with an agent until the person types /exit (or presses Ctrl+C at the prompt). */
export async function runTerminalChat<I extends Schema, O extends Schema>(options: TerminalChatOptions<I, O>): Promise<{ readonly turns: number; readonly spentMicros: number }> {
  const prompts = await import('@clack/prompts'); const io = options.io ?? {}; const out = io.output ?? process.stdout;
  const toText = options.toText ?? (value => outputText(value)); const toInput = options.toInput ?? ((message: string, earlier: readonly ChatTurn[]) => chatTranscript(message, earlier) as InferInput<I>);
  const history: ChatTurn[] = []; let turns = 0; let total = 0;
  prompts.intro(options.title ?? ` ${options.agent.id} `, io);
  prompts.log.message('Type a message. /help lists commands.', io);
  for (;;) {
    const message = await prompts.text({ ...io, message: 'You', placeholder: 'Ask something, or /exit' });
    if (prompts.isCancel(message) || message.trim() === '/exit' || message.trim() === '/quit') break;
    const text = message.trim(); if (!text) continue;
    if (text === '/help') { prompts.log.message('/clear  forget the conversation\n/cost   spend so far\n/exit   leave', io); continue; }
    if (text === '/clear') { history.length = 0; prompts.log.success('Started a new conversation.', io); continue; }
    if (text === '/cost') { prompts.log.message(`Spent ${dollars(total)} over ${turns} turn${turns === 1 ? '' : 's'}.`, io); continue; }
    let handle: ReturnType<Runtime['submit']>;
    try { handle = options.runtime.submit(options.agent, { input: toInput(text, history) }); }
    catch (error) { const failure = publicError(error, 'INVALID_INPUT'); prompts.log.error(`${failure.message} (${failure.code})`, io); continue; }
    const spinner = prompts.spinner(io.output ? { output: io.output } : {}); let spinning = true; let streamed = false; let preview = ''; let withheld = false; spinner.start('Thinking');
    const pause = (): void => { if (spinning) { spinner.stop(); spinning = false; } };
    const resume = (label: string): void => { if (!spinning && !streamed) { spinner.start(label); spinning = true; } };
    people.set(handle.id, {
      confirm: async (title, detail) => { pause(); prompts.note(detail, title, io); const answer = await prompts.confirm({ ...io, message: 'Allow it?', initialValue: false });
        resume('Working'); return !prompts.isCancel(answer) && answer === true; },
      ask: async question => { pause(); const answer = await prompts.text({ ...io, message: question }); resume('Thinking');
        return prompts.isCancel(answer) ? undefined : answer; },
    });
    const watching = (async () => {
      for await (const event of handle.observe()) {
        if (event.type === 'tool.started' && !streamed) { if (spinning) spinner.message(`Using ${String(event.metadata['toolId'])}`); }
        else if (event.type === 'output.delta') {
          if (!streamed) { pause(); streamed = true; out.write('\n'); }
          const text = String(event.metadata['text'] ?? ''); preview += text; out.write(text);
        } else if (event.type === 'output.withheld') withheld = true;
      }
    })().catch(() => {});
    const outcome = await handle.result(); await watching; people.delete(handle.id); pause();
    const cost = spent(options.runtime, handle); total += cost; turns += 1;
    if (streamed) out.write('\n\n');
    if (outcome.status === 'succeeded') {
      const reply = toText(outcome.output as InferOutput<O>);
      if (!streamed) prompts.log.message(reply, { ...io, symbol: '◆' });
      // A guard stopped the stream, or the output schema changed the answer (for example redacted it): show the final
      // answer, which is the one that counts.
      else if (withheld || differs(preview, reply)) prompts.log.message(reply, { ...io, symbol: '◆' });
      if (cost > 0) prompts.log.message(`${dollars(cost)} this turn`, io);
      history.push({ role: 'person', text }, { role: 'agent', text: reply });
    } else prompts.log.error(`${outcome.error.message} (${outcome.status})`, io);
  }
  prompts.outro(turns > 0 ? `${turns} turn${turns === 1 ? '' : 's'}, ${dollars(total)} spent.` : 'Bye.', io);
  return { turns, spentMicros: total };
}

export interface AgentCommandOptions<I extends Schema, O extends Schema> {
  readonly agent: AgentDefinition<I, O>;
  readonly runtime: Runtime;
  /** The command's name in its help; the default is the agent id. */
  readonly name?: string;
  /** Arguments after the command; the default is `process.argv.slice(2)`. */
  readonly argv?: readonly string[];
  /**
   * The agent input's JSON Schema: its top-level properties become flags, and `--help` lists them. The default is the
   * agent's own input schema, when its validator can describe itself (Zod 4.2 and later).
   */
  readonly inputJsonSchema?: JsonObject;
  readonly toText?: (output: InferOutput<O>) => string;
  readonly io?: { readonly stdin?: Readable & { isTTY?: boolean }; readonly stdout?: Writable & { isTTY?: boolean }; readonly stderr?: Writable };
}

type Property = { readonly type?: string; readonly description?: string };
/** Usage text for a command: flags from the schema, or free text. */
export function agentCommandHelp(name: string, schema?: JsonObject): string {
  const properties = (schema?.['properties'] ?? {}) as Record<string, Property>; const required = new Set((schema?.['required'] ?? []) as string[]);
  const flags = Object.entries(properties).filter(([, property]) => ['string', 'number', 'integer', 'boolean'].includes(String(property.type)));
  return [
    `Usage: ${name} ${flags.length ? '[options]' : '<text>'}`, '',
    ...(flags.length ? ['Options:', ...flags.map(([key, property]) => `  --${key}${property.type === 'boolean' ? '' : ` <${property.type}>`}${required.has(key) ? ' (required)' : ''}${property.description ? `  ${property.description}` : ''}`), ''] : []),
    'Input:', '  --input <json>       the whole input as JSON', '  --input-file <path>  read it from a JSON file', '  (or pipe text to stdin)', '',
    'Output:', '  --json               print {"status", "output", "spentMicros"}', '  --help, -h           show this help',
  ].join('\n');
}

/** Parse the command line into the agent's input. */
export async function parseAgentCommand(argv: readonly string[], schema?: JsonObject, stdin?: Readable & { isTTY?: boolean }):
  Promise<{ readonly help: boolean; readonly json: boolean; readonly input: unknown }> {
  const properties = (schema?.['properties'] ?? {}) as Record<string, Property>; const values: Record<string, JsonValue> = {}; const words: string[] = [];
  let json = false; let help = false; let whole: unknown; let hasWhole = false;
  const fail = (message: string): never => { throw new MayuraError('INVALID_INPUT', message); };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--help' || argument === '-h') { help = true; continue; }
    if (argument === '--json') { json = true; continue; }
    if (argument === '--input' || argument === '--input-file') {
      const value = argv[++index]; if (value === undefined) fail(`${argument} needs a value.`);
      try { whole = JSON.parse(argument === '--input' ? value! : await readFile(value!, 'utf8')); } catch { fail(`${argument} must be valid JSON.`); }
      hasWhole = true; continue;
    }
    if (argument.startsWith('--')) {
      const raw = argument.slice(2); const negated = raw.startsWith('no-') && properties[raw.slice(3)]?.type === 'boolean';
      const key = negated ? raw.slice(3) : raw; const property = properties[key]; if (!property) fail(`Unknown option ${argument}. Run with --help.`);
      if (property!.type === 'boolean') { values[key] = !negated; continue; }
      const value = argv[++index]; if (value === undefined) fail(`${argument} needs a value.`);
      if (property!.type === 'number' || property!.type === 'integer') {
        const number = Number(value); if (!Number.isFinite(number) || (property!.type === 'integer' && !Number.isInteger(number))) fail(`${argument} must be a ${property!.type}.`);
        values[key] = number;
      } else values[key] = value!;
      continue;
    }
    words.push(argument);
  }
  if (help) return { help, json, input: undefined };
  if (hasWhole) { if (Object.keys(values).length || words.length) fail('Use --input on its own.'); return { help, json, input: whole }; }
  if (Object.keys(values).length) { if (words.length) fail(`Unexpected ${words[0]}; pass values with their --option.`); return { help, json, input: values }; }
  if (words.length) return { help, json, input: words.join(' ') };
  if (stdin && !stdin.isTTY) {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of stdin) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); size += bytes.byteLength; if (size > 1_048_576) fail('Standard input is larger than 1 MiB.'); chunks.push(bytes); }
    const text = Buffer.concat(chunks).toString('utf8').trim(); if (text) return { help, json, input: text };
  }
  return fail('No input. Pass text, options, --input or pipe it in; run with --help.');
}

/** Run an agent once from the command line. Returns the exit code: 0 when it succeeded, 1 otherwise. */
export async function runAgentCommand<I extends Schema, O extends Schema>(options: AgentCommandOptions<I, O>): Promise<number> {
  const io = options.io ?? {}; const stdout = io.stdout ?? process.stdout; const stderr = io.stderr ?? process.stderr;
  const name = options.name ?? options.agent.id; const toText = options.toText ?? (value => outputText(value));
  // Flags come from the given schema, or from the agent's own input when its validator can describe itself.
  const schema = options.inputJsonSchema ?? options.agent.inputJsonSchema;
  let parsed: Awaited<ReturnType<typeof parseAgentCommand>>;
  try { parsed = await parseAgentCommand(options.argv ?? process.argv.slice(2), schema, io.stdin ?? process.stdin); }
  catch (error) { stderr.write(`${publicError(error, 'INVALID_INPUT').message}\n`); return 1; }
  if (parsed.help) { stdout.write(`${agentCommandHelp(name, schema)}\n`); return 0; }
  const human = !parsed.json && stdout.isTTY === true; let handle: ReturnType<Runtime['submit']>;
  try { handle = options.runtime.submit(options.agent, { input: parsed.input as InferInput<I> }); }
  catch (error) { const failure = publicError(error, 'INVALID_INPUT'); stderr.write(parsed.json ? `${JSON.stringify({ status: 'failed', error: failure })}\n` : `${failure.message}\n`); return 1; }
  // Confirmations and questions need someone at a terminal; piped or scheduled runs refuse them.
  const stdinTTY = (io.stdin ?? process.stdin).isTTY === true;
  if (stdinTTY) {
    const prompts = await import('@clack/prompts');
    people.set(handle.id, {
      confirm: async (title, detail) => { prompts.note(detail, title); const answer = await prompts.confirm({ message: 'Allow it?', initialValue: false }); return !prompts.isCancel(answer) && answer === true; },
      ask: async question => { const answer = await prompts.text({ message: question }); return prompts.isCancel(answer) ? undefined : answer; },
    });
  }
  let streamed = false; let preview = '';
  const watching = (async () => {
    for await (const event of handle.observe()) {
      if (human && event.type === 'output.delta') { const text = String(event.metadata['text'] ?? ''); streamed = true; preview += text; stdout.write(text); }
      else if (human && event.type === 'tool.started') stderr.write(`· ${String(event.metadata['toolId'])}\n`);
    }
  })().catch(() => {});
  const outcome = await handle.result(); await watching; people.delete(handle.id);
  const cost = spent(options.runtime, handle);
  if (parsed.json) {
    const document = outcome.status === 'succeeded' ? { status: outcome.status, output: outcome.output, spentMicros: cost } : { status: outcome.status, error: outcome.error, spentMicros: cost };
    stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  } else if (outcome.status === 'succeeded') {
    const reply = toText(outcome.output as InferOutput<O>);
    // The streamed text is a preview: when the final answer differs (a guard or the output schema changed it), print it.
    stdout.write(!streamed ? `${reply}\n` : differs(preview, reply) ? `\n${reply}\n` : '\n');
  }
  else stderr.write(`${outcome.error.message} (${outcome.status})\n`);
  return outcome.status === 'succeeded' ? 0 : 1;
}
