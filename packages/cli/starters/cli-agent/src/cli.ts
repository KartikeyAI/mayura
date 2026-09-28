#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createRuntime } from 'mayura';
import { createSkillSet, loadSkills, type SkillSet } from 'mayura/skills';
import { agentCommandHelp, runAgentCommand, runTerminalChat } from 'mayura/terminal';
import { workspaceAssistant } from './assistant.js';
import { loadConfig } from './config.js';

// The `assistant` command:
//   assistant chat                 an interactive chat (the reply streams with a real model; writes are confirmed)
//   assistant <request>            one request, answered once: `assistant list files in src`
//   assistant --json <request>     the same, as JSON for scripts: { status, output, spentMicros }
//   echo "<request>" | assistant   the request from standard input
// Exit code 0 when the request succeeded, 1 otherwise.

export interface MainOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  /** Streams instead of the process's own (tests use these). */
  readonly io?: {
    readonly stdin?: Readable & { isTTY?: boolean }; readonly stdout?: Writable & { isTTY?: boolean }; readonly stderr?: Writable;
    readonly input?: Readable; readonly output?: Writable;
  };
}

const usage = [
  'Usage: assistant chat           chat with the assistant about this folder',
  '       assistant <request>      answer one request, then exit',
  '',
];

export async function main(argv: readonly string[], options: MainOptions = {}): Promise<number> {
  const stderr = options.io?.stderr ?? process.stderr;
  let config;
  try { config = await loadConfig(options.env ?? process.env, options.cwd ?? process.cwd()); }
  catch (error) { stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
  // A missing skills folder just means no skills; a broken one is an error worth seeing.
  const skills: SkillSet = existsSync(config.skillsDirectory) ? await loadSkills(config.skillsDirectory) : createSkillSet([]);
  const { agent, permissions } = workspaceAssistant({ root: config.root, skills, model: config.model });
  const runtime = createRuntime({
    profile: 'ephemeral',
    permissions: { allow: permissions },
    // A turn may wait for the person to confirm a write, so it gets minutes, not the default minute.
    limits: { maxCostMicros: config.maxRunCostMicros, maxSteps: 12, maxToolCalls: 24, maxDurationMs: 15 * 60_000 },
  });
  try {
    if (argv[0] === 'chat') {
      const io = options.io?.input && options.io.output ? { input: options.io.input, output: options.io.output } : undefined;
      await runTerminalChat({ agent, runtime, title: `Assistant in ${config.root}`, ...(io ? { io } : {}) });
      return 0;
    }
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
      // The request's own options, without their usage line (ours above covers it).
      const requestHelp = agentCommandHelp('assistant').split('\n').slice(1).join('\n').trimStart();
      (options.io?.stdout ?? process.stdout).write(`${usage.join('\n')}${requestHelp}\n`);
      return 0;
    }
    const io = options.io ? { ...(options.io.stdin ? { stdin: options.io.stdin } : {}), ...(options.io.stdout ? { stdout: options.io.stdout } : {}), stderr } : undefined;
    return await runAgentCommand({ agent, runtime, name: 'assistant', argv, ...(io ? { io } : {}) });
  } finally {
    await runtime.close();
  }
}

// Run as a command (not when a test imports this file). The project's .env is loaded first; real variables win.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  process.exitCode = await main(process.argv.slice(2));
}
