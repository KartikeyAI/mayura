import type { ArtifactReference, ArtifactScope, LocalArtifactStore } from '@mayura/artifacts';
import { createRuntime, defineTool, type AgentDefinition, type InferInput, type InferOutput, type RuntimeLimits, type Schema,
  type ToolExecutionContext } from '@mayura/sdk';
import { defineWorkflowLifecycle, type WorkflowLifecycleNode } from '@mayura/workflows/lifecycle';
import { z } from 'zod';
import { MAX_RESEARCHERS, type ModelSettings } from './config.js';
import { libraryTools, sourceId, type SourceLibrary } from './library/index.js';
import { finding, plannerAgent, question, researcherAgent, subQuestion, writerAgent } from './team.js';
import type { StepSpan, Telemetry } from './telemetry.js';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
/** Research runs are named by 64 hex characters, derived from the caller's request id. */
export const runId = z.string().regex(/^[a-f0-9]{64}$/u);
/** The longest report this starter stores and relays, in characters. */
export const MAX_REPORT_CHARS = 24_000;

/** What starts a research run. The request id is the caller's idempotency key: one request id, one run. */
export const researchRequest = z.strictObject({ requestId: identifier, question });
export type ResearchRequest = z.infer<typeof researchRequest>;

const slot = z.strictObject({ question, subQuestion: subQuestion.nullable() });
const planStepOutput = z.strictObject({ question, subQuestions: z.array(subQuestion).min(1).max(MAX_RESEARCHERS), slots: z.array(slot).length(MAX_RESEARCHERS) });
const researchStepOutput = z.strictObject({ question, subQuestion: subQuestion.nullable(), findings: z.array(finding).max(8) });
export const citation = z.strictObject({ sourceId, title: z.string().max(200) });
const writeStepOutput = z.strictObject({ question, title: z.string().min(1).max(200), markdown: z.string().min(1).max(MAX_REPORT_CHARS),
  citations: z.array(citation).min(1).max(16) });
const artifactReference = z.strictObject({ format: z.literal('mayura-artifact-v1'), scopeDigest: sha256, referenceDigest: sha256, digest: sha256,
  bytes: z.number().int().min(1), mediaType: z.string().max(128), classification: z.enum(['public', 'internal', 'confidential', 'restricted']),
  filename: z.string().max(512).optional(), expiresAt: z.number().int().optional() });
/** A finished research run: the report lives in the artifact store, addressed by its content digest. */
export const researchResult = z.strictObject({ question, title: z.string().max(200), citations: z.array(citation).max(16), artifact: artifactReference });
export type ResearchResult = z.infer<typeof researchResult>;

export interface ResearchDependencies {
  readonly model: ModelSettings;
  readonly library: SourceLibrary;
  readonly artifacts: LocalArtifactStore;
  readonly artifactScope: ArtifactScope;
  /** The most one agent step may spend. It is also what the run budget reserves for (and charges to) each step. */
  readonly stepCostMicros: number;
  readonly telemetry: Telemetry;
}

/** Research slot node ids, `research-1` .. `research-N`. */
export const researchSlots = Array.from({ length: MAX_RESEARCHERS }, (_, index) => `research-${index + 1}`);

/**
 * The research workflow: plan → up to N researchers in parallel → gather → write → store.
 *
 * It is a lifecycle workflow (format 5): a finite graph whose tool steps are journaled before they run, whose sibling
 * steps run in parallel, and whose run record carries ONE cost budget (`maxCostMicros` in services.ts) shared by every
 * step. Before a step runs, the runtime reserves that step's `costMicros` from the run's remaining budget in the same
 * write that claims the step; if the budget cannot cover it, the step is `blocked` (code BUDGET_EXCEEDED), every
 * later step is skipped, and the run ends `blocked`. No report is written for a blocked run.
 *
 * The graph is static, so it has one node per possible researcher. When the planner uses fewer sub-questions the
 * spare slots finish at once without calling a model; they are still admitted and charged at their ceiling (see
 * README "Know the limits").
 */
export function researchWorkflows(dependencies: ResearchDependencies) {
  const { library, telemetry } = dependencies; const ceiling = dependencies.stepCostMicros;
  const planner = plannerAgent(dependencies.model);
  const writer = writerAgent(dependencies.model);

  const plan = defineTool({
    id: 'research.plan', version: '1', effects: 'none', capabilities: ['research:plan'], costMicros: ceiling, timeoutMs: stepTimeoutMs,
    description: 'Run the planner agent: split the research question into sub-questions, one per research slot.',
    input: researchRequest, output: planStepOutput,
    execute: (request, context) => traced(telemetry, context, 'research.plan', async span => {
      const planned = await runAgent(planner, { question: request.question, maxSubQuestions: MAX_RESEARCHERS },
        { context, span, ceiling, limits: { maxSteps: 2, maxModelCalls: 2, maxToolCalls: 1 } });
      const subQuestions = [...new Set(planned.subQuestions)].slice(0, MAX_RESEARCHERS);
      return { question: request.question, subQuestions,
        slots: researchSlots.map((_, index) => ({ question: request.question, subQuestion: subQuestions[index] ?? null })) };
    }),
  });

  const investigate = defineTool({
    id: 'research.investigate', version: '1', effects: 'none', capabilities: ['research:investigate'], costMicros: ceiling, timeoutMs: stepTimeoutMs,
    description: 'Run one researcher agent on one sub-question over the source library, returning cited findings.',
    input: slot, output: researchStepOutput,
    execute: async (assignment, context) => {
      if (assignment.subQuestion === null) {
        // A spare slot: nothing to research. It reports zero usage, but the run budget still charges its ceiling.
        context.reportUsage({ knownCostMicros: 0, unknownCostMicros: 0 });
        return { question: assignment.question, subQuestion: null, findings: [] };
      }
      const asked = assignment.subQuestion;
      return traced(telemetry, context, 'research.investigate', async span => {
        // Fresh tool instances per step record which documents this researcher actually read.
        const read = new Set<string>();
        const tools = libraryTools(library, id => read.add(id));
        const researcher = researcherAgent(dependencies.model, tools.tools);
        const found = await runAgent({ ...researcher, permissions: [...researcher.permissions, ...tools.permissions] },
          { question: assignment.question, subQuestion: asked }, { context, span, ceiling, limits: { maxSteps: 6, maxModelCalls: 5, maxToolCalls: 8 } });
        // Trust, then verify: a finding may cite only documents this researcher read through library.read.
        if (found.findings.some(item => item.sourceIds.some(id => !read.has(id)))) throw new Error('A finding cites a document its researcher did not read.');
        return { question: assignment.question, subQuestion: asked, findings: found.findings };
      });
    },
  });

  const write = defineTool({
    id: 'research.write', version: '1', effects: 'none', capabilities: ['research:write'], costMicros: ceiling, timeoutMs: stepTimeoutMs,
    description: 'Run the writer agent over every researcher\'s findings and render the cited report.',
    input: z.array(researchStepOutput).length(MAX_RESEARCHERS), output: writeStepOutput,
    execute: (research, context) => traced(telemetry, context, 'research.write', async span => {
      const asked = research[0]!.question;
      const sections = research.flatMap(item => item.subQuestion === null ? [] : [{ subQuestion: item.subQuestion, findings: item.findings }]);
      const reported = new Set(sections.flatMap(section => section.findings.flatMap(item => item.sourceIds)));
      if (reported.size === 0) throw new Error('No researcher found a source for any sub-question; there is nothing to report.');
      const draft = await runAgent(writer, { question: asked, sections }, { context, span, ceiling, limits: { maxSteps: 2, maxModelCalls: 2, maxToolCalls: 1 } });
      // The writer may only cite what researchers reported, and every citation must resolve in the library.
      const cited = [...new Set(draft.sections.flatMap(section => section.sourceIds))];
      if (cited.some(id => !reported.has(id))) throw new Error('The writer cited a source no researcher reported.');
      const citations = [];
      for (const id of cited) {
        const document = await library.read(id);
        if (!document) throw new Error('A cited source is not in the library.');
        citations.push({ sourceId: id, title: document.title.slice(0, 200), published: document.published });
      }
      const markdown = [
        `# ${draft.title}`, '', `_Question:_ ${asked}`, '', draft.summary, '',
        ...draft.sections.flatMap(section => [`## ${section.heading}`, '', section.body, '', `Sources: ${section.sourceIds.map(id => `[${id}]`).join(', ')}`, '']),
        '## Sources', '', ...citations.map(item => `- **${item.sourceId}**: ${item.title} (${item.published})`), '',
      ].join('\n');
      if (markdown.length > MAX_REPORT_CHARS) throw new Error('The report is longer than this starter stores.');
      return { question: asked, title: draft.title, markdown, citations: citations.map(({ sourceId: id, title }) => ({ sourceId: id, title })) };
    }),
  });

  const store = defineTool({
    id: 'research.store', version: '1', effects: 'write', capabilities: ['artifacts:write'],
    description: 'Store the finished report in the content-addressed artifact store.',
    input: writeStepOutput, output: researchResult,
    execute: (report, context) => traced(telemetry, context, 'research.store', async () => {
      // Content-addressed: the same report bytes always get the same digest, so a repeated store is harmless.
      const staged = await dependencies.artifacts.stage({ scope: dependencies.artifactScope, content: new TextEncoder().encode(report.markdown),
        mediaType: 'text/markdown', classification: 'internal', filename: 'research-report.md' });
      const artifact = await dependencies.artifacts.commit(staged);
      return { question: report.question, title: report.title, citations: report.citations, artifact };
    }),
  });

  const nodes: WorkflowLifecycleNode[] = [
    { kind: 'tool', id: 'plan', tool: plan, input: { kind: 'input', path: [] } },
    // Every slot depends only on the plan, so the runtime dispatches them together in one wave.
    ...researchSlots.map((id, index): WorkflowLifecycleNode =>
      ({ kind: 'tool', id, tool: investigate, input: { kind: 'step', stepId: 'plan', path: ['slots', String(index)] }, dependsOn: ['plan'] })),
    // A join's output is the list of its dependencies' outputs, in order: the writer's input.
    { kind: 'join', id: 'gather', dependsOn: researchSlots },
    { kind: 'tool', id: 'write', tool: write, input: { kind: 'step', stepId: 'gather', path: [] }, dependsOn: ['gather'] },
    { kind: 'tool', id: 'store', tool: store, input: { kind: 'step', stepId: 'write', path: [] }, dependsOn: ['write'] },
  ];
  const latest = defineWorkflowLifecycle({ id: 'research.run', version: '1', input: researchRequest, output: researchResult, nodes,
    result: { kind: 'step', stepId: 'store', path: [] } });

  return {
    /** New runs start here. */
    latest,
    /** Every version that may still have runs in flight. Add, never edit, when you change the workflow. */
    definitions: [latest],
    /** What the workflow runtime must allow: each step tool, each capability it declares, and the write effect. */
    permissions: ['tool:research.plan', 'tool:research.investigate', 'tool:research.write', 'tool:research.store',
      'research:plan', 'research:investigate', 'research:write', 'artifacts:write', 'effect:write'],
  } as const;
}

// ---- Running an agent inside a step ------------------------------------------------------------------------------------

/** A step may run a little longer than its agent, so a timed-out agent is reported by the agent runtime first. */
const agentDurationMs = 120_000;
const stepTimeoutMs = agentDurationMs + 15_000;

/**
 * Agent steps are `effects: 'none'`: they read the library and ask a model, and change nothing outside the run, so a
 * failure is a plain failure rather than an uncertain external effect. Their spending is still bounded: the agent
 * runs with `maxCostMicros` = the step ceiling, and the step reports what it actually spent.
 */
async function runAgent<I extends Schema, O extends Schema>(
  setup: { readonly agent: AgentDefinition<I, O>; readonly permissions: readonly string[] },
  input: InferInput<I>,
  options: { readonly context: ToolExecutionContext; readonly span: StepSpan; readonly ceiling: number; readonly limits: RuntimeLimits },
): Promise<InferOutput<O>> {
  const { context } = options;
  const runtime = createRuntime({ profile: 'ephemeral', scope: context.scope, permissions: { allow: [...setup.permissions] },
    limits: { ...options.limits, maxDurationMs: agentDurationMs, maxCostMicros: options.ceiling } });
  try {
    const handle = runtime.submit(setup.agent, { input });
    options.span.watch(handle);
    const stop = (): void => handle.cancel();
    context.signal.addEventListener('abort', stop, { once: true });
    try {
      const outcome = await handle.result();
      const spent = runtime.inspect(handle).budget.spentMicros;
      context.reportUsage({ knownCostMicros: typeof spent === 'number' ? Math.min(spent, options.ceiling) : options.ceiling, unknownCostMicros: 0 });
      if (outcome.status !== 'succeeded') throw new Error(`The ${setup.agent.id} agent ended ${outcome.status}.`);
      return outcome.output;
    } finally { context.signal.removeEventListener('abort', stop); }
  } finally { await runtime.close(); }
}

async function traced<T>(telemetry: Telemetry, context: ToolExecutionContext, name: string, work: (span: StepSpan) => Promise<T>): Promise<T> {
  const span = telemetry.step(context.runId, name);
  try { const result = await work(span); await span.end('ok'); return result; }
  catch (error) { await span.end('error'); throw error; }
}

/** Used by the desk's report tool: the stored reference as the artifact store expects it. */
export const asArtifactReference = (value: ResearchResult['artifact']): ArtifactReference => value as ArtifactReference;
