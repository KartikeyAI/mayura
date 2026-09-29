import type { AnyTool, JsonValue, ModelAdapter, ModelRequest, ModelResponse } from 'mayura';
import { defineAgent, z } from 'mayura';
import type { ModelSettings } from './config.js';
import { MAX_RESEARCHERS } from './config.js';
import { readOutput, sentences, sourceId, terms } from './library/index.js';
import { jsonSchema, modelPermission, selectModel } from './model.js';

// The three research agents. Each runs inside one durable workflow step (see workflow.ts), bounded by that step's
// limits and charged to the research run's shared budget. Each has a deterministic offline stand-in model.

export const question = z.string().min(8).max(500);
export const subQuestion = z.string().min(3).max(300);
export const finding = z.strictObject({ statement: z.string().min(1).max(600), sourceIds: z.array(sourceId).min(1).max(4) });

// ---- Planner -----------------------------------------------------------------------------------------------------------

export const plannerInput = z.strictObject({ question, maxSubQuestions: z.number().int().min(2).max(MAX_RESEARCHERS) });
export const plannerOutput = z.strictObject({ subQuestions: z.array(subQuestion).min(2).max(MAX_RESEARCHERS) });

export function plannerAgent(settings: ModelSettings) {
  const model = selectModel(settings, { outputJsonSchema: jsonSchema(plannerOutput), offline: offlinePlannerModel });
  const agent = defineAgent({
    id: 'research.planner', version: '1', input: plannerInput, output: plannerOutput, tools: [], model,
    instructions: [
      'You plan research for a question that will be answered only from a fixed source library.',
      'Split the question into between 2 and maxSubQuestions self-contained sub-questions that together answer it.',
      'Each sub-question must make sense on its own, name its subject, and be answerable by reading documents.',
      'Answer with the sub-questions only.',
    ].join('\n'),
  });
  return { agent, model, permissions: [modelPermission(model)] } as const;
}

// ---- Researcher --------------------------------------------------------------------------------------------------------

export const researcherInput = z.strictObject({ question, subQuestion });
export const researcherOutput = z.strictObject({ findings: z.array(finding).max(8) });

/** `tools` are the library tools; the calling step supplies instances that record what was actually read. */
export function researcherAgent(settings: ModelSettings, tools: readonly AnyTool[]) {
  const model = selectModel(settings, { outputJsonSchema: jsonSchema(researcherOutput), offline: offlineResearcherModel });
  const agent = defineAgent({
    id: 'research.researcher', version: '1', input: researcherInput, output: researcherOutput, tools: [...tools], model,
    instructions: [
      'You answer one sub-question of a larger research question using only the source library.',
      'Search the library, read the most relevant documents with library.read, then answer.',
      'Each finding is one factual statement supported by the documents you read, with the ids of those documents.',
      'Cite only ids that library.read returned to you. If the library does not answer the sub-question, return no findings.',
    ].join('\n'),
  });
  return { agent, model, permissions: [modelPermission(model)] } as const;
}

// ---- Writer ------------------------------------------------------------------------------------------------------------

export const writerInput = z.strictObject({
  question,
  sections: z.array(z.strictObject({ subQuestion, findings: z.array(finding).max(8) })).min(1).max(MAX_RESEARCHERS),
});
export const writerOutput = z.strictObject({
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(1_500),
  sections: z.array(z.strictObject({ heading: z.string().min(1).max(300), body: z.string().min(1).max(4_000),
    sourceIds: z.array(sourceId).min(1).max(8) })).min(1).max(MAX_RESEARCHERS),
});

export function writerAgent(settings: ModelSettings) {
  const model = selectModel(settings, { outputJsonSchema: jsonSchema(writerOutput), offline: offlineWriterModel });
  const agent = defineAgent({
    id: 'research.writer', version: '1', input: writerInput, output: writerOutput, tools: [], model,
    instructions: [
      'You write a short research report from findings gathered by researchers.',
      'Write a title, a summary of at most five sentences, and one section per sub-question.',
      'Use only the findings given. In each section, list the source ids of the findings it relies on; never add others.',
      'Where a sub-question has no findings, say plainly that the library did not answer it.',
    ].join('\n'),
  });
  return { agent, model, permissions: [modelPermission(model)] } as const;
}

// ---- Offline stand-ins -------------------------------------------------------------------------------------------------
// Rule-based and deterministic: the planner splits on punctuation and conjunctions, the researcher quotes the
// sentence the keyword search matched in each document it read, and the writer strings those quotes together. They
// demonstrate the protocol a real model follows (tool calls, citations, structured output); they are not inference
// and their "reports" are extracts, not analysis.

const userInput = (request: ModelRequest): unknown => { const first = request.messages[0]; return first?.role === 'user' ? first.content : undefined; };
const final = (output: JsonValue): ModelResponse => ({ type: 'final', output, usage: { costMicros: 0 } });

/** Clauses of the question become sub-questions; too few, and fixed angles are added; too many, and the tail merges. */
export function splitQuestion(text: string, maxSubQuestions: number): string[] {
  const tidy = (clause: string): string => {
    const words = clause.replace(/^(and|or|also|then)\s+/iu, '').replace(/[?.!\s]+$/u, '').trim();
    return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}?` : '';
  };
  const clauses: string[] = [];
  for (const raw of text.split(/[?;,]|\s+(?:and|or)\s+(?=(?:how|what|who|why|when|where|which|is|are|did|does|do|can)\b)/iu)) {
    const clause = tidy(raw);
    if (!clause) continue;
    // A fragment without a content word ("and why?") belongs to the clause before it.
    if (terms(clause).length === 0 && clauses.length > 0) clauses[clauses.length - 1] = `${clauses.at(-1)!.slice(0, -1)} ${clause}`;
    else clauses.push(clause);
  }
  const base = tidy(text) || 'The question?';
  for (const angle of ['What evidence and figures are reported', 'What risks or open problems are reported']) {
    if (clauses.length >= 2) break;
    clauses.push(`${angle} about: ${base.slice(0, -1)}?`.slice(0, 300));
  }
  while (clauses.length > maxSubQuestions) { const last = clauses.pop()!; clauses[clauses.length - 1] = `${clauses.at(-1)!.slice(0, -1)}, and ${last.charAt(0).toLowerCase()}${last.slice(1)}`; }
  return [...new Set(clauses.map(clause => clause.slice(0, 300)))];
}

export const offlinePlannerModel: ModelAdapter = {
  id: 'offline.research-planner',
  capabilities: { tools: true, structuredOutput: true },
  maxCostMicros: 0,
  async generate(request) {
    const input = plannerInput.parse(userInput(request));
    let subQuestions = splitQuestion(input.question, input.maxSubQuestions);
    if (subQuestions.length < 2) subQuestions = [...subQuestions, `What else does the library report about: ${input.question.slice(0, 250)}?`];
    return final({ subQuestions });
  },
};

const searchHits = z.strictObject({ hits: z.array(z.object({ id: sourceId, snippet: z.string() })) });

export const offlineResearcherModel: ModelAdapter = {
  id: 'offline.research-researcher',
  capabilities: { tools: true, structuredOutput: true },
  maxCostMicros: 0,
  async generate(request) {
    const input = researcherInput.parse(userInput(request));
    const results = request.messages.filter(message => message.role === 'tool');
    // 1. Search with the sub-question's words, leaving out names (capitalised words after the first): in a library
    //    about one place, the place's name does not tell documents apart.
    if (results.length === 0) {
      const query = input.subQuestion.split(/\s+/u).filter((word, index) => index === 0 || !/^[A-Z]/u.test(word)).join(' ');
      return { type: 'tool_calls', calls: [{ id: 'search-1', toolId: 'library.search', input: { query, limit: 3 } }], usage: { costMicros: 0 } };
    }
    const hits = searchHits.parse(results[0]!.result).hits.slice(0, 2);
    // 2. Read the two best hits (or finish with no findings when nothing matched).
    if (results.length === 1) {
      if (hits.length === 0) return final({ findings: [] });
      return { type: 'tool_calls', calls: hits.map((hit, index) => ({ id: `read-${index + 1}`, toolId: 'library.read', input: { id: hit.id } })), usage: { costMicros: 0 } };
    }
    // 3. Each document read contributes the sentence the search matched in it, quoted and cited.
    const documents = results.slice(1).map(result => readOutput.parse(result.result));
    const findings = documents.flatMap(document => {
      const snippet = hits.find(hit => hit.id === document.id)?.snippet ?? '';
      return snippet && sentences(document.text).includes(snippet) ? [{ statement: snippet, sourceIds: [document.id] }] : [];
    });
    return final({ findings });
  },
};

export const offlineWriterModel: ModelAdapter = {
  id: 'offline.research-writer',
  capabilities: { tools: true, structuredOutput: true },
  maxCostMicros: 0,
  async generate(request) {
    const input = writerInput.parse(userInput(request));
    const sections = input.sections.filter(section => section.findings.length > 0).map(section => ({
      heading: section.subQuestion,
      body: section.findings.map(item => `${item.statement} [${item.sourceIds.join(', ')}]`).join(' ').slice(0, 4_000),
      sourceIds: [...new Set(section.findings.flatMap(item => item.sourceIds))].slice(0, 8),
    }));
    const unanswered = input.sections.length - sections.length;
    const lead = sections.map(section => section.body.split(/(?<=\])\s/u)[0]).join(' ');
    const summary = `${lead}${unanswered > 0 ? ` The library did not answer ${unanswered} sub-question${unanswered === 1 ? '' : 's'}.` : ''}`.slice(0, 1_500);
    return final({ title: `Research brief: ${input.question}`.slice(0, 200), summary: summary || 'The library did not answer this question.', sections });
  },
};
