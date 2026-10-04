// Live check of @mayurajs/observability-langsmith: one agent run's spans sent to LangSmith's OTLP JSON ingestion.
// Run after pnpm build: node --env-file=.env.live scripts/live/observability-langsmith.mjs  (needs LANGSMITH_API_KEY)
// Prints only the outcome and the exporter's counters; never the key or LangSmith's reply text.
import { agentRunTraceSpans } from '../../packages/exporter-otlp/dist/index.js';
import { langSmithTraceExporter } from '../../extensions/observability-langsmith/dist/index.js';

const apiKey = process.env.LANGSMITH_API_KEY;
if (!apiKey) { console.log('LANGSMITH_API_KEY is not set; nothing run.'); process.exit(2); }
const now = Date.now(); const at = offset => new Date(now - 5_000 + offset * 1_000).toISOString();
const runId = `mayura-live-${now}`;
const event = (sequence, type, metadata) => ({ runId, sequence, timestamp: at(sequence), type, metadata });
const spans = agentRunTraceSpans([
  event(1, 'run.started', { profile: 'ephemeral', agentId: 'mayura-live-check' }), event(2, 'model.started', { step: 0, modelCall: 1, modelId: 'openai/gpt-test' }),
  event(3, 'model.completed', { step: 0, response: 'final', costMicros: 1, inputTokens: 12, outputTokens: 3 }),
  event(4, 'run.completed', { status: 'succeeded', spentMicros: 1, reservedMicros: 0, calls: 1 }),
]);
const exporter = langSmithTraceExporter({ apiKey, project: 'mayura-live-check', serviceName: 'mayura-live-check' });
try {
  await exporter.sink(spans, { signal: AbortSignal.timeout(20_000) });
  console.log(`  run ${runId}, ${JSON.stringify(exporter.inspect().metrics)}`);
  console.log("PASS LangSmith accepts an agent run's spans");
} catch (error) {
  console.log(`  ${JSON.stringify(exporter.inspect().metrics)}`);
  console.log(`FAIL LangSmith accepts an agent run's spans (${error?.code ?? 'error'})`);
  process.exitCode = 1;
}
