import type { ArtifactReference, ArtifactScope, LocalArtifactStore } from 'mayura/artifacts';
import { defineTool, type RunHandle, type ToolExecutionContext, z } from 'mayura';
import { agentStep, defineWorkflowLifecycle, fanOut, type WorkflowLifecycleNode } from 'mayura/workflows/lifecycle';
import { MAX_RESEARCHERS, type ModelSettings } from './config.js';
import { libraryTools, sourceId, type SourceLibrary } from './library/index.js';
import { finding, plannerAgent, question, researcherAgent, subQuestion, writerAgent } from './team.js';
import type { Telemetry } from './telemetry.js';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
/** Research runs are named by 64 hex characters, derived from the caller's request id. */
export const runId = z.string().regex(/^[a-f0-9]{64}$/u);
/** The longest report this starter stores and relays, in characters. */
export const MAX_REPORT_CHARS = 24_000;

/** What starts a research run. The request id is the caller's idempotency key: one request id, one run. */
export const researchRequest = z.strictObject({ requestId: identifier, question });
export type ResearchRequest = z.infer<typeof researchRequest>;

const assignment = z.strictObject({ question, subQuestion });
const planStepOutput = z.strictObject({ question, assignments: z.array(assignment).min(1).max(MAX_RESEARCHERS) });
const researchStepOutput = z.strictObject({ question, subQuestion, findings: z.array(finding).max(8) });
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

/** Research slot node ids, `research.1` .. `research.N` (made by `fanOut`); `research` is the join that gathers them. */
export const researchSlots = Array.from({ length: MAX_RESEARCHERS }, (_, index) => `research.${index + 1}`);

/**
 * The research workflow: plan → one researcher per sub-question, in parallel → write → store.
 *
 * It is a lifecycle workflow (format 5): a finite graph whose tool steps are journaled before they run, whose sibling
 * steps run in parallel, and whose run record carries ONE cost budget (`maxCostMicros` in services.ts) shared by every
 * step. Before a step runs, the runtime reserves that step's `costMicros` from the run's remaining budget in the same
 * write that claims the step; if the budget cannot cover it, the step is `blocked` (code BUDGET_EXCEEDED), every
 * later step is skipped, and the run ends `blocked`. No report is written for a blocked run.
 *
 * `fanOut` gives the graph one slot per possible researcher. A slot runs only when the plan has an assignment for it;
 * the others are bypassed, so they are never admitted and reserve nothing from the budget.
 */
export function researchWorkflows(dependencies: ResearchDependencies) {
  const { library, telemetry } = dependencies; const ceiling = dependencies.stepCostMicros;
  const planner = plannerAgent(dependencies.model);
  const writer = writerAgent(dependencies.model);

  // Each agent step runs its agent in the run's scope with its own grants and limits (agentStep), and charges the run
  // what the agent spent. The agent's spans nest under the step's span in the research run's trace.
  const traced = (run: RunHandle<unknown>, context: ToolExecutionContext) => { const watch = telemetry.watch(context, run); return () => watch.end(); };
  const limits = (bounds: { readonly maxSteps: number; readonly maxModelCalls: number; readonly maxToolCalls: number }) =>
    ({ ...bounds, maxDurationMs: agentDurationMs, maxCostMicros: ceiling });

  const plan = agentStep(planner.agent, {
    id: 'research.plan', version: '1', capabilities: ['research:plan'], timeoutMs: stepTimeoutMs,
    description: 'Run the planner agent: split the research question into sub-questions, one per research slot.',
    input: researchRequest, output: planStepOutput, permissions: planner.permissions,
    limits: limits({ maxSteps: 2, maxModelCalls: 2, maxToolCalls: 0 }), onRun: traced,
    prepare: request => ({ question: request.question, maxSubQuestions: MAX_RESEARCHERS }),
    finish: (planned, request) => {
      const subQuestions = [...new Set(planned.subQuestions)].slice(0, MAX_RESEARCHERS);
      return { question: request.question, assignments: subQuestions.map(item => ({ question: request.question, subQuestion: item })) };
    },
  });

  // Each researcher gets fresh library tools, which record the documents it actually read.
  const reads = new WeakMap<ToolExecutionContext, Set<string>>();
  const libraryGrants = libraryTools(library).permissions;
  const investigate = agentStep((_task: z.infer<typeof assignment>, context: ToolExecutionContext) => {
    const read = new Set<string>(); reads.set(context, read);
    return researcherAgent(dependencies.model, libraryTools(library, id => read.add(id)).tools).agent;
  }, {
    id: 'research.investigate', version: '1', capabilities: ['research:investigate'], timeoutMs: stepTimeoutMs, effects: 'read',
    description: 'Run one researcher agent on one sub-question over the source library, returning cited findings.',
    input: assignment, output: researchStepOutput, permissions: [...researcherAgent(dependencies.model, []).permissions, ...libraryGrants],
    limits: limits({ maxSteps: 6, maxModelCalls: 5, maxToolCalls: 8 }), onRun: traced,
    prepare: task => ({ question: task.question, subQuestion: task.subQuestion }),
    finish: (found, task, context) => {
      // Trust, then verify: a finding may cite only documents this researcher read through library.read.
      const read = reads.get(context) ?? new Set<string>();
      if (found.findings.some(item => item.sourceIds.some(id => !read.has(id)))) throw new Error('A finding cites a document its researcher did not read.');
      return { question: task.question, subQuestion: task.subQuestion, findings: found.findings };
    },
  });

  const write = agentStep(writer.agent, {
    id: 'research.write', version: '1', capabilities: ['research:write'], timeoutMs: stepTimeoutMs,
    description: 'Run the writer agent over every researcher\'s findings and render the cited report.',
    // The join's output: one entry per slot, `null` for a slot the plan did not use.
    input: z.array(researchStepOutput.nullable()).length(MAX_RESEARCHERS), output: writeStepOutput, permissions: writer.permissions,
    limits: limits({ maxSteps: 2, maxModelCalls: 2, maxToolCalls: 0 }), onRun: traced,
    prepare: slots => {
      const research = slots.filter(item => item !== null);
      const asked = research[0]?.question ?? (() => { throw new Error('No researcher ran.'); })();
      const sections = research.map(item => ({ subQuestion: item.subQuestion, findings: item.findings }));
      const reported = new Set(sections.flatMap(section => section.findings.flatMap(item => item.sourceIds)));
      if (reported.size === 0) throw new Error('No researcher found a source for any sub-question; there is nothing to report.');
      return { question: asked, sections };
    },
    finish: async (draft, slots) => {
      const research = slots.filter(item => item !== null);
      const asked = research[0]!.question;
      const reported = new Set(research.flatMap(item => item.findings.flatMap(finding => finding.sourceIds)));
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
    },
  });

  const store = defineTool({
    id: 'research.store', version: '1', effects: 'write', capabilities: ['artifacts:write'],
    description: 'Store the finished report in the content-addressed artifact store.',
    input: writeStepOutput, output: researchResult,
    execute: async report => {
      // Content-addressed: the same report bytes always get the same digest, so a repeated store is harmless.
      const staged = await dependencies.artifacts.stage({ scope: dependencies.artifactScope, content: new TextEncoder().encode(report.markdown),
        mediaType: 'text/markdown', classification: 'internal', filename: 'research-report.md' });
      const artifact = await dependencies.artifacts.commit(staged);
      return { question: report.question, title: report.title, citations: report.citations, artifact };
    },
  });

  const nodes: WorkflowLifecycleNode[] = [
    { kind: 'tool', id: 'plan', tool: plan, input: { kind: 'input', path: [] } },
    // Slot n runs `investigate` on the plan's assignment n, all in one wave; a slot with no assignment is bypassed.
    // The join `research` then lists every slot's output in order (null for a bypassed slot): the writer's input.
    ...fanOut({ id: 'research', items: { stepId: 'plan', path: ['assignments'] }, max: MAX_RESEARCHERS, tool: investigate }),
    { kind: 'tool', id: 'write', tool: write, input: { kind: 'step', stepId: 'research', path: [] }, dependsOn: ['research'] },
    { kind: 'tool', id: 'store', tool: store, input: { kind: 'step', stepId: 'write', path: [] }, dependsOn: ['write'] },
  ];
  const latest = defineWorkflowLifecycle({ id: 'research.run', version: '1', input: researchRequest, output: researchResult, nodes,
    result: { kind: 'step', stepId: 'store', path: [] } });

  return {
    /** New runs start here. */
    latest,
    /** Every version that may still have runs in flight. Add, never edit, when you change the workflow. */
    definitions: [latest],
    /**
     * What the workflow runtime must allow: each step tool, each capability it declares, the researchers' read effect
     * (their library tools read) and the store's write effect.
     */
    permissions: ['tool:research.plan', 'tool:research.investigate', 'tool:research.write', 'tool:research.store',
      'research:plan', 'research:investigate', 'research:write', 'artifacts:write', 'effect:read', 'effect:write'],
  } as const;
}

// ---- Agent step bounds ---------------------------------------------------------------------------------------------------

/** A step may run a little longer than its agent, so a timed-out agent is reported by the agent runtime first. */
const agentDurationMs = 120_000;
const stepTimeoutMs = agentDurationMs + 15_000;

/** Used by the desk's report tool: the stored reference as the artifact store expects it. */
export const asArtifactReference = (value: ResearchResult['artifact']): ArtifactReference => value as ArtifactReference;
