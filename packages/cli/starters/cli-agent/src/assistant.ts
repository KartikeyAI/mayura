import { defineAgent, type AgentDefinition, z } from 'mayura';
import type { JsonValue, ModelAdapter, ModelRequest, ModelResponse } from 'mayura/core';
import { withSkills, type SkillSet } from 'mayura/skills';
import { askPersonTool } from 'mayura/terminal';
import type { ModelSettings } from './config.js';
import { modelPermission, selectModel } from './model.js';
import { workspaceTools } from './workspace.js';

export const assistantId = 'workspace.assistant';

// The agent's input is plain text: one request, or (in the chat) the recent conversation followed by the new message.
export const assistantInput = z.string().min(1).max(100_000);
export const assistantOutput = z.strictObject({ reply: z.string().min(1).max(8_000) });

export interface AssistantOptions {
  readonly root: string;
  readonly skills: SkillSet;
  readonly model: ModelSettings;
  /** Replaces the configured model entirely (tests use it to script a model). */
  readonly modelOverride?: ModelAdapter;
}

export interface Assistant {
  readonly agent: AgentDefinition<typeof assistantInput, typeof assistantOutput>;
  /** Everything the runtime must grant for this agent: its model, its tools, their capabilities and effects. */
  readonly permissions: readonly string[];
}

export function workspaceAssistant(options: AssistantOptions): Assistant {
  const files = workspaceTools(options.root);
  const model = options.modelOverride ?? selectModel(options.model, offlineAssistant());
  // With a model that can see, `assistant --attach shot.png "what is wrong here?"` sends the file along.
  const sees = model.capabilities.media?.types ?? [];
  const agent = defineAgent(withSkills(options.skills, {
    id: assistantId, version: '1', input: assistantInput, output: assistantOutput, model,
    ...(sees.length > 0 ? { media: { accept: sees, maxItems: 8 } } : {}),
    tools: [...files.tools, askPersonTool],
    // Real models stream the reply as they write it; the offline stand-in answers in one piece.
    stream: { field: ['reply'], guards: [] },
    instructions: [
      'You are a helpful assistant working in a terminal, in the person\'s project folder (the workspace).',
      'Look before you answer: list, read and search files instead of guessing what they contain.',
      'Write a file only when the person asks you to. The person confirms every write; if they decline, do not try again.',
      'If the request is ambiguous and you cannot continue, ask the person one clear question with person.ask.',
      'You cannot open .env files, .git or node_modules, and you cannot leave the workspace folder.',
      'When the person attaches images or PDFs, look at them to answer.',
      'Reply in plain text, briefly. Mention the files you used.',
    ].join('\n'),
  }));
  const permissions = [modelPermission(model), ...files.permissions, 'tool:person.ask', 'person:ask', ...options.skills.permissions];
  return { agent, permissions: [...new Set(permissions)] };
}

// ---- Offline stand-in -----------------------------------------------------------------------------------------------
// RULE-BASED AND DETERMINISTIC, NOT A LANGUAGE MODEL. It recognises a few phrasings, calls the same tools a real model
// would, and writes the reply from the tool result. It exists so the starter runs and tests without a network or key.

type Call = { readonly toolId: string; readonly input: JsonValue };

/** The newest message: the chat sends earlier turns first, then "The person's new message:". */
function newestMessage(request: ModelRequest): string {
  const first = request.messages[0]; const text = first && first.role === 'user' && typeof first.content === 'string' ? first.content : '';
  const marker = 'The person\'s new message:\n'; const at = text.lastIndexOf(marker);
  return (at < 0 ? text : text.slice(at + marker.length)).trim();
}

function plan(message: string): Call | string {
  const text = message.trim();
  let match = /^(?:write|create|save)\s+(\S+)\s*(?::|with)\s*([\s\S]+)$/iu.exec(text);
  if (match) return { toolId: 'files.write', input: { path: match[1]!, content: `${match[2]!.trim()}\n` } };
  match = /^(?:read|open|show|cat)\s+(\S*\.\S+)$/iu.exec(text);
  if (match) return { toolId: 'files.read', input: { path: match[1]! } };
  match = /^(?:search|find|grep)\s+(?:for\s+)?"?(.+?)"?$/iu.exec(text);
  if (match) return { toolId: 'files.search', input: { query: match[1]! } };
  match = /^(?:list|ls|show)\b(?:\s+(?:the\s+)?files?)?(?:\s+in)?(?:\s+(\S+))?$/iu.exec(text);
  if (match) return { toolId: 'files.list', input: { path: match[1] ?? '.' } };
  if (/release notes/iu.test(text)) return { toolId: 'skills.load', input: { name: 'release-notes' } };
  return [
    'I am running offline, without a language model, so I only understand a few requests:',
    '  list files [in <folder>]    read <file>    search <text>    write <file>: <text>',
    '  how do I write release notes?   (loads the release-notes skill)',
    'Set MAYURA_MODEL_PROVIDER in .env to use a real model (see README.md).',
  ].join('\n');
}

/** The reply for a tool result. */
function reply(toolId: string, result: Record<string, unknown>): string {
  if (result['found'] === false || result['written'] === false) return `I could not do that: ${String(result['reason'])}`;
  if (toolId === 'files.list') {
    const entries = result['entries'] as { name: string; kind: string; bytes: number | null }[];
    if (entries.length === 0) return `${String(result['path'])} is empty.`;
    return [`In ${String(result['path'])}:`, ...entries.map(entry => entry.kind === 'folder' ? `  ${entry.name}/` : `  ${entry.name} (${entry.bytes} bytes)`),
      ...(result['truncated'] ? ['  (and more)'] : [])].join('\n');
  }
  if (toolId === 'files.read') {
    const content = String(result['content']);
    return `${String(result['path'])}:\n\n${content.slice(0, 6_000)}${content.length > 6_000 || result['truncated'] ? '\n…' : ''}`;
  }
  if (toolId === 'files.search') {
    const matches = result['matches'] as { path: string; line: number; text: string }[];
    if (matches.length === 0) return `Nothing in the workspace contains "${String(result['query'])}".`;
    return [`Found "${String(result['query'])}" in:`, ...matches.slice(0, 20).map(item => `  ${item.path}:${item.line}  ${item.text}`)].join('\n');
  }
  if (toolId === 'files.write') return `${result['created'] ? 'Created' : 'Replaced'} ${String(result['path'])} (${String(result['bytes'])} bytes).`;
  if (toolId === 'skills.load') {
    return `From the ${String(result['name'])} skill:\n\n${String(result['instructions']).trim().slice(0, 6_000)}`;
  }
  return JSON.stringify(result);
}

export function offlineAssistant(): ModelAdapter {
  const answer = (text: string): ModelResponse => ({ type: 'final', output: { reply: text }, usage: { costMicros: 0 } });
  return {
    id: 'offline.assistant', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0,
    async generate(request) {
      const last = request.messages.at(-1);
      // After a tool ran, answer from its result.
      if (last && last.role === 'tool') return answer(reply(last.toolId, (last.result ?? {}) as Record<string, unknown>));
      const next = plan(newestMessage(request));
      if (typeof next === 'string') return answer(next);
      return { type: 'tool_calls', calls: [{ id: `offline-${request.messages.length}`, ...next }], usage: { costMicros: 0 } };
    },
  };
}
