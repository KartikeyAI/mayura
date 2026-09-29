import type { ArtifactScope, LocalArtifactStore } from 'mayura/artifacts';
import { defineAgent, defineTool, MayuraError, type JsonValue, type ModelAdapter, type ModelResponse, z } from 'mayura';
import type { WorkflowLifecycleFleetRuntime } from 'mayura/workflows/lifecycle';
import type { ModelSettings } from './config.js';
import { jsonSchema, modelPermission, selectModel } from './model.js';
import { asArtifactReference, citation, MAX_REPORT_CHARS, researchRequest, researchResult, runId, type ResearchRequest } from './workflow.js';

// The research desk: the one agent callers talk to over HTTP. The Mayura server serves agents (and the operator API),
// not arbitrary routes, so starting research and fetching reports are the desk's two tools.

/** Start research (`requestId` + `question`), or ask for the report of a run (`runId`). */
export const deskInput = z.union([researchRequest, z.strictObject({ runId })]);
export type DeskInput = z.infer<typeof deskInput>;

const statuses = ['running', 'waiting', 'paused', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown', 'not_found'] as const;
/** Why an unfinished run stopped. `budget_exhausted`: the shared research budget could not admit the next step. */
const stopReasons = ['budget_exhausted', 'permission_denied', 'step_failed', 'cancelled', 'outcome_unknown'] as const;
export const deskOutput = z.strictObject({
  runId,
  status: z.enum(statuses),
  stopReason: z.enum(stopReasons).nullable(),
  title: z.string().max(200).nullable(),
  /** The Markdown report, read back from the artifact store; null until the run succeeds. */
  report: z.string().max(MAX_REPORT_CHARS).nullable(),
  artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).nullable(),
  citations: z.array(citation).max(16),
  budget: z.strictObject({ spentMicros: z.number().int().min(0), reservedMicros: z.number().int().min(0), maxCostMicros: z.number().int().min(0) }).nullable(),
});
export type DeskOutput = z.infer<typeof deskOutput>;

const startOutput = z.strictObject({ runId, status: z.enum(statuses) });

export interface DeskDependencies {
  readonly model: ModelSettings;
  /** Submit (or find) the durable research run for one request id. */
  readonly start: (request: ResearchRequest) => Promise<z.infer<typeof startOutput>>;
  /** The report of a run, or its status while it is unfinished. */
  readonly report: (runId: string) => Promise<DeskOutput>;
}

export function deskAgent(dependencies: DeskDependencies) {
  const start = defineTool({
    id: 'research.start', version: '1', effects: 'write', capabilities: ['research:start'],
    description: 'Start the durable research run for a request id and question. Idempotent: the same request id returns the same run.',
    input: researchRequest, inputJsonSchema: jsonSchema(researchRequest), output: startOutput,
    execute: request => dependencies.start(request),
  });
  const reportInput = z.strictObject({ runId });
  const report = defineTool({
    id: 'research.report', version: '1', effects: 'read', capabilities: ['research:read'],
    description: 'Return the finished report and its citations for a research run id, or the run\'s status if it is not finished.',
    input: reportInput, inputJsonSchema: jsonSchema(reportInput), output: deskOutput,
    execute: ({ runId: id }) => dependencies.report(id),
  });
  const model = selectModel(dependencies.model, { outputJsonSchema: jsonSchema(deskOutput), offline: offlineDeskModel });
  const agent = defineAgent({
    id: 'research.desk', version: '1', input: deskInput, output: deskOutput, tools: [start, report], model,
    instructions: [
      'You are the front desk of a research team.',
      'If the input has a requestId and a question, call research.start once with them unchanged, then answer with the runId and status it returned and every other field null or empty.',
      'If the input has a runId, call research.report once with it and answer with exactly what it returned.',
      'Never write, summarise or change a report yourself.',
    ].join('\n'),
  });
  return { agent, model, permissions: [modelPermission(model), 'tool:research.start', 'tool:research.report', 'research:start', 'research:read', 'effect:write', 'effect:read'] } as const;
}

/** Read a run's state and, once it succeeded, its report from the artifact store (the store re-verifies the digest). */
export async function describeRun(source: { readonly runtime: WorkflowLifecycleFleetRuntime; readonly artifacts: LocalArtifactStore; readonly artifactScope: ArtifactScope },
  id: string): Promise<DeskOutput> {
  const empty = { stopReason: null, title: null, report: null, artifactDigest: null, citations: [] };
  let snapshot;
  try { snapshot = await source.runtime.inspect(id); }
  catch (error) { if (error instanceof MayuraError && error.code === 'NOT_FOUND') return { runId: id, status: 'not_found', ...empty, budget: null }; throw error; }
  const budget = { spentMicros: snapshot.budget.spentMicros, reservedMicros: snapshot.budget.reservedMicros, maxCostMicros: snapshot.budget.maxCostMicros };
  if (snapshot.status === 'succeeded') {
    const result = researchResult.parse(snapshot.output);
    const bytes = await source.artifacts.read(asArtifactReference(result.artifact), source.artifactScope);
    return { runId: id, status: 'succeeded', stopReason: null, title: result.title, report: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      artifactDigest: result.artifact.digest, citations: result.citations, budget };
  }
  return { runId: id, status: snapshot.status, ...empty, stopReason: await stopReason(source.runtime, id, snapshot.status), budget };
}

async function stopReason(runtime: WorkflowLifecycleFleetRuntime, id: string, status: string): Promise<DeskOutput['stopReason']> {
  if (status === 'failed') return 'step_failed';
  if (status === 'cancelled' || status === 'outcome_unknown') return status;
  if (status !== 'blocked') return null;
  // A blocked step's reason is in the run's journal: BUDGET_EXCEEDED (the shared budget) or PERMISSION_DENIED.
  let after = 0;
  for (let page = 0; page < 4; page++) {
    const events = await runtime.events(id, after);
    const blocked = events.find(event => event.type === 'lifecycle.step.blocked');
    if (blocked) return blocked.data['code'] === 'BUDGET_EXCEEDED' ? 'budget_exhausted' : 'permission_denied';
    if (events.length === 0) break;
    after = events.at(-1)!.sequence;
  }
  return 'permission_denied';
}

// ---- Offline stand-in ------------------------------------------------------------------------------------------------
// Rule-based and deterministic: a question means research.start, a run id means research.report, and the answer is
// the tool's result. It shows the tool-call protocol a real model follows; it is not inference.

export const offlineDeskModel: ModelAdapter = {
  id: 'offline.research-desk',
  capabilities: { tools: true, structuredOutput: true },
  maxCostMicros: 0,
  async generate(request): Promise<ModelResponse> {
    const first = request.messages[0];
    const input = deskInput.parse(first?.role === 'user' ? first.content : undefined);
    const result = request.messages.find(message => message.role === 'tool');
    if (!result) {
      return 'runId' in input
        ? { type: 'tool_calls', calls: [{ id: 'report-1', toolId: 'research.report', input: { runId: input.runId } }], usage: { costMicros: 0 } }
        : { type: 'tool_calls', calls: [{ id: 'start-1', toolId: 'research.start', input: { requestId: input.requestId, question: input.question } }], usage: { costMicros: 0 } };
    }
    if (result.toolId === 'research.report') return { type: 'final', output: result.result, usage: { costMicros: 0 } };
    const started = startOutput.parse(result.result);
    const output: DeskOutput = { ...started, stopReason: null, title: null, report: null, artifactDigest: null, citations: [], budget: null };
    return { type: 'final', output: output as JsonValue, usage: { costMicros: 0 } };
  },
};
